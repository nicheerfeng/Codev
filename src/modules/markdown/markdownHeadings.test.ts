import { describe, expect, it } from "vitest";
import { parseMarkdownHeadings } from "./markdownHeadings";

describe("parseMarkdownHeadings", () => {
  it("reads ATX levels and 1-based source lines", () => {
    expect(parseMarkdownHeadings("# Title\n\n## One\ntext\n### Two")).toEqual([
      { level: 1, text: "Title", line: 1 },
      { level: 2, text: "One", line: 3 },
      { level: 3, text: "Two", line: 5 },
    ]);
  });

  it("ignores hashes inside fenced code and empty heading marks", () => {
    const source = [
      "# Keep",
      "```md",
      "# ignored",
      "```",
      "~~~",
      "## also ignored",
      "~~~",
      "##",
      "## Real",
    ].join("\n");
    expect(parseMarkdownHeadings(source)).toEqual([
      { level: 1, text: "Keep", line: 1 },
      { level: 2, text: "Real", line: 9 },
    ]);
  });
});
