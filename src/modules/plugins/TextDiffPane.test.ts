import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getNonWhitespaceRanges, tightenDiffRange } from "./TextDiffPane";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "TextDiffPane.tsx"), "utf8");
const appSource = readFileSync(path.join(here, "../../app/App.tsx"), "utf8");

describe("TextDiffPane", () => {
  it("creates two independent editable CodeMirror panes", () => {
    expect(source).not.toMatch(/MergeView/);
    expect(source.match(/<CodeMirror/g)).toHaveLength(2);
    expect(source).toMatch(/value={leftText}/);
    expect(source).toMatch(/value={rightText}/);
    expect(source).toMatch(/onChange={setLeftText}/);
    expect(source).toMatch(/onChange={setRightText}/);
  });

  it("provides independent half-width search boxes for both panes", () => {
    expect(source.match(/<DiffSearchBox/g)).toHaveLength(2);
    expect(source).toMatch(/leftQuery/);
    expect(source).toMatch(/rightQuery/);
    expect(source).toMatch(/w-1\/2 max-w-\[50%\]/);
    expect(source).toMatch(/label="原文"/);
    expect(source).toMatch(/label="对照文本"/);
  });

  it("keeps pure diff calculation and decorations on both sides", () => {
    expect(source).toMatch(/diff\(/);
    expect(source).toMatch(/ViewPlugin\.fromClass/);
    expect(source).toMatch(/codev-diff-changed-text/);
    expect(source).toMatch(/getNonWhitespaceRanges/);
    expect(source).not.toMatch(/Decoration\.line/);
  });

  it("keeps side-specific colors on nested diff text", () => {
    const styles = readFileSync(
      path.join(here, "../../styles/globals.css"),
      "utf8",
    );
    expect(styles).toMatch(/codev-diff-left-changed-text \*/);
    expect(styles).toMatch(/codev-diff-right-changed-text \*/);
  });

  it("drops leading, trailing, and pure whitespace diff content", () => {
    expect(getNonWhitespaceRanges("  add \t", 0, 7)).toEqual([
      { from: 2, to: 5 },
    ]);
    expect(getNonWhitespaceRanges(" \t\n", 0, 3)).toEqual([]);
  });

  it("keeps only the actual changed core of a broad diff range", () => {
    expect(
      tightenDiffRange(
        "same-old-same",
        0,
        13,
        "same-new-same",
        0,
        13,
      ),
    ).toEqual({ from: 5, to: 8, peerFrom: 5, peerTo: 8 });
  });

  it("keeps JSON and text diff tool tabs mutually exclusive", () => {
    expect(appSource).toMatch(
      /rightDockView === "tools" && toolView === "json"/,
    );
    expect(appSource).toMatch(
      /rightDockView === "tools" && toolView === "diff"/,
    );
  });
});
