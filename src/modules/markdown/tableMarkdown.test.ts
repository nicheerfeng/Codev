import { describe, expect, it } from "vitest";
import { escapeMarkdownTableCell, tableDataToMarkdown } from "./tableMarkdown";

describe("markdown table copy", () => {
  it("escapes pipes and line breaks inside cells", () => {
    expect(escapeMarkdownTableCell("a|b")).toBe("a\\|b");
    expect(escapeMarkdownTableCell("a\nb")).toBe("a<br>b");
  });

  it("serializes headers and rows as GFM", () => {
    expect(
      tableDataToMarkdown({
        headers: ["药", "状态"],
        rows: [
          ["A", "上市"],
          ["B|C", "临床"],
        ],
      }),
    ).toBe(
      [
        "| 药 | 状态 |",
        "| --- | --- |",
        "| A | 上市 |",
        "| B\\|C | 临床 |",
      ].join("\n"),
    );
  });

  it("pads short rows so the copied table stays aligned", () => {
    expect(
      tableDataToMarkdown({
        headers: ["a", "b", "c"],
        rows: [["1"]],
      }),
    ).toBe("| a | b | c |\n| --- | --- | --- |\n| 1 |  |  |");
  });
});
