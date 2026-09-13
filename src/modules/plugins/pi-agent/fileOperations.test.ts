import { expect, it } from "vitest";
import { collectFileOperations } from "./fileOperations";
import type { PiToolItem } from "./types";

/** 构造明确状态的工具记录。 */
function tool(name: string, args: unknown, status: PiToolItem["status"] = "done"): PiToolItem {
  return { id: name, toolCallId: name, kind: "tool", name, args, status, output: "" };
}

it("聚合成功文件操作，保留跨项目路径并排除失败与脚本猜测", () => {
  expect(collectFileOperations([
    tool("edit", { path: "src/a.ts" }),
    tool("edit", { path: "./src/a.ts" }),
    tool("write", { path: "D:\\other\\b.md" }),
    tool("edit", { path: "failed.ts" }, "error"),
    tool("bash", { command: "rm unknown.txt" }),
    tool("apply_patch", { patch: "*** Delete File: old.txt\n*** Add File: new.txt\n" }),
  ], "D:/project")).toEqual([
    { path: "D:/project/src/a.ts", operation: "修改" },
    { path: "D:/other/b.md", operation: "写入" },
    { path: "D:/project/old.txt", operation: "删除" },
    { path: "D:/project/new.txt", operation: "新增" },
  ]);
});
