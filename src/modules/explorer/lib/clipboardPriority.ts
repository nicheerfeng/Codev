export type ExplorerClipboardPayload = {
  paths: string[];
  mode: "copy" | "move";
  sequence: number;
};

export type SelectedExplorerClipboard = ExplorerClipboardPayload & {
  source: "internal" | "external";
};

/** 按系统剪贴板序号选择最近发生的文件复制或剪切操作。 */
export function selectExplorerClipboard(
  internal: ExplorerClipboardPayload | null,
  system: ExplorerClipboardPayload | null,
): SelectedExplorerClipboard | null {
  if (!system) {
    return internal ? { ...internal, source: "internal" } : null;
  }
  if (internal && internal.sequence === system.sequence) {
    return { ...internal, source: "internal" };
  }
  if (system.paths.length > 0) {
    return { ...system, source: "external" };
  }
  return null;
}
