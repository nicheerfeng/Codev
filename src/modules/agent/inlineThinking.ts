const OPEN = "<think>";
const CLOSE = "</think>";

function withoutPartialClose(text: string): string {
  for (let size = Math.min(text.length, CLOSE.length - 1); size > 0; size--) {
    if (CLOSE.startsWith(text.slice(-size).toLowerCase())) {
      return text.slice(0, -size);
    }
  }
  return text;
}

/** Split leading `<think>...</think>` blocks emitted inside assistant text cleanly. */
export function splitInlineThinking(
  text: string,
  existingThinking: string,
  streaming: boolean,
): { thinking: string; text: string } {
  if (existingThinking || !text) {
    return { thinking: existingThinking, text };
  }
  const trimmed = text.trimStart();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith(OPEN)) {
    if (streaming && OPEN.startsWith(lower)) {
      return { thinking: "", text: "" };
    }
    return { thinking: "", text };
  }
  const end = lower.indexOf(CLOSE, OPEN.length);
  const inside = end < 0 ? trimmed.slice(OPEN.length) : trimmed.slice(OPEN.length, end);
  return {
    thinking: streaming && end < 0 ? withoutPartialClose(inside) : inside,
    text: end < 0 ? "" : trimmed.slice(end + CLOSE.length).trimStart(),
  };
}
