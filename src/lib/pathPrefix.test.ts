import { describe, expect, it } from "vitest";
import { replacePathPrefix } from "./pathPrefix";

describe("replacePathPrefix", () => {
  it("rebases the path itself and its descendants", () => {
    expect(replacePathPrefix("C:/repo", "C:/repo", "C:/renamed")).toBe(
      "C:/renamed",
    );
    expect(replacePathPrefix("C:/repo/src/a.ts", "C:/repo", "C:/renamed")).toBe(
      "C:/renamed/src/a.ts",
    );
  });

  it("does not rebase similarly prefixed siblings", () => {
    expect(replacePathPrefix("C:/repo-old/a.ts", "C:/repo", "C:/new")).toBe(
      "C:/repo-old/a.ts",
    );
  });
});
