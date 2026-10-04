import { describe, expect, it } from "vitest";
import { mergeNewCollapsedKeys } from "./sidebarCollapse";

describe("mergeNewCollapsedKeys", () => {
  it("collapses keys that have never been seen", () => {
    const result = mergeNewCollapsedKeys([], [], ["group:", "project:a"]);
    expect([...result.collapsed]).toEqual(["group:", "project:a"]);
    expect(result.changed).toBe(true);
  });

  it("does not recollapse a group the user already expanded", () => {
    const result = mergeNewCollapsedKeys(
      ["project:a"],
      ["group:", "project:a"],
      ["group:", "project:a", "project:b"],
    );
    expect(result.collapsed.has("group:")).toBe(false);
    expect(result.collapsed.has("project:b")).toBe(true);
    expect(result.changed).toBe(true);
  });
});
