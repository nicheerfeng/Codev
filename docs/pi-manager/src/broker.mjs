import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { Channel, accessToken } from './ipc.mjs';
import { endpoint } from './common.mjs';
import { ManagerService } from './service.mjs';

/** 启动当前用户专属 IPC 服务，协议校验后才允许注册或执行。 */
export async function startBroker(root, options = {}) {
  const token = accessToken(root);
  const service = new ManagerService(root, options);
  const channels = new Set();
  const server = net.createServer(socket => {
    let authenticated = false;
    const channel = new Channel(socket, async (method, args, signal) => {
      if (method === 'hello') {
        const candidate = Buffer.from(String(args.token ?? ''));
        const expected = Buffer.from(token);
        if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected) || args.version !== 1) throw new Error('IPC 认证或协议版本不匹配');
        authenticated = true;
        return { version: 1, pid: process.pid };
      }
      if (!authenticated) throw new Error('IPC 未认证');
      if (method === 'register') return service.register(channel, args);
      if (method === 'unregister') { service.unregister(channel, true); return { accepted: true }; }
      if (method === 'event') {
        if (!channel.sessionId) throw new Error('尚未注册');
        if (!service.workers.has(channel.sessionId) || ['model_select', 'thinking_level_select'].includes(args.type)) service.workerEvent(channel.sessionId, args);
        return { accepted: true };
      }
      return service.execute(channel, method, args, signal);
    });
    channels.add(channel);
    socket.on('close', () => { channels.delete(channel); service.unregister(channel); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint(root), resolve); });
  /** 停止本服务与本服务拥有的子进程，不触碰其他 Pi。 */
  const close = async () => {
    clearInterval(idle);
    service.closing = true;
    for (const channel of channels) channel.close();
    await service.close();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => server.close(resolve));
  };
  let emptySince = Date.now();
  const idle = setInterval(() => {
    if (channels.size || service.workers.size) emptySince = Date.now();
    else if (Date.now() - emptySince > (options.idleMs ?? 15_000)) void close();
  }, 1000);
  idle.unref();
  return { service, server, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBroker(resolve(process.argv[2])).then(broker => {
    process.once('SIGTERM', () => void broker.close());
    process.once('SIGINT', () => void broker.close());
  }).catch(error => { if (error.code !== 'EADDRINUSE') console.error(error); process.exitCode = error.code === 'EADDRINUSE' ? 0 : 1; });
}
