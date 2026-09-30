import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFrames, writeFrame } from './common.mjs';

/** 单个 Pi RPC 进程，接受回执与最终停止事件严格分离。 */
export class Worker {
  /** 启动属于本插件的 worker，并实时转发原生事件。 */
  constructor(launch, record, root, token, onEvent, onExit) {
    this.pending = new Map();
    this.closed = false;
    this.closing = false;
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    const args = [...(launch.args ?? []), '--mode', 'rpc', '--session', record.sessionFile, '--no-extensions', '-e', launch.extension];
    if (record.model) args.push('--provider', record.model.provider, '--model', record.model.id);
    if (record.thinking) args.push('--thinking', record.thinking);
    this.child = spawn(launch.executable, args, {
      cwd: record.cwd, windowsHide: true, stdio: 'pipe',
      env: { ...process.env, PI_CODING_AGENT_DIR: record.agentDir, PI_MANAGER_ROOT: root, PI_MANAGER_WORKER_TOKEN: token, PI_MANAGER_WORKER_ID: record.sessionId },
    });
    this.stderr = '';
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4096); });
    readFrames(this.child.stdout, event => {
      if (event.type === 'response') {
        const request = this.pending.get(event.id);
        if (request) {
          this.pending.delete(event.id);
          clearTimeout(request.timer);
          event.success === false ? request.reject(new Error(String(event.error))) : request.resolve(event.data);
        }
      }
      onEvent(event);
    }, error => { this.finish(error, onExit); this.child.kill(); });
    this.child.on('error', error => this.finish(error, onExit));
    this.child.on('exit', (code, signal) => this.finish(new Error(`Pi runtime 退出 (${code ?? signal}) ${this.stderr}`), onExit));
  }
  /** 发出命令，超时说明状态未知且不自动重发。 */
  request(command, timeout = 120_000) {
    if (this.closed) return Promise.reject(new Error('Pi worker 已关闭'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${command.type} 超时，执行状态未知`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { writeFrame(this.child.stdin, { ...command, id }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  /** 结束自己启动的 runtime；正常中断生成使用 abort RPC。 */
  close() {
    if (this.closing || this.closed) return;
    this.closing = true;
    this.child.stdin.end();
    this.killTimer = setTimeout(() => {
      if (this.closed) return;
      if (process.platform === 'win32' && this.child.pid) {
        const killer = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => this.child.kill());
      } else this.child.kill('SIGKILL');
    }, 5000);
    this.killTimer.unref();
  }
  /** 进程结束时清空 pending 并让上层释放所有权。 */
  finish(error, onExit) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.killTimer);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    onExit(error);
    this.resolveExit();
  }
}
