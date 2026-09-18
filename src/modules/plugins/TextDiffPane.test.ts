import { describe, expect, it } from "vitest";
import { getNonWhitespaceRanges, tightenDiffRange } from "./TextDiffPane";

describe("text diff ranges", () => {
  it("drops leading, trailing, and pure whitespace diff content", () => {
    expect(getNonWhitespaceRanges("  add \t", 0, 7)).toEqual([
      { from: 2, to: 5 },
    ]);
    expect(getNonWhitespaceRanges(" \t\n", 0, 3)).toEqual([]);
  });

  it("keeps only the actual changed core of a broad diff range", () => {
    expect(
      tightenDiffRange("same-old-same", 0, 13, "same-new-same", 0, 13),
    ).toEqual({ from: 5, to: 8, peerFrom: 5, peerTo: 8 });
  });
});
