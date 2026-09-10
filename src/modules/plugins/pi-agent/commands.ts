export const PI_LOCAL_COMMANDS = [
  { name: "compact", description: "压缩上下文，可追加压缩要求" },
  { name: "fork", description: "分叉为同名编号的新线程" },
];

/** 仅将完整的本地命令名映射为操作，其余指令继续交给 Pi。 */
export function localCommand(text: string) {
  const match = /^\/(compact|fork)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1], argument: match[2]?.trim() || "" } : null;
}
