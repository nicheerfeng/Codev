import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, opendirSync, mkdtempSync, rmSync, appendFileSync, statSync, openSync, closeSync, readSync, writeSync, fstatSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validId } from './common.mjs';

/** 单一 broker 写入的持久索引和邮箱，不保存第二份 transcript。 */
export class Store {
  /** 建立独立数据目录。 */
  constructor(root) {
    this.root = root;
    this.mailboxRoot = join(root, 'mailboxes');
    this.mailboxReady = false;
    for (const sub of ['sessions', 'messages']) mkdirSync(join(root, sub), { recursive: true, mode: 0o700 });
  }
  /** 原子替换完整 JSON，读取损坏数据时向上报告。 */
  write(file, value) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
    return value;
  }
  /** 读取可选 JSON，仅不存在的文件返回空。 */
  read(file) { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined; }
  /** 取回 session 元数据。 */
  get(id) { return this.read(join(this.root, 'sessions', `${validId(id)}.json`)); }
  /** 保存 session 元数据并递增版本。 */
  save(record) {
    return this.write(join(this.root, 'sessions', `${validId(record.sessionId)}.json`), {
      ...record, revision: (record.revision ?? 0) + 1, updatedAt: new Date().toISOString(),
    });
  }
  /** 更新指定 session，归档不改变运行状态。 */
  update(id, patch) {
    const current = this.get(id);
    if (!current) throw new Error(`未知 session: ${id}`);
    return this.save({ ...current, ...patch, sessionId: id });
  }
  /** 判断目标是否在指定 session 的后代集合中。 */
  descendant(record, ancestor) {
    const seen = new Set();
    let parent = record.parentSessionId;
    while (parent && !seen.has(parent)) {
      if (parent === ancestor) return true;
      seen.add(parent);
      parent = this.get(parent)?.parentSessionId;
    }
    return false;
  }
  /** 有界页读取元数据，按稳定 ID 排序且从不读取 transcript。 */
  list({ parent, descendants = false, cwd, status, role, archived = false, cursor, limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit 必须为 1..200');
    const items = [];
    const names = readdirSync(join(this.root, 'sessions')).filter(n => n.endsWith('.json')).sort();
    for (const name of names) {
      const id = name.slice(0, -5);
      if (cursor && id <= validId(cursor)) continue;
      const item = this.get(id);
      if (!archived && item.archived) continue;
      if (cwd && item.cwd !== cwd) continue;
      if (status && item.status !== status) continue;
      if (role && item.role !== role) continue;
      if (parent && (descendants ? !this.descendant(item, parent) : item.parentSessionId !== parent)) continue;
      items.push(item);
      if (items.length > limit) break;
    }
    const page = items.slice(0, limit);
    return { items: page, hasMore: items.length > limit, cursor: page.at(-1)?.sessionId ?? cursor ?? null };
  }
  /** 指向收件、发件和供 wait 使用的发送方专用索引，正文仍只有一份。 */
  messageIndexes(message) {
    const from = validId(message.from), to = validId(message.to);
    return [join(to, 'inbox.jsonl'), join(from, 'outbox.jsonl'),
      ...(['ask', 'send'].includes(message.mode) ? [join(to, 'senders', `${from}.jsonl`)] : [])];
  }

  /** 首次访问时一次性流式重建旧邮箱索引，之后启动与查询不再扫描共享消息目录。 */
  ensureMailboxIndex() {
    if (this.mailboxReady) return;
    const marker = join(this.mailboxRoot, 'version.json');
    if (!existsSync(marker)) {
      const staging = mkdtempSync(join(this.root, '.mailbox-build-'));
      try {
        const directory = opendirSync(join(this.root, 'messages'));
        try {
          let file;
          while ((file = directory.readSync())) {
            if (!file.isFile() || !file.name.endsWith('.json')) continue;
            const message = this.message(file.name.slice(0, -5));
            for (const relative of this.messageIndexes(message)) {
              const index = join(staging, relative);
              mkdirSync(dirname(index), { recursive: true });
              appendFileSync(index, JSON.stringify(message.id) + '\n', { mode: 0o600 });
            }
          }
        } finally { directory.closeSync(); }
        this.write(join(staging, 'version.json'), { version: 1 });
        renameSync(staging, this.mailboxRoot);
      } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); }
    } else if (this.read(marker).version !== 1) throw new Error('不支持的邮箱索引版本');
    // 单一 broker 写入；异常退出只需恢复最后一条新增消息的索引提交。
    const pending = this.read(join(this.root, 'mailbox-pending.json'));
    if (pending) this.commitMessage(pending);
    this.mailboxReady = true;
  }

  /** 同步提交正文与新增索引，重启重放相同文件偏移不会重复收信。 */
  commitMessage({ message, offsets }) {
    this.write(join(this.root, 'messages', `${validId(message.id)}.json`), message);
    for (const [position, relative] of this.messageIndexes(message).entries()) {
      const path = join(this.mailboxRoot, relative);
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, 'a+', 0o600);
      try {
        const offset = offsets[position];
        if (!Number.isSafeInteger(offset) || offset < 0 || offset !== fstatSync(fd).size) throw new Error('邮箱提交偏移损坏，索引可能被并发修改');
        writeSync(fd, JSON.stringify(message.id) + '\n');
      } finally { closeSync(fd); }
    }
    unlinkSync(join(this.root, 'mailbox-pending.json'));
  }

  /** 新消息只追加一次索引；回执更新保留等待消费标记且不重复索引。 */
  putMessage(message) {
    this.ensureMailboxIndex();
    const previous = this.message(message.id);
    if (previous) {
      if (previous.from !== message.from || previous.to !== message.to || previous.mode !== message.mode) throw new Error('已保存消息的路由不可变更');
      return this.write(join(this.root, 'messages', `${validId(message.id)}.json`), { ...previous, ...message });
    }
    const offsets = this.messageIndexes(message).map(relative => {
      const path = join(this.mailboxRoot, relative);
      return existsSync(path) ? statSync(path).size : 0;
    });
    this.write(join(this.root, 'mailbox-pending.json'), { message, offsets });
    this.commitMessage({ message, offsets });
    return message;
  }
  /** 读取消息用于幂等投递与精确回复。 */
  message(id) { return this.read(join(this.root, 'messages', `${validId(id)}.json`)); }
  /** 从字节偏移读取一小页索引，过滤无命中时也前移游标，避免重复扫描。 */
  readMailboxIndex(path, { cursor, limit = 50, delivery } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit 必须为 1..200');
    const match = cursor == null ? null : /^mail1:(\d+)$/.exec(cursor);
    if (cursor != null && !match) throw new Error('邮箱游标已更新，请移除 cursor 后重新查询');
    let offset = match ? Number(match[1]) : 0;
    const size = existsSync(path) ? statSync(path).size : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new Error('无效的邮箱游标');
    const items = [];
    if (size === offset) return { items, cursor: `mail1:${offset}`, hasMore: false };
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      if (offset > 0) {
        readSync(fd, buffer, 0, 1, offset - 1);
        if (buffer[0] !== 10) throw new Error('邮箱游标必须位于记录边界');
      }
      let scanned = 0;
      while (offset < size && items.length < limit && scanned < 256) {
        const length = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!length) break;
        let start = 0;
        while (start < length && items.length < limit && scanned < 256) {
          const newline = buffer.subarray(0, length).indexOf(10, start);
          if (newline < 0) break;
          const id = JSON.parse(buffer.subarray(start, newline).toString('utf8'));
          const message = this.message(id);
          if (!message) throw new Error(`邮箱索引消息不存在: ${id}`);
          offset += newline - start + 1;
          start = newline + 1;
          scanned++;
          if (!delivery || message.delivery === delivery) items.push(message);
        }
        if (start === 0) throw new Error('邮箱索引存在不完整记录');
      }
    } finally { closeSync(fd); }
    return { items, cursor: `mail1:${offset}`, hasMore: offset < size };
  }

  /** 只打开当前 session 的收件或发件索引，不枚举共享消息目录。 */
  inbox(id, { cursor, limit = 50, delivery, outgoing = false } = {}) {
    validId(id);
    this.ensureMailboxIndex();
    return this.readMailboxIndex(join(this.mailboxRoot, id, outgoing ? 'outbox.jsonl' : 'inbox.jsonl'), { cursor, limit, delivery });
  }

  /** 每个收件人/发送方持久保存 wait 偏移，只消费所选发送方新增的问题和消息。 */
  waitMessages(recipient, senders, limit = 50) {
    this.ensureMailboxIndex();
    validId(recipient);
    const messages = [];
    let hasMore = false;
    for (const sender of senders) {
      validId(sender);
      if (messages.length === limit) { hasMore = true; break; }
      const checkpoint = join(this.mailboxRoot, recipient, 'wait', `${sender}.json`);
      const previous = this.read(checkpoint)?.cursor;
      const page = this.readMailboxIndex(join(this.mailboxRoot, recipient, 'senders', `${sender}.jsonl`), { cursor: previous, limit: limit - messages.length });
      messages.push(...page.items.filter(message => !message.observedByWait));
      hasMore ||= page.hasMore;
      if (page.cursor !== (previous ?? 'mail1:0')) {
        mkdirSync(dirname(checkpoint), { recursive: true });
        this.write(checkpoint, { cursor: page.cursor });
      }
    }
    return { messages, hasMore };
  }
}
