import { describe, expect, it } from "vitest";
import { buildCommitGraphLayout } from "./CommitGraph";
import { mergeConflictAcceptBoth, parseUnifiedHunks } from "./hunks";
import { uiState } from "@/lib/uiState";
import {
  buildRepoBadgeIndex,
  findSnapshotForPath,
} from "./store";
import { forgeCommentsCacheKey, useForgeStore } from "@/modules/forge/store";
import { parseVcsError, type VcsCommit, type VcsSnapshot } from "./types";

describe("VCS frontend utilities", () => {
  it("parses structured [vcs:Code] error messages", () => {
    expect(
      parseVcsError(
        new Error("[vcs:MissingAuthorIdentity] 尚未配置 Git 提交姓名或邮箱（去配置）"),
      ),
    ).toEqual({
      code: "MissingAuthorIdentity",
      message: "尚未配置 Git 提交姓名或邮箱（去配置）",
    });
    expect(parseVcsError("plain error")).toEqual({
      code: null,
      message: "plain error",
    });
  });

  it("indexes file badges and bubbles conflict tone to ancestor directories", () => {
    const snap: VcsSnapshot = {
      snapshotId: 1,
      worktreeRoot: "D:/repo/app",
      commonGitDir: "D:/repo/app/.git",
      isWorktree: false,
      repoName: "app",
      repoState: "Merging",
      headOid: "abc123",
      branch: "main",
      detached: false,
      empty: false,
      ahead: 1,
      behind: 0,
      counts: { staged: 0, modified: 1, untracked: 0, conflicted: 1 },
      entries: [
        {
          path: "src/a.ts",
          indexStatus: " ",
          worktreeStatus: "M",
          staged: false,
          unstaged: true,
          untracked: false,
          conflicted: false,
        },
        {
          path: "src/deep/c.ts",
          indexStatus: "U",
          worktreeStatus: "U",
          staged: false,
          unstaged: false,
          untracked: false,
          conflicted: true,
        },
      ],
      remotes: [],
      authorConfigured: true,
      truncated: false,
    };

    const idx = buildRepoBadgeIndex(snap)!;
    expect(idx.files.get("d:/repo/app/src/a.ts")?.code).toBe("M");
    expect(idx.files.get("d:/repo/app/src/deep/c.ts")?.code).toBe("!");
    expect(idx.dirs.get("d:/repo/app/src")).toBe("conflict");
    expect(idx.dirs.get("d:/repo/app/src/deep")).toBe("conflict");

    const found = findSnapshotForPath({ "d:/repo/app": snap }, "D:\\repo\\app\\src\\a.ts");
    expect(found?.repoName).toBe("app");
  });

  it("splits unified diff hunks and merges conflict both sides", () => {
    const patch = [
      "diff --git a/foo.ts b/foo.ts",
      "index 111..222 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,2 +1,3 @@",
      " const a = 1;",
      "+const b = 2;",
      " const c = 3;",
      "@@ -10,2 +11,2 @@",
      "-const x = 1;",
      "+const x = 9;",
    ].join("\n");

    const parsed = parseUnifiedHunks(patch);
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[0].additions).toBe(1);
    expect(parsed.hunks[1].deletions).toBe(1);
    expect(parsed.hunks[1].patch).toContain("diff --git a/foo.ts b/foo.ts");

    expect(mergeConflictAcceptBoth("ours\n", "theirs\n")).toBe("ours\ntheirs\n");
  });

  it("assigns commit graph lanes for forks and merge commits", () => {
    const commits: VcsCommit[] = [
      {
        hash: "c3",
        shortHash: "c3",
        parents: ["c2", "c1b"],
        subject: "Merge feat",
        body: "",
        author: "A",
        email: "a@b",
        timestamp: 3,
        dateDisplay: "1m",
        refs: [{ label: "HEAD -> main", kind: "head" }],
      },
      {
        hash: "c2",
        shortHash: "c2",
        parents: ["c1"],
        subject: "Main work",
        body: "",
        author: "A",
        email: "a@b",
        timestamp: 2,
        dateDisplay: "2m",
        refs: [],
      },
      {
        hash: "c1b",
        shortHash: "c1b",
        parents: ["c1"],
        subject: "Feat work",
        body: "",
        author: "B",
        email: "b@b",
        timestamp: 2,
        dateDisplay: "3m",
        refs: [],
      },
      {
        hash: "c1",
        shortHash: "c1",
        parents: [],
        subject: "Init",
        body: "",
        author: "A",
        email: "a@b",
        timestamp: 1,
        dateDisplay: "4m",
        refs: [],
      },
    ];

    const layout = buildCommitGraphLayout(commits);
    expect(layout.rows).toHaveLength(4);
    expect(layout.maxLanes).toBeGreaterThanOrEqual(2);
    expect(layout.rows[0].edges.some((e) => e.isMerge)).toBe(true);
  });

  it("caches active forge repo and inboxes into uiState and hydrates cleanly", () => {
    expect(
      forgeCommentsCacheKey({ repoFullName: "Nicheerfeng/Trade-Pharma" }, 16),
    ).toBe("nicheerfeng/trade-pharma#16");

    useForgeStore.getState().setActiveInboxRepo("nicheerfeng/trade-pharma");
    useForgeStore.getState().applyForgeInbox({
      repo: {
        provider: "github",
        host: "github.com",
        owner: "nicheerfeng",
        repo: "trade-pharma",
        fullName: "nicheerfeng/trade-pharma",
      },
      auth: {
        source: "pat",
        authenticated: true,
        login: "nicheerfeng",
        hasSavedPat: true,
        ghInstalled: true,
      },
      notifications: [],
      issues: [],
      pulls: [],
      unreadCount: 0,
      lastSyncedAt: 1700000000,
    });

    expect(uiState.getItem("codev.forge.activeRepo")).toBe(
      "nicheerfeng/trade-pharma",
    );
    expect(uiState.getItem("codev.forge.inboxes")).toContain(
      "nicheerfeng/trade-pharma",
    );

    useForgeStore.setState({ activeInboxRepo: null, inboxes: {} });
    useForgeStore.getState().hydrateForgeCache();
    expect(useForgeStore.getState().activeInboxRepo).toBe(
      "nicheerfeng/trade-pharma",
    );
    expect(
      useForgeStore.getState().inboxes["nicheerfeng/trade-pharma"]?.repo?.fullName,
    ).toBe("nicheerfeng/trade-pharma");
  });
});
