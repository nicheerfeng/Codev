import type { PiTranscriptItem } from "./types";

/** 只判断是否有可显示正文，不解码签名、不把对象或密文当作思考内容。 */
export function hasVisibleTranscriptText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /[^\s\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFFD]/u.test(value)
  );
}

/** 过滤展示噪声，不修改原始 items，避免改变流式 contentIndex 和消息归属。 */
export function isVisibleTimelineItem(item: PiTranscriptItem): boolean {
  if (item.kind === "thinking") return hasVisibleTranscriptText(item.text);
  if (item.kind === "message" && item.role === "assistant") {
    return hasVisibleTranscriptText(item.text) || Boolean(item.images?.length);
  }
  return true;
}
