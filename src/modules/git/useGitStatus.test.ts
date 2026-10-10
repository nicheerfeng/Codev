import { beforeEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => transport);
import { readGitStatus, invalidateGitStatus } from "./useGitStatus";
import type { GitSnapshot } from "./native";

const state: GitSnapshot = {
  repo: { root: "D:/project", name: "project", branch: "main", changes: 0 },
  changes: [],
  empty: false,
};

describe("root Git cache", () => {
  beforeEach(() => {
    transport.invoke.mockReset();
    invalidateGitStatus("D:/project");
  });
  it("shares in-flight reads and reuses state when reopening the panel", async () => {
    transport.invoke.mockResolvedValue(state);
    const first = readGitStatus("D:/project");
    const second = readGitStatus("D:/project");
    expect(first).toBe(second);
    expect(await first).toEqual(state);
    expect(await readGitStatus("D:/project")).toEqual(state);
    expect(transport.invoke).toHaveBeenCalledTimes(1);
    expect(transport.invoke).toHaveBeenCalledWith("git_snapshot", {
      root: "D:/project",
    });
  });
  it("reads again after write invalidation without fetching remotes", async () => {
    transport.invoke.mockResolvedValue(state);
    await readGitStatus("D:/project");
    invalidateGitStatus("D:/project");
    await readGitStatus("D:/project");
    expect(transport.invoke).toHaveBeenCalledTimes(2);
    expect(
      transport.invoke.mock.calls.every(
        ([command]) => command === "git_snapshot",
      ),
    ).toBe(true);
  });
});
