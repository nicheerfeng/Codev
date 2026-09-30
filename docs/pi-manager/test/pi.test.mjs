import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFrames, writeFrame } from '../src/common.mjs';
import { createSession } from '../src/sessions.mjs';
import { startBroker } from '../src/broker.mjs';

/** 以实际安装的公开 Pi 运行时执行本地模拟提供方，绝不读取用户认证。 */
test('真实 Pi: 冷创建子会话、动态改名、终轮通知、继续同一 session、归档和 fork', { timeout: 90_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-manager-real-'));
  const managerRoot = join(root, 'manager');
  mkdirSync(managerRoot);
  writeFileSync(join(managerRoot, 'config.json'), JSON.stringify({ maxWorkers: 1, maxDepth: 3 }));
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const messages = body.messages ?? [];
    const calledRename = messages.some(m => m.role === 'tool' && m.tool_call_id === 'rename-call');
    const isFollowup = JSON.stringify(messages).includes('second-pass');
    const nested = messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('nested-parent'));
    const toolResults = messages.filter(m => m.role === 'tool');
    const spawned = toolResults.find(m => m.tool_call_id === 'spawn-call');
    const waited = toolResults.some(m => m.tool_call_id === 'wait-call');
    let choice = calledRename || isFollowup
      ? { content: isFollowup ? '第二轮完成' : '子代理完成', role: 'assistant' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'rename-call', type: 'function', function: { name: 'pv_dynamic_rename', arguments: JSON.stringify({ name: '审核已完成' }) } }] };
    if (nested) {
      if (!spawned) choice = { role: 'assistant', content: null, tool_calls: [{ id: 'spawn-call', type: 'function', function: { name: 'pv_subagent_spawn', arguments: JSON.stringify({ name: 'grandchild', message: 'leaf-pass' }) } }] };
      else if (!waited) {
        const data = JSON.parse(typeof spawned.content === 'string' ? spawned.content : spawned.content.map(p => p.text ?? '').join(''));
        choice = { role: 'assistant', content: null, tool_calls: [{ id: 'wait-call', type: 'function', function: { name: 'pv_subagent_wait', arguments: JSON.stringify({ sessionIds: [data.sessionId], timeoutMs: 10000 }) } }] };
      } else choice = { role: 'assistant', content: '嵌套完成' };
    }
    const finish_reason = choice.tool_calls ? 'tool_calls' : 'stop';
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = choice.tool_calls ? { ...choice, tool_calls: choice.tool_calls.map((call, index) => ({ ...call, index })) } : choice;
      res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'test', choices: [{ index: 0, message: choice, finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(root, 'models.json'), JSON.stringify({ providers: { localtest: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-only-test', api: 'openai-completions', models: [{ id: 'mock', name: 'Mock', contextWindow: 32000, maxTokens: 1000, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ defaultProvider: 'localtest', defaultModel: 'mock', packages: [] }));
  // broker 子进程必须继承隔离 Pi agent 目录。
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const broker = await startBroker(managerRoot, { idleMs: 120_000 });
  const piRoot = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const session = createSession(root, { cwd: root, title: '主会话', model: { provider: 'localtest', id: 'mock' } });
  const child = spawn(process.execPath, [join(piRoot, 'bundle', 'cli.js'), '--mode', 'rpc', '--session', session.sessionFile, '--no-extensions', '-e', fileURLToPath(new URL('./pi-harness.ts', import.meta.url))], {
    cwd: root, windowsHide: true, stdio: 'pipe', env: { ...process.env, PI_MANAGER_ROOT: managerRoot },
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  const pending = new Map();
  const events = [];
  readFrames(child.stdout, event => {
    events.push(event);
    if (event.type === 'entry_appended' && event.entry?.customType === 'pi-manager-test') {
      const data = event.entry.data, item = pending.get(data.id);
      if (item) { clearTimeout(item.timer); pending.delete(data.id); data.error ? item.reject(new Error(data.error)) : item.resolve(data.result); }
    }
  }, error => { errors += String(error); });
  t.after(async () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('test cleanup')); }
    child.stdin.end();
    await broker.close();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 300));
    if (child.exitCode === null) child.kill();
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    rmSync(root, { recursive: true, force: true });
  });
  /** 从真实 Pi RPC 调用实际注册工具并等待 entry 回执。 */
  function call(name, args = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Pi test ${name} 超时: ${errors.slice(-2000)} ${JSON.stringify(events.slice(-3))}`)); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      writeFrame(child.stdin, { type: 'prompt', message: `/pm-test ${JSON.stringify({ id, name, args })}` });
    });
  }
  const renamed = await call('pv_dynamic_rename', { name: '真实冷启动主会话' });
  assert.equal(renamed.title, '真实冷启动主会话');
  const sub = await call('pv_subagent_spawn', { name: 'worker', message: 'first-pass' });
  assert.equal(dirname(sub.sessionFile), dirname(session.sessionFile));
  const done = await call('pv_subagent_wait', { sessionIds: [sub.sessionId], timeoutMs: 20_000 });
  assert.equal(done.items?.[0].finalResponse, '子代理完成', JSON.stringify(done));
  assert.equal(done.items[0].title, '审核已完成');
  await call('pv_subagent_followup', { sessionId: sub.sessionId, message: 'second-pass' });
  const again = await call('pv_subagent_wait', { sessionIds: [sub.sessionId], cursor: done.cursor, timeoutMs: 20_000 });
  assert.equal(again.items?.[0].finalResponse, '第二轮完成', JSON.stringify(again));
  const before = readFileSync(sub.sessionFile, 'utf8');
  await call('pv_session_archive', { sessionId: sub.sessionId, archived: true });
  assert.equal(readFileSync(sub.sessionFile, 'utf8'), before);
  await call('pv_session_archive', { sessionId: sub.sessionId, archived: false });
  const fork = await call('pv_session_fork', { sessionId: sub.sessionId, name: 'forked' });
  assert.notEqual(fork.sessionId, sub.sessionId);
  assert.equal(fork.parentSessionId, null);
  const nested = await call('pv_subagent_spawn', { name: 'nested', message: 'nested-parent' });
  const nestedDone = await call('pv_subagent_wait', { sessionIds: [nested.sessionId], timeoutMs: 20_000 });
  assert.equal(nestedDone.items?.[0].finalResponse, '嵌套完成', JSON.stringify(nestedDone));
  const tree = await call('pv_subagent_list', { descendants: true });
  assert.ok(tree.items.some(item => item.agentName === 'grandchild' && item.parentSessionId === nested.sessionId));
  assert.ok(broker.service.active.size <= 1);
});
