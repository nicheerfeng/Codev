/** 把 HTML 表格收成 GFM，复制时不再弹出 CSV/TSV 菜单。 */

export type MarkdownTableData = {
  headers: string[];
  rows: string[][];
};

/** 单元格里的竖线和换行会拆表，复制前先转义。 */
export function escapeMarkdownTableCell(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

function cellText(node: Element): string {
  return (node.textContent ?? "").trim();
}

/** 从当前 DOM 表抽出表头和行。没有 thead 时用第一行当表头。 */
export function readHtmlTable(table: HTMLTableElement): MarkdownTableData {
  const headCells = [
    ...table.querySelectorAll("thead th, thead td"),
  ] as Element[];
  const bodyRows = [...table.querySelectorAll("tbody tr")];
  if (headCells.length > 0) {
    return {
      headers: headCells.map(cellText),
      rows: bodyRows.map((row) =>
        [...row.querySelectorAll("th, td")].map(cellText),
      ),
    };
  }
  const allRows = [...table.querySelectorAll("tr")];
  const [first, ...rest] = allRows;
  return {
    headers: first ? [...first.querySelectorAll("th, td")].map(cellText) : [],
    rows: rest.map((row) => [...row.querySelectorAll("th, td")].map(cellText)),
  };
}

function padRow(cells: string[], width: number): string[] {
  const next = cells.slice(0, width);
  while (next.length < width) next.push("");
  return next;
}

function markdownRow(cells: string[]): string {
  return `| ${cells.map(escapeMarkdownTableCell).join(" | ")} |`;
}

/** 编成 GitHub 风格表格；空表返回空字符串。 */
export function tableDataToMarkdown(data: MarkdownTableData): string {
  const width = Math.max(
    data.headers.length,
    ...data.rows.map((row) => row.length),
    0,
  );
  if (width === 0) return "";
  const headers = padRow(data.headers, width);
  const divider = Array.from({ length: width }, () => "---");
  const rows = data.rows.map((row) => padRow(row, width));
  return [
    markdownRow(headers),
    markdownRow(divider),
    ...rows.map(markdownRow),
  ].join("\n");
}

/** 当前表格一键复制用的 Markdown 文本。 */
export function htmlTableToMarkdown(table: HTMLTableElement): string {
  return tableDataToMarkdown(readHtmlTable(table));
}
