import { describe, expect, it } from "vitest";
import { parentThread, taskFamily } from "./subagents";
import { sessionFromThread, type Thread } from "./protocol";

const thread: Thread = { id: "child", name: null, preview: "", cwd: "C:/work", updatedAt: 0, turns: [] };

describe("native subagent metadata", () => {
  // 使用本机 CLI 返回的实际字段验证父子关系和草稿键映射。
  it("attaches native camel-case metadata to a materialized draft parent", () => {
    const child = { ...thread, parentThreadId: "parent", source: { subAgent: { thread_spawn: { parent_thread_id: "parent" } } } };
    expect(parentThread(child)).toBe("parent");
    expect(parentThread({ ...thread, source: child.source })).toBe("parent");
    expect(taskFamily({ "draft:parent": sessionFromThread({ ...thread, id: "parent" }), child: sessionFromThread(child) }, "draft:parent"))
      .toEqual(["draft:parent", "child"]);
  });
  // 主会话保留根节点身份，拒绝错误的自引用。
  it("keeps roots and rejects a self-parent", () => {
    expect(parentThread(thread)).toBeNull();
    expect(parentThread({ ...thread, parentThreadId: "child" })).toBeNull();
  });
});
