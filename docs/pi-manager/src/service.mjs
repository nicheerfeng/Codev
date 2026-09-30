import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Store } from './store.mjs';
import { limits, normalizeName, validId } from './common.mjs';
import { createSession, readSession, forkSession, renameOffline } from './sessions.mjs';
import { Worker } from './worker.mjs';
import { discoverProfiles, resolveProfile } from './profiles.mjs';

/** 检查持有者进程是否仍存在，权限错误不视为进程已退出。 */
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/** 内置服务统一串行写入索引并管理所有 parent 的活动 worker 配额。 */
export class ManagerService {
  /** 注入 worker 工厂以便使用同样协议进行隔离测试。 */
  constructor(root, { workerFactory = (...args) => new Worker(...args) } = {}) {
    this.store = new Store(root);
    this.root = root;
    this.config = limits(this.store.read(join(root, 'config.json')));
    this.workerFactory = workerFactory;
    this.peers = new Map();
    this.workers = new Map();
    this.active = new Set();
    this.suspended = new Map();
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.queue = new Set();
    this.delivering = new Set();
    this.closing = false;
    this.inflight = new Set();
    this.waitTargets = new Map();
    this.resumes = [];
  }

  /** 注册真实 session，拒绝第二个活跃写入者。 */
  register(peer, data) {
    validId(data.sessionId);
    if (!data.sessionFile || !data.cwd || !data.launch?.executable) throw new Error('注册缺少 sessionFile/cwd/launch');
    const current = this.store.get(data.sessionId);
    const oldPeer = this.peers.get(data.sessionId);
    if (oldPeer && oldPeer !== peer) throw new Error('session 已被另一个运行时连接');
    const worker = this.workers.get(data.sessionId);
    if (worker && data.workerToken !== worker.token) throw new Error('worker 所有权不匹配');
    if (!worker && current?.owner && current.owner.instance !== data.instance && alive(current.owner.pid)) throw new Error('session 仍由其他进程持有');
    const metadata = data.metadata?.kind === 'subagent' ? data.metadata : {};
    const record = this.store.save({
      sessionId: data.sessionId, kind: 'session', depth: 0, parentSessionId: null,
      rootSessionId: data.sessionId, archived: false, turn: 0, revision: 0,
      createdAt: new Date().toISOString(), ...metadata, ...current,
      sessionFile: resolve(data.sessionFile), cwd: resolve(data.cwd), title: data.title ?? current?.title ?? '新会话',
      model: data.model ?? current?.model, thinking: data.thinking ?? current?.thinking,
      launch: data.launch, agentDir: data.agentDir,
      owner: { pid: data.pid, instance: data.instance },
      status: data.busy ? 'running' : (worker ? current?.status ?? 'starting' : 'idle'),
    });
    peer.sessionId = record.sessionId;
    this.peers.set(record.sessionId, peer);
    if (data.busy) this.active.add(record.sessionId);
    this.events.emit(`session:${record.sessionId}`);
    // 重连只恢复从未尝试投递的消息；未知执行状态不会自动重发。
    let cursor;
    do {
      const page = this.store.inbox(record.sessionId, { cursor, delivery: 'queued', limit: 100 });
      for (const message of page.items) this.queue.add(message.id);
      cursor = page.hasMore ? page.cursor : null;
    } while (cursor);
    do {
      const page = this.store.inbox(record.sessionId, { cursor, delivery: 'queued', outgoing: true, limit: 100 });
      for (const message of page.items) this.queue.add(message.id);
      cursor = page.hasMore ? page.cursor : null;
    } while (cursor);
    setImmediate(() => this.pump());
    return { sessionId: record.sessionId, limits: this.config };
  }

  /** 断线只释放对应 peer，不把断线当作任务成功。 */
  unregister(peer, intentional = false) {
    if (this.closing) return;
    const id = peer.sessionId;
    if (!id || this.peers.get(id) !== peer) return;
    this.peers.delete(id);
    if (!this.workers.has(id)) {
      this.active.delete(id);
      this.store.update(id, { status: intentional ? 'idle' : 'stale', ...(intentional ? { owner: null } : {}) });
      this.events.emit(`session:${id}`);
    }
  }

  /** 按需读取状态，进程异常退出的旧运行态标记 stale。 */
  record(id) {
    const record = this.store.get(validId(id));
    if (!record) throw new Error(`未知 session: ${id}`);
    if (!this.peers.has(id) && !this.workers.has(id) && ['running', 'starting', 'waiting'].includes(record.status) && !alive(record.owner?.pid)) {
      return this.store.update(id, { status: 'stale', owner: null, finalOutcome: 'failed', completedSequence: (record.completedSequence ?? 0) + 1 });
    }
    return record;
  }

  /** 子代理控制限定在当前父会话的后代范围。 */
  child(actor, id) {
    const target = this.record(id);
    if (!this.store.descendant(target, actor)) throw new Error('目标不属于当前 session 的 subagent 树');
    return target;
  }

  /** 校验普通 session 操作的默认范围或显式 global 授权。 */
  authorizeSession(actor, id, args = {}, operation = 'read') {
    const target = this.record(id);
    const current = this.record(actor);
    if (args.global === true) {
      if (operation === 'fork' && current.kind !== 'session') throw new Error('只有主 session 可以 global fork');
      return target;
    }
    if (current.kind === 'subagent') {
      if (target.sessionId !== actor && !this.store.descendant(target, actor)) throw new Error('目标不属于当前 session 的 subagent 树');
      return target;
    }
    if (target.sessionId !== actor && target.cwd !== current.cwd && !this.store.descendant(target, actor)) throw new Error('目标不属于当前项目或 session 子树');
    return target;
  }

  /** 控制面仅返回业务字段，隐藏内部启动路径与所有权凭据。 */
  summary(record) {
    const { launch, owner, workerToken, agentDir, ...visible } = record;
    return visible;
  }

  /** 执行已登记调用者的独立工具命令。 */
  async execute(peer, method, args = {}, signal) {
    const actor = peer.sessionId;
    if (!actor || this.peers.get(actor) !== peer) throw new Error('必须先注册 session');
    const current = this.record(actor);
    switch (method) {
      case 'pv_session_create':
      case 'pv_subagent_spawn': {
        const parent = method === 'pv_subagent_spawn' ? current : null;
        if (parent && parent.depth >= this.config.maxDepth) throw new Error(`达到 maxDepth=${this.config.maxDepth}`);
        if (parent) {
          if (typeof args.name !== 'string' || !/^[\p{L}\p{N}_-]{1,80}$/u.test(args.name)) throw new Error('name 使用 1..80 个文字、数字、下划线或短横线');
          let cursor;
          do {
            const page = this.store.list({ parent: actor, archived: true, cursor });
            if (page.items.some(r => r.agentName === args.name)) throw new Error('同一 parent 下 name 已存在，请 followup 复用');
            cursor = page.hasMore ? page.cursor : null;
          } while (cursor);
          if (!args.message?.trim()) throw new Error('spawn 必须提供完整 message');
        }
        const discovered = discoverProfiles(current.agentDir, args.cwd ?? current.cwd);
        const resolved = resolveProfile(discovered.profiles, args.profile, { provider: args.provider, model: args.model ?? current.model, thinking: args.thinking ?? current.thinking, prompt: args.message });
        const record = createSession(current.agentDir, { ...args, ...resolved, cwd: args.cwd ?? current.cwd }, parent);
        const saved = this.store.save({ ...record, launch: current.launch, agentDir: current.agentDir });
        if (resolved.prompt) await this.send(actor, { to: saved.sessionId, text: resolved.prompt, wake: true }, signal);
        return this.summary(this.record(saved.sessionId));
      }
      case 'pv_agent_profiles': {
        const result = discoverProfiles(current.agentDir, args.cwd ?? current.cwd);
        return { profiles: result.profiles, errors: result.errors };
      }
      case 'pv_session_list':
      case 'pv_subagent_list': {
        const scope = method === 'pv_subagent_list' ? { parent: actor } : args.global === true ? {} : current.kind === 'subagent' ? { parent: actor, descendants: true } : { cwd: current.cwd };
        const page = this.store.list({ ...args, ...scope });
        return { ...page, items: page.items.map(r => {
          const { finalResponse, ...summary } = this.summary(this.record(r.sessionId));
          return summary;
        }), limits: this.config };
      }
      case 'pv_session_read':
      case 'pv_subagent_read': {
        const record = method === 'pv_subagent_read' ? this.child(actor, args.sessionId) : this.authorizeSession(actor, args.sessionId ?? actor, args, 'read');
        return { session: this.summary(record), ...await readSession(record.sessionFile, args) };
      }
      case 'pv_dynamic_rename':
      case 'pv_session_rename': {
        const id = method === 'pv_dynamic_rename' ? actor : args.sessionId ?? actor;
        const record = method === 'pv_dynamic_rename' ? this.record(id) : this.authorizeSession(actor, id, args, 'rename');
        const name = normalizeName(args.name);
        const target = this.peers.get(id);
        if (target) await target.call('rename', { name });
        else {
          if (this.workers.has(id) || alive(record.owner?.pid)) throw new Error('runtime 启动或断线中，请等待其重新连接');
          await renameOffline(record, name);
        }
        return this.summary(this.store.update(id, { title: name }));
      }
      case 'pv_session_archive': {
        const id = args.sessionId ?? actor;
        this.authorizeSession(actor, id, args, 'archive');
        return this.summary(this.store.update(id, { archived: args.archived !== false }));
      }
      case 'pv_session_fork': {
        const record = this.authorizeSession(actor, args.sessionId ?? actor, args, 'fork');
        const target = this.peers.get(record.sessionId);
        const entryId = args.entryId ?? (target ? (await target.call('leaf', {})).entryId : undefined);
        const fork = await forkSession(record, entryId, args.name);
        return this.summary(this.store.save({ ...fork, owner: null, finalResponse: undefined, finalOutcome: undefined }));
      }
      case 'pv_message_send': return this.send(actor, args, signal);
      case 'pv_subagent_followup':
        this.child(actor, args.sessionId);
        return this.send(actor, { to: args.sessionId, text: args.message, wake: true, behavior: args.behavior ?? 'followUp' }, signal);
      case 'pv_message_inbox': {
        const page = this.store.inbox(actor, args);
        return { ...page, items: page.items.map(message => this.receipt(message)) };
      }
      case 'pv_message_ask': {
        if (!this.peers.has(args.to)) throw new Error('ask 接收者必须在线；离线投递请用 send');
        return this.ask(actor, args, signal);
      }
      case 'pv_message_reply': {
        const original = this.store.message(validId(args.replyTo));
        if (!original || original.mode !== 'ask' || original.to !== actor) throw new Error('replyTo 不属于当前 session 的询问');
        if (original.replyId) return this.store.message(original.replyId);
        const reply = await this.send(actor, { ...args, id: `reply-${original.id}`, to: original.from, wake: false, mode: 'reply' }, signal);
        this.store.putMessage({ ...original, replyId: reply.id });
        this.events.emit(`reply:${original.id}`);
        return reply;
      }
      case 'pv_subagent_wait': return this.wait(actor, args, signal);
      case 'pv_subagent_stop': {
        const record = this.child(actor, args.sessionId);
        for (const id of this.queue) {
          const message = this.store.message(id);
          if (message.to === record.sessionId) {
            this.store.putMessage({ ...message, delivery: 'cancelled' });
            this.queue.delete(id);
          }
        }
        const target = this.peers.get(record.sessionId);
        this.store.update(record.sessionId, { stopRequested: true });
        if (this.workers.has(record.sessionId)) {
          const worker = this.workers.get(record.sessionId).worker;
          await worker.request({ type: 'clear_queue' });
          await worker.request({ type: 'abort' });
        } else if (target) await target.call('abort', {});
        else {
          this.store.update(record.sessionId, { status: 'idle', finalOutcome: 'interrupted', stopRequested: false, completedSequence: (record.completedSequence ?? 0) + 1 });
          this.events.emit(`session:${record.sessionId}`);
        }
        return this.summary(this.record(record.sessionId));
      }
      default: throw new Error(`未知工具: ${method}`);
    }
  }

  /** 保存消息后排队；稳定 ID 重试不导致重复执行。 */
  async send(actor, args) {
    this.record(args.to);
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 500_000) throw new Error('text 必须非空且不超过 500000 字符');
    const id = args.id ?? `${Date.now()}-${randomUUID()}`;
    const existing = this.store.message(id);
    if (existing) {
      if (existing.from !== actor || existing.to !== args.to || existing.text !== args.text) throw new Error('消息 ID 已用于不同内容');
      return this.receipt(existing);
    }
    const message = this.store.putMessage({
      id, from: actor, to: args.to, text: args.text, replyTo: args.replyTo ?? null,
      mode: args.mode ?? 'send', wake: args.wake === true, behavior: args.behavior ?? 'steer',
      delivery: 'queued', createdAt: new Date().toISOString(),
    });
    const target = this.record(args.to);
    if (message.wake && ['idle', 'stale'].includes(target.status)) this.store.update(args.to, { status: 'queued', finalOutcome: null });
    this.queue.add(id);
    if (['ask', 'send'].includes(message.mode)) this.events.emit(`mail:${message.to}:${message.from}`);
    this.pump();
    return this.store.message(message.id);
  }

  /** 空闲的受管 session 按需启动；进程身份通过内部 token 校验。 */
  launch(record) {
    if (this.workers.has(record.sessionId)) return;
    if (alive(record.owner?.pid)) throw new Error('session 的已有 runtime 尚未连接，禁止双写');
    const token = randomUUID();
    this.store.update(record.sessionId, { status: 'starting', stopRequested: false, lastError: null });
    const worker = this.workerFactory(record.launch, record, this.root, token,
      event => this.workerEvent(record.sessionId, event),
      error => this.workerExit(record.sessionId, error));
    this.workers.set(record.sessionId, { worker, token });
    this.active.add(record.sessionId);
    this.store.update(record.sessionId, { owner: { pid: worker.child.pid, instance: token } });
    const timer = setTimeout(() => {
      if (!this.peers.has(record.sessionId)) {
        const current = this.record(record.sessionId);
        const failed = this.store.update(record.sessionId, { status: 'stale', lastError: 'Pi worker 注册超时', finalOutcome: 'failed', completedSequence: (current.completedSequence ?? 0) + 1 });
        this.notifyCompletion(failed);
        this.events.emit(`session:${record.sessionId}`);
        worker.close();
      }
    }, 30_000);
    timer.unref();
    this.workers.get(record.sessionId).timer = timer;
  }

  /** 全树共享运行配额，等待中的 parent 让出生成配额以避免递归死锁。 */
  pump() {
    if (this.closing) return;
    while (this.resumes.length && this.active.size < this.config.maxWorkers) {
      const resume = this.resumes.shift();
      if (!this.peers.has(resume.actor)) { resume.resolve(); continue; }
      this.active.add(resume.actor);
      resume.resolve();
    }
    for (const id of this.queue) {
      const message = this.store.message(id);
      if (message.delivery !== 'queued') { this.queue.delete(id); continue; }
      if (this.delivering.has(message.to)) continue;
      const peer = this.peers.get(message.to);
      const record = this.record(message.to);
      if (this.workers.get(message.to)?.worker.closing) continue;
      const busy = ['running', 'waiting'].includes(record.status);
      if (this.suspended.has(message.to) && message.mode !== 'reply') continue;
      if (message.wake && !busy && !this.active.has(message.to) && this.active.size >= this.config.maxWorkers) continue;
      if (!peer) {
        if (!message.wake || this.workers.has(message.to)) continue;
        try { this.launch(record); }
        catch (error) {
          this.store.putMessage({ ...message, delivery: 'failed', error: error.message });
          this.queue.delete(id);
          this.store.update(message.to, { status: 'stale', finalOutcome: 'failed', lastError: error.message, completedSequence: (record.completedSequence ?? 0) + 1 });
          this.events.emit(`session:${message.to}`);
        }
        continue;
      }
      if (message.wake && !busy) {
        this.active.add(message.to);
        this.store.update(message.to, { status: 'starting', finalResponse: '', finalOutcome: null, stopRequested: false });
      }
      this.queue.delete(id);
      this.delivering.add(message.to);
      this.store.putMessage({ ...message, delivery: 'delivering' });
      const delivery = peer.call('deliver', message).then(() => {
        this.store.putMessage({ ...message, delivery: 'accepted' });
      }, error => {
        this.store.putMessage({ ...message, delivery: 'unknown', error: error.message });
        // 超时可能已经触发模型，不自动释放正在执行的配额或重发。
      }).finally(() => { this.delivering.delete(message.to); this.inflight.delete(delivery); this.pump(); });
      this.inflight.add(delivery);
    }
  }

  /** 将原生生命周期投影到 session，agent_end 不视为压缩与重试结束。 */
  workerEvent(id, event) {
    const current = this.store.get(id);
    if (!current) return;
    if (event.type === 'agent_start') {
      this.active.add(id);
      this.store.update(id, { status: 'running', turn: (current.turn ?? 0) + 1 });
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const message = event.message;
      const text = (message.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('');
      this.store.update(id, { finalResponse: text, finalOutcome: current.stopRequested || message.stopReason === 'aborted' ? 'interrupted' : message.stopReason === 'error' ? 'failed' : 'completed', lastError: message.errorMessage ?? null });
    } else if (event.type === 'session_info_changed') {
      this.store.update(id, { title: event.name ?? current.title });
    } else if (event.type === 'model_select' && event.model) {
      this.store.update(id, { model: { provider: event.model.provider, id: event.model.id } });
    } else if (event.type === 'thinking_level_select') {
      this.store.update(id, { thinking: event.thinkingLevel ?? event.level });
    } else if (event.type === 'agent_settled') {
      this.active.delete(id);
      const settled = this.store.update(id, { status: 'idle', completedSequence: (current.completedSequence ?? 0) + 1, finalOutcome: current.stopRequested ? 'interrupted' : current.finalOutcome ?? 'completed', stopRequested: false });
      this.notifyCompletion(settled);
      setImmediate(() => {
        this.pump();
        if (!this.active.has(id) && !this.suspended.has(id) && ![...this.queue].some(key => this.store.message(key).to === id)) this.workers.get(id)?.worker.close();
      });
    }
    if (event.type === 'agent_settled') this.events.emit(`session:${id}`);
  }

  /** 释放退出进程及配额，失败时保留错误且不会吞掉 pending。 */
  workerExit(id, error) {
    const worker = this.workers.get(id);
    if (!worker) return;
    clearTimeout(worker.timer);
    this.workers.delete(id);
    this.active.delete(id);
    const peer = this.peers.get(id);
    this.peers.delete(id);
    peer?.close?.();
    const record = this.store.get(id);
    const queued = [...this.queue].some(key => this.store.message(key).to === id);
    const failed = !worker.worker.closing && record.status !== 'idle';
    const final = this.store.update(id, { owner: null, status: queued ? 'queued' : failed ? 'stale' : 'idle', ...(failed ? { lastError: error.message, finalOutcome: 'failed', completedSequence: (record.completedSequence ?? 0) + 1 } : {}) });
    if (failed) this.notifyCompletion(final);
    this.events.emit(`session:${id}`);
    this.pump();
  }

  /** 终轮与失败各投递一次；正在 wait 的 parent 通过工具结果接收而不额外启动回合。 */
  notifyCompletion(record) {
    if (!record.parentSessionId || record.notifiedSequence === record.completedSequence || this.closing) return;
    this.store.update(record.sessionId, { notifiedSequence: record.completedSequence });
    const waiting = this.waitTargets.get(record.parentSessionId)?.has(record.sessionId);
    const text = record.finalResponse ?? '';
    const notification = {
      sessionId: record.sessionId, sessionFile: record.sessionFile, name: record.agentName,
      outcome: record.finalOutcome, finalResponse: text.slice(0, 300_000),
      ...(text.length > 300_000 ? { truncated: true } : {}),
      ...(record.lastError ? { error: record.lastError } : {}),
    };
    void this.send(record.sessionId, { to: record.parentSessionId, text: JSON.stringify(notification), wake: !waiting, mode: 'completion', id: `completion-${record.sessionId}-${record.completedSequence}` })
      .catch(error => this.store.update(record.sessionId, { notificationError: error.message }));
  }

  /** 服务中断留下的投递尝试只标记未知，不作为待发消息自动重放。 */
  receipt(message) {
    if (message.delivery === 'delivering' && !this.delivering.has(message.to)) {
      return this.store.putMessage({ ...message, delivery: 'unknown', error: '投递回执未确认，请先读取目标 session 判断是否执行' });
    }
    return message;
  }

  /** 等待事件而非轮询，支持取消且始终释放监听器。 */
  observe(events, check, timeoutMs = 60_000, signal) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 600_000) return Promise.reject(new Error('timeoutMs 必须为 0..600000'));
    return new Promise((resolve, reject) => {
      let timer;
      let scheduled;
      let finished = false;
      const listeners = new Map();
      /** 终止等待并回收全部监听。 */
      const finish = (value, error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearImmediate(scheduled);
        for (const [event, listener] of listeners) this.events.off(event, listener);
        signal?.removeEventListener('abort', aborted);
        error ? reject(error) : resolve(value);
      };
      /** 接收到事件时检查指定对象。 */
      const changed = (event) => {
        if (finished) return;
        try {
          const value = check(event, () => {
            if (!scheduled) scheduled = setImmediate(() => { scheduled = undefined; changed(event); });
          });
          if (value) finish(value);
        } catch (error) { finish(null, error); }
      };
      /** 取消等待不会取消其他 session。 */
      const aborted = () => finish(null, new Error('等待已取消'));
      for (const event of new Set(Array.isArray(events) ? events : [events])) {
        const listener = () => changed(event);
        listeners.set(event, listener);
        this.events.on(event, listener);
      }
      signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
      if (signal?.aborted) aborted(); else changed();
    });
  }

  /** 明确等待时让出活动配额，结束后恢复 parent 的生成状态。 */
  async yielding(actor, operation, signal) {
    const wasActive = this.active.delete(actor);
    this.suspended.set(actor, (this.suspended.get(actor) ?? 0) + 1);
    this.store.update(actor, { status: 'waiting' });
    this.pump();
    try { return await operation(); }
    finally {
      const count = this.suspended.get(actor) - 1;
      if (count) this.suspended.set(actor, count);
      else {
        this.suspended.delete(actor);
        if (wasActive && this.peers.has(actor) && !signal?.aborted && !this.closing) {
          await new Promise(resolve => { this.resumes.push({ actor, resolve }); this.pump(); });
        }
        if (!this.closing) this.store.update(actor, { status: wasActive && !signal?.aborted ? 'running' : 'idle' });
        this.pump();
      }
    }
  }

  /** 精确 ask/reply 匹配，回复直接唤醒工具等待，无需请求方再次调用模型。 */
  async ask(actor, args, signal) {
    const message = await this.send(actor, { ...args, mode: 'ask', wake: true });
    return this.yielding(actor, async () => {
      const answer = await this.observe(`reply:${message.id}`, () => {
        const original = this.store.message(message.id);
        return original.replyId ? { reply: this.store.message(original.replyId) } : null;
      }, args.timeoutMs, signal);
      return { requestId: message.id, ...answer };
    }, signal);
  }

  /** 任一所选子代理有新终轮或邮箱事件即返回，cursor 防止反复返回旧结果。 */
  async wait(actor, args, signal) {
    const ids = args.sessionIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw new Error('sessionIds 需要 1..200 个目标，可多批等待');
    ids.forEach(id => this.child(actor, id));
    this.waitTargets.set(actor, new Set(ids));
    try { return await this.yielding(actor, async () => {
      const subscriptions = ids.flatMap(id => [`session:${id}`, `mail:${actor}:${id}`]);
      const result = await this.observe(subscriptions, (event, continueReading) => {
        const changedIds = !event ? ids : event.startsWith('session:') ? [event.slice('session:'.length)] : [];
        const items = changedIds.map(id => this.record(id)).filter(r => ['idle', 'stale'].includes(r.status) && r.finalOutcome && (r.completedSequence ?? 0) > (args.cursor?.[r.sessionId] ?? 0));
        const senders = !event ? ids : event.startsWith(`mail:${actor}:`) ? [event.slice(`mail:${actor}:`.length)] : [];
        const { messages, hasMore } = senders.length ? this.store.waitMessages(actor, senders) : { messages: [], hasMore: false };
        if (hasMore && !messages.length) continueReading();
        if (!items.length && !messages.length) return null;
        for (const message of messages) this.store.putMessage({ ...message, observedByWait: true, wake: false });
        return { items: items.map(r => this.summary(r)), messages, cursor: { ...args.cursor, ...Object.fromEntries(items.map(r => [r.sessionId, r.completedSequence])) } };
      }, args.timeoutMs, signal);
      return result;
    }, signal); } finally { this.waitTargets.delete(actor); }
  }

  /** 关闭服务只终止本服务创建的 runtime，外部 Pi 不受影响。 */
  async close() {
    this.closing = true;
    for (const resume of this.resumes.splice(0)) resume.resolve();
    for (const { worker, timer } of this.workers.values()) { clearTimeout(timer); worker.close(); }
    await Promise.allSettled([...this.inflight, ...[...this.workers.values()].map(({ worker }) => worker.exited)]);
    this.events.removeAllListeners();
  }
}
