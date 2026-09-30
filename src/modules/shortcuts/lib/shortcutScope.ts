import type { ShortcutId } from "@/modules/shortcuts/shortcuts";

/** 保留快捷键作用域接口，当前没有需要按窗格数量禁用的全局快捷键。 */
export function shouldDisablePaneSwapShortcut(
  _id: ShortcutId,
  _terminalPaneCount: number | null,
): boolean {
  return false;
}
