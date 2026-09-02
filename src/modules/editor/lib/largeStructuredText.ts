export const FULL_EDITOR_MAX_BYTES = 10 * 1024 * 1024;

/** 判断被完整读取上限拦截的 JSON/JSONL 是否应进入分页纯文本阅读。 */
export function shouldUseLargeStructuredTextPreview(
  path: string,
  size: number,
): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    size > FULL_EDITOR_MAX_BYTES &&
    (extension === "json" || extension === "jsonl")
  );
}
