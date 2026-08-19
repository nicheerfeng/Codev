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

  it("removes nested roots when their parent is already imported", () => {
    expect(
      normalizeWorkspaceRoots([
        "C:/workspace",
        "C:/workspace/src",
        "C:/workspace/assets/icons",
        "D:/other",
      ]),
    ).toEqual(["C:/workspace", "D:/other"]);
  });
});
