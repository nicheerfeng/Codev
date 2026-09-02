import { describe, expect, it } from "vitest";
import { selectExplorerClipboard } from "./clipboardPriority";

describe("selectExplorerClipboard", () => {
  it("uses multiple external files copied after an internal operation", () => {
    expect(
      selectExplorerClipboard(
        { paths: ["D:/old.md"], mode: "copy", sequence: 10 },
        {
          paths: ["C:/one.md", "C:/two.md"],
          mode: "copy",
          sequence: 11,
        },
      ),
    ).toMatchObject({
      paths: ["C:/one.md", "C:/two.md"],
      mode: "copy",
      source: "external",
    });
  });

  it("uses an internal operation performed after the current system clipboard", () => {
    expect(
      selectExplorerClipboard(
        { paths: ["D:/new.md"], mode: "copy", sequence: 11 },
        { paths: ["C:/old.md"], mode: "copy", sequence: 11 },
      ),
    ).toMatchObject({ paths: ["D:/new.md"], source: "internal" });
  });

  it("does not reuse stale internal files after external text replaces the clipboard", () => {
    expect(
      selectExplorerClipboard(
        { paths: ["D:/stale.md"], mode: "copy", sequence: 11 },
        { paths: [], mode: "copy", sequence: 12 },
      ),
    ).toBeNull();
  });

  it("preserves an external cut operation", () => {
    expect(
      selectExplorerClipboard(null, {
        paths: ["C:/move-me"],
        mode: "move",
        sequence: 13,
      }),
    ).toMatchObject({ mode: "move", source: "external" });
  });
});
