import type { IDisposable, Terminal } from "@xterm/xterm";

/** 输出解析后同步底部滑块；用户上翻时保留历史阅读位置。 */
export function followTerminalOutput(term: Terminal): IDisposable {
  let following = true;
  let frame: number | null = null;
  const scroll = term.onScroll(() => {
    const buffer = term.buffer.active;
    if (buffer.type === "normal") {
      following = buffer.viewportY === buffer.baseY;
    }
  });
  const parsed = term.onWriteParsed(() => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const buffer = term.buffer.active;
      if (following && buffer.type === "normal") {
        // 等待 xterm 更新滚动尺寸，再滚到最大值，避免视口已到底而滑块滞后。
        term.scrollLines(buffer.length);
      }
    });
  });
  return {
    // 释放槽位时同步取消待执行的滚动。
    dispose() {
      scroll.dispose();
      parsed.dispose();
      if (frame !== null) cancelAnimationFrame(frame);
    },
  };
}
