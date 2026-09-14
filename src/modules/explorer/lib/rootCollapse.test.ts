import { describe, expect, it } from "vitest";
import {
  mergeNewCollapsedRoots,
  readFileTreeRootCollapsed,
  rootCollapseKey,
  writeFileTreeRootCollapsed,
} from "./rootCollapse";

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
}

describe("rootCollapseKey", () => {
  it("normalizes Windows roots without lowercasing Unix paths", () => {
    expect(rootCollapseKey("D:\\Work\\One\\")).toBe("d:/work/one");
    expect(rootCollapseKey("/Work/One")).toBe("/Work/One");
  });
});

describe("readFileTreeRootCollapsed", () => {
  it("treats a missing record as first launch", () => {
    expect(readFileTreeRootCollapsed(memory())).toEqual({
      ready: false,
      keys: new Set(),
    });
  });
});

describe("mergeNewCollapsedRoots", () => {
  it("collapses roots that have never been seen", () => {
    const result = mergeNewCollapsedRoots([], [], ["D:/one", "D:/two"]);
    expect(result.collapsed).toEqual(new Set(["d:/one", "d:/two"]));
    expect(result.changed).toBe(true);
  });

  it("does not recollapse a root the user already expanded", () => {
    const result = mergeNewCollapsedRoots([], ["d:/one"], ["D:/one", "D:/two"]);
    expect(result.collapsed.has("d:/one")).toBe(false);
    expect(result.collapsed.has("d:/two")).toBe(true);
    expect(result.changed).toBe(true);
  });
});

describe("writeFileTreeRootCollapsed", () => {
  it("round-trips collapsed roots through storage", () => {
    const store = memory();
    writeFileTreeRootCollapsed(["D:/one"], store);
    const read = readFileTreeRootCollapsed(store);
    expect(read.ready).toBe(true);
    expect([...read.keys]).toEqual(["d:/one"]);
  });
});
