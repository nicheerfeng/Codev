import { availableParallelism, freemem } from 'node:os';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { resolve } from 'node:path';

/** 规范化显示名称，稳定寻址名称不随显示名称变化。 */
export function normalizeName(value) {
  const name = String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!name) throw new Error('name 不能为空');
  return [...name].slice(0, 60).join('');
}

/** 将标识限制为文件名安全的 Pi UUID 或消息 ID。 */
export function validId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('无效的 session/message ID');
  return value;
}

/** 未设置时按可用内存与 CPU 计算默认并发。 */
export function limits(config = {}) {
  const automatic = Math.max(1, Math.min(availableParallelism(), Math.floor(freemem() / (768 * 1024 ** 2))));
  const maxWorkers = config.maxWorkers ?? automatic;
  const maxDepth = config.maxDepth ?? 4;
  for (const [key, value] of Object.entries({ maxWorkers, maxDepth })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} 必须是正整数`);
  }
  return { maxWorkers, maxDepth };
}

/** 根据存储目录生成专用本机 IPC 地址。 */
export function endpoint(root) {
  const digest = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\pi-manager-${digest}` : `${resolve(root)}/manager.sock`;
}

/** 只按 LF 拆分 UTF-8 JSONL，保留跨分块字符及 Unicode 段落符。 */
export function readFrames(stream, onFrame, onError) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    let index;
    try {
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line) > 8 * 1024 ** 2) throw new Error('协议消息超过 8 MiB');
        if (line.trim()) onFrame(JSON.parse(line));
      }
      if (Buffer.byteLength(buffer) > 8 * 1024 ** 2) throw new Error('协议消息超过 8 MiB');
    } catch (error) { onError(error); }
  });
}

/** 写一条 JSONL 消息，连接失败通过调用方处理。 */
export function writeFrame(stream, value) {
  if (stream.destroyed || !stream.writable) throw new Error('IPC 连接已关闭');
  stream.write(`${JSON.stringify(value)}\n`);
}
