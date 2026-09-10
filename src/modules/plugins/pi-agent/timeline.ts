import type { PiTranscriptItem } from "./types";

export type PiTimelineBlock =
  | { id: string; kind: "item"; item: PiTranscriptItem }
  | {
      id: string;
      kind: "process";
      items: PiTranscriptItem[];
      running: boolean;
    };

/** 参考 Zeno：同一用户 turn 聚合思考、工具和中间叙述，最后回复独立呈现。 */
export function buildTimelineBlocks(
  items: PiTranscriptItem[],
  running: boolean,
): PiTimelineBlock[] {
  const blocks: PiTimelineBlock[] = [];
  let turn: PiTranscriptItem[] = [];
  /** 将一轮执行记录折叠到一个过程块中。 */
  const flush = (open: boolean) => {
    if (!turn.length) return;
    const last = turn[turn.length - 1];
    const final =
      last.kind === "message" && last.role === "assistant" ? last : null;
    const steps = final ? turn.slice(0, -1) : turn;
    if (steps.length)
      blocks.push({
        id: `process-${steps[0].id}`,
        kind: "process",
        items: steps,
        running: open,
      });
    if (final) blocks.push({ id: final.id, kind: "item", item: final });
    turn = [];
  };
  for (const item of items) {
    if (item.kind === "message" && item.role === "user") {
      flush(false);
      blocks.push({ id: item.id, kind: "item", item });
    } else turn.push(item);
  }
  flush(running);
  return blocks;
}

/** 提取完整搜索文本，包括折叠过程里的参数和输出。 */
export function itemText(item: PiTranscriptItem): string {
  return item.kind === "tool"
    ? `${item.name}\n${JSON.stringify(item.args)}\n${item.output}`
    : item.text;
}
