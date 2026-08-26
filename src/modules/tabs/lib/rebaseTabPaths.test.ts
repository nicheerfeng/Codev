import { describe, expect, it } from "vitest";
import { rebaseTabPaths, type Tab } from "./useTabs";

describe("rebaseTabPaths", () => {
  it("updates editor, markdown and every terminal pane cwd", () => {
    const tabs: Tab[] = [
      {
        id: 1,
        kind: "editor",
        spaceId: "default",
        title: "a.ts",
        path: "C:/repo/src/a.ts",
        dirty: false,
        preview: false,
      },
      {
        id: 2,
        kind: "markdown",
        spaceId: "default",
        title: "readme.md",
        path: "C:/repo/readme.md",
        dirty: false,
        viewMode: "rendered",
      },
      {
        id: 3,
        kind: "terminal",
        spaceId: "default",
        title: "shell",
        cwd: "C:/repo",
        activeLeafId: 4,
        paneTree: {
          kind: "split",
          id: 6,
          dir: "row",
          children: [
            { kind: "leaf", id: 4, cwd: "C:/repo" },
            { kind: "leaf", id: 5, cwd: "C:/repo/src" },
          ],
        },
      },
    ];

    const result = rebaseTabPaths(tabs, "C:/repo", "C:/renamed");
    expect(result[0]).toMatchObject({ path: "C:/renamed/src/a.ts" });
    expect(result[1]).toMatchObject({ path: "C:/renamed/readme.md" });
    expect(result[2]).toMatchObject({
      cwd: "C:/renamed",
      paneTree: {
        children: [{ cwd: "C:/renamed" }, { cwd: "C:/renamed/src" }],
      },
    });
  });
});
