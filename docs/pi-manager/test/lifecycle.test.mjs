import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagerService } from '../src/service.mjs';
import { createSession } from '../src/sessions.mjs';

/** 给测试创建真实存储和可编排的 RPC worker 替身。 */
function setup(t, maxWorkers = 2) {
  const root = mkdtempSync(join(tmpdir(), 'pi-manager-lifecycle-'));
  const managerRoot = join(root, 'manager');
  mkdirSync(managerRoot);
  writeFileSync(join(managerRoot, 'config.json'), JSON.stringify({ maxWorkers, maxDepth: 4 }));
  const live = new Map();
  let peak = 0;
  const service = new ManagerService(managerRoot, { workerFactory: (_launch, record, _root, token, event, exit) => {
    let done;
    const worker = {
      child: { pid: process.pid }, closing: false, exited: new Promise(resolve => { done = resolve; }),
      close() { if (this.closing) return; this.closing = true; live.delete(record.sessionId); exit(new Error('closed')); done(); },
      request: async command => { if (command.type === 'abort') { event({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted' } }); event({ type: 'agent_settled' }); } },
      finish() { event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '最终答复' }], stopReason: 'stop' } }); event({ type: 'agent_settled' }); },
      crash() { live.delete(record.sessionId); exit(new Error('simulated EOF')); done(); },
    };
    live.set(record.sessionId, worker);
    peak = Math.max(peak, live.size);
    setImmediate(() => {
      const peer = { call: async method => { if (method === 'deliver') event({ type: 'agent_start' }); return { accepted: true }; }, close() {} };
      service.register(peer, { ...record, pid: process.pid, instance: record.sessionId, workerToken: token, agentDir: root, launch: { executable: process.execPath } });
    });
    return worker;
  } });
  const parent = createSession(root, { cwd: root });
  const peer = { call: async () => ({ accepted: true }) };
  service.register(peer, { ...parent, pid: process.pid, instance: parent.sessionId, agentDir: root, launch: { executable: process.execPath } });
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  return { service, root, peer, parent, live, peak: () => peak };
}

/** 等待消息循环推进。 */
async function tick() { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); }

test('12 个同层 session 排队保持并发上限，RPC 接受不会释放生成配额', async t => {
  const { service, peer, live, peak } = setup(t);
  const children = [];
  for (let index = 0; index < 12; index++) children.push(await service.execute(peer, 'pv_subagent_spawn', { name: `worker-${index}`, message: '执行' }));
  await tick();
  assert.equal(service.active.size, 2);
  assert.equal(live.size, 2);
  for (let wave = 0; wave < 6; wave++) {
    // wait 登记在完成之前，防止自动通知额外唤醒测试父会话。
    const ids = [...live.keys()];
    const waiter = service.execute(peer, 'pv_subagent_wait', { sessionIds: ids, timeoutMs: 1000 });
    for (const worker of [...live.values()]) worker.finish();
    await waiter;
    await tick();
    assert.ok(service.active.size <= 2);
  }
  assert.equal(service.queue.size, 0);
  assert.equal(children.every(r => service.record(r.sessionId).finalOutcome === 'completed'), true);
  // settled 进程关闭和下一进程启动可能短暂重叠，生成配额始终有界。
  assert.ok(peak() <= 4);
});

test('异常 EOF 释放配额，后续 session 可执行且 wait 返回失败', async t => {
  const { service, peer, live } = setup(t, 1);
  const first = await service.execute(peer, 'pv_subagent_spawn', { name: 'first', message: '执行' });
  const second = await service.execute(peer, 'pv_subagent_spawn', { name: 'second', message: '执行' });
  await tick();
  const waiter = service.execute(peer, 'pv_subagent_wait', { sessionIds: [first.sessionId], timeoutMs: 1000 });
  live.get(first.sessionId).crash();
  assert.equal((await waiter).items[0].finalOutcome, 'failed');
  await tick();
  assert.ok(live.has(second.sessionId));
});

test('停止运行只 abort 当前回合，允许继续复用同一 session', async t => {
  const { service, peer } = setup(t);
  const child = await service.execute(peer, 'pv_subagent_spawn', { name: 'worker', message: '执行' });
  await tick();
  const wait = service.execute(peer, 'pv_subagent_wait', { sessionIds: [child.sessionId], timeoutMs: 1000 });
  await service.execute(peer, 'pv_subagent_stop', { sessionId: child.sessionId });
  assert.equal((await wait).items[0].finalOutcome, 'interrupted');
  await tick();
  const receipt = await service.execute(peer, 'pv_subagent_followup', { sessionId: child.sessionId, message: '继续' });
  assert.equal(receipt.to, child.sessionId);
  await tick();
  assert.equal(service.record(child.sessionId).status, 'running');
});
