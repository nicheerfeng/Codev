import { describe, expect, it } from "vitest";
import { sandboxMode, sandboxPolicy, type SandboxPolicy } from "./sandbox";
import { sessionFromThread } from "./protocol";

describe("Codex sandbox policy", () => {
  it("defaults new session state to explicit full access", () => {
    const session = sessionFromThread({
      id: "new",
      name: null,
      preview: "",
      cwd: "D:/project",
      updatedAt: 0,
      turns: [],
    });
    expect(session.sandbox).toBe("danger-full-access");
    expect(sandboxPolicy(session.sandbox, session.thread.cwd, null)).toEqual({
      type: "dangerFullAccess",
    });
  });
  it("maps all three native levels and keeps external sandbox distinct", () => {
    expect(sandboxPolicy("read-only", "D:/project", null)).toEqual({
      type: "readOnly",
      networkAccess: false,
    });
    expect(sandboxPolicy("workspace-write", "D:/project", null)).toMatchObject({
      type: "workspaceWrite",
      writableRoots: ["D:/project"],
      networkAccess: false,
    });
    expect(sandboxPolicy("danger-full-access", "D:/project", null)).toEqual({
      type: "dangerFullAccess",
    });
    expect(
      sandboxMode({ type: "externalSandbox", networkAccess: "enabled" }),
    ).toBeNull();
  });
  it("preserves confirmed network and writable-root settings at the same level", () => {
    const policy: SandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: ["D:/project", "D:/shared"],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
    expect(sandboxPolicy("workspace-write", "D:/project", policy)).toBe(policy);
  });
});
