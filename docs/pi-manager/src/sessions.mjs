import { createReadStream, mkdirSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeName } from './common.mjs';

/** 流式读取原生 JSONL，字节游标只停在完整 LF 记录边界。 */
export async function* entries(file, start = 0) {
  let pending = Buffer.alloc(0);
  let offset = start;
  for await (const chunk of createReadStream(file, { start, highWaterMark: 64 * 1024 })) {
    pending = Buffer.concat([pending, chunk]);
    let index;
    while ((index = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, index);
      pending = pending.subarray(index + 1);
      offset += index + 1;
      if (line.length) yield { entry: JSON.parse(line.toString('utf8')), offset };
    }
  }
  // Pi 写入中的最后半行留待下次读取。
}

/** 读取有限条历史记录及字节游标，默认取最近一页。 */
export async function readSession(file, { cursor, limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit 必须为 1..200');
  const start = cursor == null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(start) || start < 0 || start > statSync(file).size) throw new Error('无效的历史游标');
  const page = [];
  let last = start;
  let hasMore = false;
  for await (const item of entries(file, start)) {
    if (item.entry.type === 'session') { last = item.offset; continue; }
    if (cursor != null && page.length === limit) { hasMore = true; break; }
    // 限制工具结果文本大小，原记录始终可按路径读取。
    const raw = JSON.stringify(item.entry);
    page.push(raw.length > 32_000 ? { id: item.entry.id, type: item.entry.type, preview: raw.slice(0, 32_000), truncated: true, sessionFile: file } : item.entry);
    last = item.offset;
    if (cursor == null && page.length > limit) page.shift();
  }
  return { entries: page, cursor: String(last), hasMore, sessionFile: file };
}

/** 创建 Pi v3 session，subagent 严格落在父 JSONL 所在目录。 */
export function createSession(agentDir, options, parent) {
  const cwd = resolve(options.cwd ?? parent?.cwd ?? process.cwd());
  if (!statSync(cwd).isDirectory()) throw new Error('cwd 必须是目录');
  const sessionId = randomUUID();
  const createdAt = new Date().toISOString();
  const dir = parent ? dirname(parent.sessionFile) : join(agentDir, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  mkdirSync(dir, { recursive: true });
  const sessionFile = join(dir, `${createdAt.replace(/[:.]/g, '-')}_${sessionId}.jsonl`);
  const title = normalizeName(options.title ?? options.name ?? '新会话');
  const record = {
    sessionId, sessionFile, cwd, title, kind: parent ? 'subagent' : 'session',
    parentSessionId: parent?.sessionId ?? null, rootSessionId: parent?.rootSessionId ?? parent?.sessionId ?? sessionId,
    agentName: parent ? options.name : null, role: options.role ?? null, depth: parent ? parent.depth + 1 : 0,
    model: options.model ?? parent?.model ?? null, thinking: options.thinking ?? parent?.thinking ?? null,
    profileAlias: options.profileAlias ?? parent?.profileAlias ?? null,
    archived: false, status: 'idle', turn: 0, createdAt,
  };
  const lines = [{ type: 'session', version: 3, id: sessionId, timestamp: createdAt, cwd }];
  let leaf = null;
  /** 顺序追加合法的 Pi entry 父链。 */
  const append = (data) => {
    const entry = { ...data, id: randomUUID().slice(0, 8), parentId: leaf, timestamp: createdAt };
    leaf = entry.id;
    lines.push(entry);
  };
  append({ type: 'session_info', name: title });
  if (record.model) append({ type: 'model_change', provider: record.model.provider, modelId: record.model.id });
  if (record.thinking) append({ type: 'thinking_level_change', thinkingLevel: record.thinking });
  append({ type: 'custom', customType: 'pi-manager', data: { version: 1, ...record, sessionFile: undefined, model: undefined, thinking: undefined } });
  writeFileSync(sessionFile, lines.map(line => JSON.stringify(line)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  return record;
}

/** 从指定 Pi entry 的父链复制为新 session，不改变源会话。 */
export async function forkSession(source, entryId, title) {
  const nodes = new Map();
  let header;
  let leaf;
  for await (const { entry } of entries(source.sessionFile)) {
    if (entry.type === 'session') header = entry;
    else { nodes.set(entry.id, entry); leaf = entry.id; }
  }
  const branch = [];
  let cursor = entryId ?? leaf;
  if (!header || !nodes.has(cursor)) throw new Error('fork entry ID 不存在');
  const seen = new Set();
  while (cursor) {
    if (seen.has(cursor) || !nodes.has(cursor)) throw new Error('源 session 父链不完整');
    seen.add(cursor);
    const entry = nodes.get(cursor);
    branch.unshift(entry);
    cursor = entry.parentId;
  }
  const sessionId = randomUUID();
  const createdAt = new Date().toISOString();
  const sessionFile = join(dirname(source.sessionFile), `${createdAt.replace(/[:.]/g, '-')}_${sessionId}.jsonl`);
  const branchModel = branch.filter(e => e.type === 'model_change').at(-1);
  const branchThinking = branch.filter(e => e.type === 'thinking_level_change').at(-1);
  const record = { ...source, sessionId, sessionFile, title: normalizeName(title ?? `${source.title} (fork)`), kind: 'session', parentSessionId: null, rootSessionId: sessionId, depth: 0, agentName: null, status: 'idle', turn: 0, archived: false, createdAt, sourceSessionId: source.sessionId,
    model: branchModel ? { provider: branchModel.provider, id: branchModel.modelId } : source.model,
    thinking: branchThinking?.thinkingLevel ?? source.thinking,
  };
  let parentId = null;
  const kept = branch.filter(e => !(e.type === 'custom' && e.customType === 'pi-manager')).map(e => {
    const item = { ...e, parentId };
    parentId = e.id;
    return item;
  });
  kept.push({ type: 'session_info', id: randomUUID().slice(0, 8), parentId, timestamp: createdAt, name: record.title });
  kept.push({ type: 'custom', id: randomUUID().slice(0, 8), parentId: kept.at(-1).id, timestamp: createdAt, customType: 'pi-manager', data: { version: 1, ...record, sessionFile: undefined } });
  writeFileSync(sessionFile, [{ ...header, id: sessionId, timestamp: createdAt, parentSession: source.sessionFile }, ...kept].map(e => JSON.stringify(e)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  return record;
}

/** 仅对已取得独占所有权的离线 session 追加标题。 */
export async function renameOffline(record, title) {
  let leaf = null;
  for await (const { entry } of entries(record.sessionFile)) if (entry.type !== 'session') leaf = entry.id;
  appendFileSync(record.sessionFile, JSON.stringify({ type: 'session_info', id: randomUUID().slice(0, 8), parentId: leaf, timestamp: new Date().toISOString(), name: normalizeName(title) }) + '\n');
}
