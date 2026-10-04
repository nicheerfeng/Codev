export type MarkdownHeading = {
  level: number;
  text: string;
  line: number;
};

/** 从 Markdown 原文提取 ATX 标题，忽略围栏代码块中的 #。 */
export function parseMarkdownHeadings(source: string): MarkdownHeading[] {
  const lines = source.split(/\r?\n/);
  const headings: MarkdownHeading[] = [];
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !fenceMatch[2].trim()
      ) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;
    const atx = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.+?))?[ \t]*#*[ \t]*$/);
    if (!atx) continue;
    const text = (atx[2] ?? "").replace(/[ \t]+#+$/, "").trim();
    if (!text) continue;
    headings.push({
      level: atx[1].length,
      text,
      line: index + 1,
    });
  }
  return headings;
}
