import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { endpoint, readFrames, writeFrame } from './common.mjs';

/** 双向请求通道，连接关闭时立即拒绝所有悬挂请求。 */
export class Channel {
  /** 接收请求与响应，不在响应处理器中阻塞其他命令。 */
  constructor(socket, handler) {
    this.socket = socket;
    this.pending = new Map();
    this.incoming = new Map();
    readFrames(socket, frame => {
      if (frame.cancel) { this.incoming.get(frame.cancel)?.abort(); return; }
      if (frame.response) {
        const item = this.pending.get(frame.response);
        if (!item) return;
        item.cleanup();
        frame.error ? item.reject(new Error(frame.error)) : item.resolve(frame.result);
      } else if (frame.id && frame.method) {
        const controller = new AbortController();
        this.incoming.set(frame.id, controller);
        void Promise.resolve().then(() => handler(frame.method, frame.args, controller.signal)).then(
          result => { if (!socket.destroyed) writeFrame(socket, { response: frame.id, result }); },
          error => { if (!socket.destroyed) writeFrame(socket, { response: frame.id, error: String(error.message ?? error) }); },
        ).finally(() => this.incoming.delete(frame.id));
      }
    }, error => socket.destroy(error));
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const item of this.pending.values()) { item.cleanup(); item.reject(new Error('IPC 已断开，未确认的操作状态未知')); }
      for (const controller of this.incoming.values()) controller.abort();
      this.incoming.clear();
    });
  }
  /** 限时发出请求，取消只取消等待，不自动重复业务动作。
   * @param {string} method
   * @param {any} args
   * @param {{timeout?: number, signal?: AbortSignal}} options
   */
  call(method, args = {}, { timeout = 120_000, signal } = {}) {
    if (signal?.aborted) return Promise.reject(new Error('请求已取消'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      /** 清理请求的定时器与取消监听。 */
      const cleanup = () => { clearTimeout(timer); this.pending.delete(id); signal?.removeEventListener('abort', abort); };
      /** 告知服务停止本次等待，避免残留订阅。 */
      const abort = () => { cleanup(); if (!this.socket.destroyed) writeFrame(this.socket, { cancel: id }); reject(new Error('请求已取消')); };
      const timer = setTimeout(() => { cleanup(); if (!this.socket.destroyed) writeFrame(this.socket, { cancel: id }); reject(new Error(`${method} 超时，执行状态未知`)); }, timeout);
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      try { writeFrame(this.socket, { id, method, args }); }
      catch (error) { cleanup(); reject(error); }
    });
  }
  /** 断开自己持有的连接。 */
  close() { this.socket.destroy(); }
}

/** 建立仅限本机的 pipe/socket 连接。 */
export function connectSocket(root) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint(root));
    socket.once('error', reject);
    socket.once('connect', () => { socket.off('error', reject); resolve(socket); });
  });
}

/** 获取本用户数据目录内的连接凭据，不暴露到工具输出。 */
export function accessToken(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, 'ipc-token');
  try { writeFileSync(file, randomUUID(), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return readFileSync(file, 'utf8');
}

/** 启动包内 broker；其他项目、扩展、node_modules 私有路径均不参与。 */
export async function connectManager(root, handler, options = {}) {
  const token = accessToken(root);
  let socket;
  try { socket = await connectSocket(root); }
  catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    if (process.platform !== 'win32' && existsSync(endpoint(root))) unlinkSync(endpoint(root));
    const child = spawn(process.execPath, [fileURLToPath(new URL('./broker.mjs', import.meta.url)), root], {
      detached: true, windowsHide: true, stdio: 'ignore',
    });
    let failure;
    child.once('error', error => { failure = error; });
    child.unref();
    const deadline = Date.now() + 10_000;
    while (!socket && Date.now() < deadline) {
      if (failure) throw failure;
      await new Promise(resolve => setTimeout(resolve, 50));
      try { socket = await connectSocket(root); }
      catch (retry) { if (!['ENOENT', 'ECONNREFUSED'].includes(retry.code)) throw retry; }
    }
    if (!socket) throw new Error('pi-manager broker 启动超时');
  }
  const channel = new Channel(socket, handler);
  try { await channel.call('hello', { token, version: 1 }); }
  catch (error) { channel.close(); throw error; }
  if (options.onClose) socket.once('close', options.onClose);
  return channel;
}
