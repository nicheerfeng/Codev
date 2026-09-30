import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { Store } from '../src/store.mjs';
import { limits, normalizeName, readFrames } from '../src/common.mjs';
import { createSession, readSession, forkSession } from '../src/sessions.mjs';
import { ManagerService } from '../src/service.mjs';
import { tools } from '../src/tools.mjs';
import { discoverProfiles, resolveProfile } from '../src/profiles.mjs';

/** 为单个测试建立独立目录并回收文件。 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-manager-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** 创建具有真实 session 文件的模拟宿主注册数据。 */
function registration(root, record, suffix = '') {
  return { ...record, instance: `instance-${record.sessionId}${suffix}`, pid: process.pid, busy: false, agentDir: root, launch: { executable: process.execPath, args: [], extension: join(root, 'index.ts') } };
}

/** 在无模型环境中创建收信宿主。 */
function peer() {
  const delivered = [];
  return { delivered, call: async (method, args) => { delivered.push({ method, args }); return { accepted: true }; } };
}

/** 等待异步投递回调完成。 */
function tick() { return new Promise(resolve => setImmediate(resolve)); }

test('工具是独立 pv_ 命令，覆盖 session 和 subagent 续作', () => {
  assert.equal(tools.length, 18);
  assert.equal(new Set(tools.map(t => t.name)).size, 18);
  assert.ok(tools.every(t => t.name.startsWith('pv_')));
  assert.ok(tools.some(t => t.name === 'pv_subagent_followup'));
});

test('CPU/内存默认并发可覆盖，非法配置明确拒绝', () => {
  assert.ok(limits().maxWorkers >= 1);
  assert.equal(limits({ maxWorkers: 100 }).maxWorkers, 100);
  assert.throws(() => limits({ maxDepth: 0 }));
  assert.equal(normalizeName('  A\n B  '), 'A B');
  assert.equal([...normalizeName('测'.repeat(80))].length, 60);
});

test('公共与项目 profile 发现按路径合并，项目同名覆盖并固化配置快照', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'pi-manager', 'agents'), { recursive: true });
  mkdirSync(join(root, '.agent', 'agents'), { recursive: true });
  writeFileSync(join(root, 'pi-manager', 'agents', 'review.json'), JSON.stringify({ name: 'reviewer', description: 'global', provider: 'global-provider', model: 'global-model', thinking: 'low', prompt: '公共提示' }));
  writeFileSync(join(root, '.agent', 'agents', 'review.json'), JSON.stringify({ name: 'reviewer', description: 'project', provider: 'project-provider', model: 'project-model', thinking: 'high', prompt: '项目提示' }));
  const found = discoverProfiles(root, root);
  assert.equal(found.errors.length, 0);
  assert.equal(found.profiles.find(profile => profile.alias === 'reviewer').provider, 'project-provider');
  const resolved = resolveProfile(found.profiles, 'reviewer', { prompt: '具体任务' });
  assert.equal(resolved.model.id, 'project-model');
  assert.equal(resolved.thinking, 'high');
  assert.match(resolved.prompt, /项目提示/);
  assert.match(resolved.prompt, /具体任务/);
});

test('JSONL 处理拆开的多字节中文及 Unicode 分隔符', () => {
  const stream = new PassThrough();
  const frames = [];
  readFrames(stream, value => frames.push(value), error => { throw error; });
  const bytes = Buffer.from(JSON.stringify({ text: '中文\u2028\u2029内容' }) + '\n');
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  assert.deepEqual(frames, [{ text: '中文\u2028\u2029内容' }]);
});

test('父子 JSONL 同目录，分页字节游标与 fork 保留正确父链', async t => {
  const root = fixture(t);
  const parent = createSession(root, { cwd: root, title: '父会话' });
  const child = createSession(root, { name: 'reviewer', message: '审核' }, parent);
  assert.equal(dirname(parent.sessionFile), dirname(child.sessionFile));
  const records = (await readSession(child.sessionFile)).entries;
  assert.equal(records.at(-1).data.parentSessionId, parent.sessionId);
  const page = await readSession(child.sessionFile, { cursor: '0', limit: 1 });
  assert.equal(page.entries.length, 1);
  assert.equal(page.hasMore, true);
  const next = await readSession(child.sessionFile, { cursor: page.cursor });
  assert.notEqual(next.entries[0].id, page.entries[0].id);
  const before = readFileSync(child.sessionFile, 'utf8');
  const fork = await forkSession(child, page.entries[0].id);
  assert.equal(readFileSync(child.sessionFile, 'utf8'), before);
  assert.notEqual(fork.sessionId, child.sessionId);
  assert.equal(fork.parentSessionId, null);
  await assert.rejects(forkSession(child, 'missing'), /不存在/);
});

test('归档只改变索引标记，恢复不覆盖状态或 transcript', t => {
  const root = fixture(t);
  const store = new Store(join(root, 'manager'));
  const record = createSession(root, { cwd: root });
  store.save({ ...record, status: 'running' });
  const before = readFileSync(record.sessionFile, 'utf8');
  store.update(record.sessionId, { archived: true });
  assert.equal(store.list().items.length, 0);
  assert.equal(store.list({ archived: true }).items[0].status, 'running');
  store.update(record.sessionId, { archived: false });
  assert.equal(store.list().items.length, 1);
  assert.equal(readFileSync(record.sessionFile, 'utf8'), before);
  assert.throws(() => store.get('../escape'));
});

test('后代查询只包含本树，同级和其他项目不混入', t => {
  const root = fixture(t);
  const store = new Store(join(root, 'manager'));
  const a = createSession(root, { cwd: root });
  const b = createSession(root, { cwd: root });
  const c = createSession(root, { name: 'worker' }, a);
  const d = createSession(root, { name: 'reviewer' }, c);
  [a,b,c,d].forEach(r => store.save(r));
  assert.deepEqual(new Set(store.list({ parent: a.sessionId, descendants: true }).items.map(r => r.sessionId)), new Set([c.sessionId, d.sessionId]));
  assert.equal(store.list({ parent: b.sessionId, descendants: true }).items.length, 0);
  assert.equal(store.list({ limit: 1 }).items.length, 1);
});

test('在线 ask/reply 精确关联，幂等 send 不重复投递', async t => {
  const root = fixture(t);
  const service = new ManagerService(join(root, 'manager'));
  t.after(() => service.close());
  const a = createSession(root, { cwd: root });
  const b = createSession(root, { cwd: root });
  const pa = peer(), pb = peer();
  service.register(pa, registration(root, a));
  service.register(pb, registration(root, b));
  const answer = service.execute(pa, 'pv_message_ask', { to: b.sessionId, text: '需要审核意见', id: 'ask-1', timeoutMs: 1000 });
  await tick();
  await service.execute(pb, 'pv_message_reply', { replyTo: 'ask-1', text: '通过' });
  assert.equal((await answer).reply.text, '通过');
  await service.execute(pa, 'pv_message_send', { to: b.sessionId, text: '说明', id: 'send-1' });
  await tick();
  await service.execute(pa, 'pv_message_send', { to: b.sessionId, text: '说明', id: 'send-1' });
  await tick();
  assert.equal(pb.delivered.filter(v => v.args.id === 'send-1').length, 1);
  await assert.rejects(service.execute(pa, 'pv_message_reply', { replyTo: 'ask-1', text: '冒领' }));
});

test('邮箱按接收方/发送方索引读取，不扫共享消息目录', async t => {
  const root = fixture(t);
  const store = new Store(join(root, 'manager'));
  const a = createSession(root, { cwd: root }), b = createSession(root, { cwd: root }), c = createSession(root, { cwd: root });
  [a, b, c].forEach(record => store.save(record));
  for (let index = 0; index < 50; index++) {
    store.putMessage({ id: `idx-${index}`, from: a.sessionId, to: b.sessionId, mode: 'send', text: `m-${index}`, delivery: 'accepted' });
  }
  const original = store.message.bind(store);
  let reads = 0;
  store.message = id => { reads++; return original(id); };
  const page = store.inbox(b.sessionId, { limit: 10 });
  assert.equal(page.items.length, 10);
  assert.ok(reads <= 11);
  assert.equal(store.inbox(c.sessionId, { limit: 10 }).items.length, 0);
  const wait = store.waitMessages(b.sessionId, [a.sessionId], 10);
  assert.equal(wait.messages.length, 10);
  assert.equal(wait.hasMore, true);
});

test('离线 mailbox 重启后保留，重新注册自动投递且未知状态不重发', async t => {
  const root = fixture(t), managerRoot = join(root, 'manager');
  const a = createSession(root, { cwd: root }), b = createSession(root, { cwd: root });
  const service = new ManagerService(managerRoot);
  const pa = peer();
  service.register(pa, registration(root, a));
  service.store.save(b);
  await service.execute(pa, 'pv_message_send', { to: b.sessionId, text: '离线信', id: 'offline' });
  assert.equal(service.store.message('offline').delivery, 'queued');
  service.close();
  const resumed = new ManagerService(managerRoot);
  t.after(() => resumed.close());
  const pb = peer();
  resumed.register(pb, registration(root, b));
  await tick(); await tick();
  assert.equal(pb.delivered[0].args.text, '离线信');
  assert.equal(resumed.store.message('offline').delivery, 'accepted');
});

test('活动进程归属冲突拒绝第二写入者；名字变更不改变稳定 agentName', async t => {
  const root = fixture(t);
  const service = new ManagerService(join(root, 'manager'));
  t.after(() => service.close());
  const a = createSession(root, { cwd: root });
  const pa = peer();
  service.register(pa, registration(root, a));
  assert.throws(() => service.register(peer(), registration(root, a, 'other')), /另一个/);
  const renamed = await service.execute(pa, 'pv_dynamic_rename', { name: '新名' });
  assert.equal(renamed.title, '新名');
  assert.equal(renamed.sessionId, a.sessionId);
});

test('单次 spawn 持久保存后排队，深度和同 parent 重名有效', async t => {
  const root = fixture(t), managerRoot = join(root, 'manager');
  const service = new ManagerService(managerRoot);
  t.after(() => service.close());
  service.config.maxWorkers = 1;
  const a = createSession(root, { cwd: root });
  const pa = peer();
  service.register(pa, registration(root, a));
  service.active.add(a.sessionId);
  const child = await service.execute(pa, 'pv_subagent_spawn', { name: 'worker', message: '工作' });
  assert.equal(child.parentSessionId, a.sessionId);
  assert.equal(service.workers.size, 0);
  await assert.rejects(service.execute(pa, 'pv_subagent_spawn', { name: 'worker', message: '重复' }), /已存在/);
  service.store.update(a.sessionId, { depth: service.config.maxDepth });
  await assert.rejects(service.execute(pa, 'pv_subagent_spawn', { name: 'next', message: '下一层' }), /maxDepth/);
});

test('父 wait 被子 ask 唤醒，回复能解除子等待，不会互相卡住', async t => {
  const root = fixture(t);
  const service = new ManagerService(join(root, 'manager'));
  t.after(() => service.close());
  const a = createSession(root, { cwd: root });
  const b = createSession(root, { name: 'child' }, a);
  service.store.save(b);
  const pa = peer(), pb = peer();
  service.register(pa, registration(root, a));
  service.register(pb, registration(root, b));
  const wait = service.execute(pa, 'pv_subagent_wait', { sessionIds: [b.sessionId], timeoutMs: 1000 });
  const ask = service.execute(pb, 'pv_message_ask', { to: a.sessionId, text: '需要决定', timeoutMs: 1000 });
  const update = await wait;
  assert.equal(update.messages[0].text, '需要决定');
  await service.execute(pa, 'pv_message_reply', { replyTo: update.messages[0].id, text: '继续' });
  assert.equal((await ask).reply.text, '继续');
  assert.equal(service.events.listenerCount('change'), 0);
  assert.equal(service.events.listenerCount('reply'), 0);
});

test('取消、超时和旧终轮 cursor 均释放等待，不误报新完成', async t => {
  const root = fixture(t);
  const service = new ManagerService(join(root, 'manager'));
  t.after(() => service.close());
  const a = createSession(root, { cwd: root }), b = createSession(root, { name: 'child' }, a);
  const pa = peer();
  service.register(pa, registration(root, a));
  service.store.save({ ...b, status: 'idle', finalOutcome: 'completed', completedSequence: 1 });
  const timed = await service.execute(pa, 'pv_subagent_wait', { sessionIds: [b.sessionId], cursor: { [b.sessionId]: 1 }, timeoutMs: 5 });
  assert.equal(timed.timedOut, true);
  const abort = new AbortController();
  const waiting = service.execute(pa, 'pv_subagent_wait', { sessionIds: [b.sessionId], cursor: { [b.sessionId]: 1 }, timeoutMs: 1000 }, abort.signal);
  abort.abort();
  await assert.rejects(waiting, /取消/);
  assert.equal(service.events.listenerCount('change'), 0);
  assert.equal(service.suspended.size, 0);
});

test('排队停止不会启动 runtime，后续等待返回 interrupted', async t => {
  const root = fixture(t);
  const service = new ManagerService(join(root, 'manager'));
  t.after(() => service.close());
  const a = createSession(root, { cwd: root });
  const pa = peer();
  service.register(pa, registration(root, a));
  service.config.maxWorkers = 1;
  service.active.add(a.sessionId);
  const child = await service.execute(pa, 'pv_subagent_spawn', { name: 'cancelled', message: '不应执行' });
  await service.execute(pa, 'pv_subagent_stop', { sessionId: child.sessionId });
  const stopped = await service.execute(pa, 'pv_subagent_wait', { sessionIds: [child.sessionId], timeoutMs: 100 });
  assert.equal(stopped.items[0].finalOutcome, 'interrupted');
  assert.equal(service.workers.size, 0);
});
