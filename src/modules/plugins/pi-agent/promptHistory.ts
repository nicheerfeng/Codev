import type { PiTranscriptItem } from "./types";

export const PROMPT_HISTORY_LIMIT = 100;

/** 从当前线程 transcript 抽出用户输入，最新在前。 */
export function userPromptTexts(items: PiTranscriptItem[]): string[] {
  const texts: string[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind !== "message" || item.role !== "user") continue;
    const text = item.text.trim();
    if (text) texts.push(text);
  }
  return compactPromptHistory(texts);
}

/** 去掉空串和相邻重复，截到上限。 */
export function compactPromptHistory(texts: string[]): string[] {
  const compacted: string[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (!text || compacted[compacted.length - 1] === text) continue;
    compacted.push(text);
    if (compacted.length >= PROMPT_HISTORY_LIMIT) break;
  }
  return compacted;
}

/** 把刚提交的文本插到列表头；与当前最新相同则跳过。 */
export function prependPrompt(history: string[], text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return history;
  if (history[0] === trimmed) return history;
  return [trimmed, ...history].slice(0, PROMPT_HISTORY_LIMIT);
}

/**
 * 本地刚提交的条目优先，再叠 transcript。
 * submitted 若已是 transcript 前缀（水合追上）则丢掉这段前缀。
 */
export function mergePromptHistory(
  submitted: string[],
  items: PiTranscriptItem[],
): string[] {
  const extras = compactPromptHistory(submitted);
  const fromItems = userPromptTexts(items);
  for (let skip = 0; skip <= extras.length; skip += 1) {
    const tail = extras.slice(skip);
    if (tail.every((text, index) => fromItems[index] === text))
      return compactPromptHistory([...extras.slice(0, skip), ...fromItems]);
  }
  return compactPromptHistory([...extras, ...fromItems]);
}

export function textareaCaret(
  value: string,
  caret: number,
): { line: number; column: number; lineCount: number } {
  const clamped = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, clamped);
  const line = before.split("\n").length - 1;
  const column = clamped - (before.lastIndexOf("\n") + 1);
  return { line, column, lineCount: value.split("\n").length };
}

/** 是否该用 ↑ 回写更早的一条，而不是移动光标。 */
export function shouldRecallPrevious(options: {
  showCommands: boolean;
  browsing: boolean;
  text: string;
  caret: number;
}): boolean {
  if (options.showCommands) return false;
  const { line, column } = textareaCaret(options.text, options.caret);
  if (line !== 0) return false;
  return options.text.length === 0 || options.browsing || column === 0;
}

/** 是否该用 ↓ 回到更新的一条或草稿。 */
export function shouldRecallNext(options: {
  showCommands: boolean;
  browsing: boolean;
  text: string;
  caret: number;
}): boolean {
  if (options.showCommands || !options.browsing) return false;
  const { line, lineCount } = textareaCaret(options.text, options.caret);
  return line === lineCount - 1;
}

/**
 * 浏览下标：-1 表示未浏览。direction 与 Pi TUI 相同，-1 为更早。
 * 越界返回 null。
 */
export function nextHistoryIndex(
  current: number,
  direction: -1 | 1,
  length: number,
): number | null {
  if (length === 0) return null;
  const next = current - direction;
  if (next < -1 || next >= length) return null;
  return next;
}
