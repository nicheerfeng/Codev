import { describe, expect, it } from "vitest";
import {
  findLiteralMatches,
  replaceAllLiteralMatches,
  replaceLiteralMatch,
} from "./textSearch";

describe("text search", () => {
  it("uses literal case-insensitive matching by default", () => {
    expect(
      findLiteralMatches("Start restart", "start", { caseSensitive: false }),
    ).toEqual([0, 8]);
  });

  it("replaces one selected match", () => {
    expect(
      replaceLiteralMatch(
        "a a",
        "a",
        "b",
        { caseSensitive: false },
        1,
      ),
    ).toEqual({ content: "a b", count: 1 });
  });

  it("replaces all non-overlapping matches", () => {
    expect(
      replaceAllLiteralMatches(
        "a a a",
        "a",
        "b",
        { caseSensitive: true },
      ),
    ).toEqual({ content: "b b b", count: 3 });
  });
});
