/** 清除 Pi 扩展状态里的终端颜色和超链接控制序列，保留正文。 */
export function plainStatusText(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .trim();
}
