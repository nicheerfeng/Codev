import { describe, expect, it } from "vitest";
import {
  coerceFontWeight,
  coerceLocale,
  normalizeWorkspaceRoots,
} from "./store";

describe("coerceFontWeight", () => {
  it("keeps supported weights", () => {
    for (const w of ["normal", "500", "600", "bold"]) {
      expect(coerceFontWeight(w)).toBe(w);
    }
  });

  it("trims surrounding whitespace", () => {
    expect(coerceFontWeight("  bold  ")).toBe("bold");
  });

  it("falls back to normal for unsupported or empty values", () => {
    expect(coerceFontWeight("")).toBe("normal");
    expect(coerceFontWeight("900")).toBe("normal");
    expect(coerceFontWeight("heavy")).toBe("normal");
  });
});

describe("coerceLocale", () => {
  it("keeps supported locales", () => {
    expect(coerceLocale("en")).toBe("en");
    expect(coerceLocale("zh")).toBe("zh");
  });

  it("falls back to the default locale for invalid values", () => {
    expect(coerceLocale("fr")).toBe("zh");
    expect(coerceLocale(null)).toBe("zh");
  });
});

describe("normalizeWorkspaceRoots", () => {
  it("removes legacy bare drive roots while preserving project paths", () => {
    expect(
      normalizeWorkspaceRoots(["C:/", "D:\\\\", "D:/projects", "D:/projects"]),
    ).toEqual(["D:/projects"]);
  });

  it("preserves nested roots as independent projects", () => {
    expect(
      normalizeWorkspaceRoots([
        "C:/workspace",
        "C:/workspace/src",
        "C:/workspace/assets/icons",
        "D:/other",
      ]),
    ).toEqual([
      "C:/workspace",
      "C:/workspace/src",
      "C:/workspace/assets/icons",
      "D:/other",
    ]);
  });

  it("deduplicates the same root without merging parent and child roots", () => {
    expect(
      normalizeWorkspaceRoots([
        "D:/other",
        "d:/OTHER",
        "D:/other/src",
      ]),
    ).toEqual(["D:/other", "D:/other/src"]);
  });
});
