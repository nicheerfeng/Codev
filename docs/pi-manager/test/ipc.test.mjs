import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker } from '../src/broker.mjs';
import { Channel, connectSocket, connectManager, accessToken } from '../src/ipc.mjs';
import { createSession } from '../src/sessions.mjs';

test('真实 IPC 双向消息、认证、断线请求与 broker 停止清理', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-manager-ipc-'));
  const broker = await startBroker(root, { idleMs: 60_000 });
  const clients = [];
  t.after(async () => { for (const c of clients) c.close(); await broker.close(); rmSync(root, { recursive: true, force: true }); });
  const received = [];
  /** 建立一个真实 socket 会话端点。 */
  async function connect(name) {
    const client = new Channel(await connectSocket(root), async (method, args) => { received.push({ name, method, args }); return { accepted: true }; });
    clients.push(client);
    await client.call('hello', { token: accessToken(root), version: 1 });
    const record = createSession(root, { cwd: root, title: name });
    await client.call('register', { ...record, pid: process.pid, instance: name, agentDir: root, launch: { executable: process.execPath } });
    return { client, record };
  }
  const a = await connect('A'), b = await connect('B');
  await a.client.call('pv_message_send', { to: b.record.sessionId, text: '中文\u2028段落', id: 'message-one' });
  await new Promise(resolve => setTimeout(resolve, 30));
  const inbox = await b.client.call('pv_message_inbox', {});
  assert.equal(inbox.items[0].delivery, 'accepted');
  assert.equal(received[0].args.text, '中文\u2028段落');
  const unauthorized = new Channel(await connectSocket(root), async () => {});
  clients.push(unauthorized);
  await assert.rejects(unauthorized.call('hello', { token: 'wrong', version: 1 }), /认证/);
  await assert.rejects(unauthorized.call('pv_session_list'), /未认证/);
  const pending = a.client.call('pv_message_ask', { to: b.record.sessionId, text: '等待回复', timeoutMs: 5000 });
  a.client.close();
  await assert.rejects(pending, /断开/);
});

test('独立包冷启动 broker 并复用唯一实例，退出后可再次冷启动', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-manager-boot-'));
  const peers = [];
  const pids = new Set();
  t.after(async () => {
    for (const peer of peers) peer.close();
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    rmSync(root, { recursive: true, force: true });
  });
  const a = await connectManager(root, async () => ({ accepted: true }));
  peers.push(a);
  const identity = await a.call('hello', { token: accessToken(root), version: 1 });
  pids.add(identity.pid);
  const b = await connectManager(root, async () => ({ accepted: true }));
  peers.push(b);
  const second = await b.call('hello', { token: accessToken(root), version: 1 });
  assert.equal(second.pid, identity.pid);
  a.close(); b.close();
  process.kill(identity.pid, 'SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 250));
  pids.delete(identity.pid);
  const resumed = await connectManager(root, async () => ({ accepted: true }));
  peers.push(resumed);
  const next = await resumed.call('hello', { token: accessToken(root), version: 1 });
  pids.add(next.pid);
  assert.notEqual(next.pid, identity.pid);
});
