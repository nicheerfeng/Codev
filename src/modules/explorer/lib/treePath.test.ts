import { describe, expect, it } from "vitest";
import {
  closestLoadedTreePath,
  findLoadedTreePath,
  normalizeTreePath,
  parentTreePath,
} from "./treePath";

describe("file tree path alignment", () => {
  it("normalizes slashes, verbatim prefixes, and Windows case", () => {
    expect(normalizeTreePath("C:\\Users\\79988\\Desktop\\")).toBe(
      "c:/users/79988/desktop",
    );
    expect(normalizeTreePath("//?/C:/Users/79988/Desktop/file.txt")).toBe(
      "c:/users/79988/desktop/file.txt",
    );
    expect(normalizeTreePath("/Work/One")).toBe("/Work/One");
  });

  it("keeps the drive root when taking a parent path", () => {
    expect(parentTreePath("C:/Users/79988/Desktop/copy.txt")).toBe(
      "c:/users/79988/desktop",
    );
    expect(parentTreePath("C:/file.txt")).toBe("c:/");
  });

  it("matches loaded parents even when watcher casing differs", () => {
    const nodes = {
      "C:/Users/79988/Desktop": { status: "loaded" },
    };
    expect(findLoadedTreePath(nodes, "c:/users/79988/desktop")).toBe(
      "C:/Users/79988/Desktop",
    );
    expect(
      closestLoadedTreePath(
        nodes,
        "C:\\Users\\79988\\Desktop\\iris-copy.csv",
        "C:/Users/79988/Desktop",
      ),
    ).toBe("C:/Users/79988/Desktop");
  });
});
