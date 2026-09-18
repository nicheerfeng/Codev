import { readTerminalTokens } from "@/styles/tokens";
import type { ITheme } from "@xterm/xterm";

/** 将应用配色映射到终端，并隐藏概览标尺的默认亮色边框。 */
export function buildTerminalTheme(): ITheme {
  const t = readTerminalTokens();
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selection,
    overviewRulerBorder: "transparent",
    black: t.ansiBlack,
    red: t.ansiRed,
    green: t.ansiGreen,
    yellow: t.ansiYellow,
    blue: t.ansiBlue,
    magenta: t.ansiMagenta,
    cyan: t.ansiCyan,
    white: t.ansiWhite,
    brightBlack: t.ansiBrightBlack,
    brightRed: t.ansiBrightRed,
    brightGreen: t.ansiBrightGreen,
    brightYellow: t.ansiBrightYellow,
    brightBlue: t.ansiBrightBlue,
    brightMagenta: t.ansiBrightMagenta,
    brightCyan: t.ansiBrightCyan,
    brightWhite: t.ansiBrightWhite,
  };
}
