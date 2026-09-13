import type { PiTranscriptItem } from "./types";

export type FileOperation = { path: string; operation: "修改" | "写入" | "新增" | "删除" };

/** 按线程目录解析工具路径，归一分隔符及相对路径段。 */
function resolveFilePath(path: string, cwd: string): string {
  const value = path.replace(/\\/g, "/");
  const full = /^(?:[A-Za-z]:\/|\/)/.test(value) ? value : `${cwd.replace(/\\/g, "/")}/${value}`;
  const prefix = full.startsWith("//") ? "//" : full.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of full.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && !parts[parts.length - 1].endsWith(":")) parts.pop();
    else if (part !== "..") parts.push(part);
  }
  return prefix + parts.join("/");
}

/** 从成功的明确文件工具及标准补丁提取清单，同路径按最后操作去重。 */
export function collectFileOperations(items: PiTranscriptItem[], cwd: string): FileOperation[] {
  const files = new Map<string, FileOperation>();
  /** 记录一条已确认的文件操作。 */
  const add = (path: string, operation: FileOperation["operation"]) => {
    if (!path.trim()) return;
    const resolved = resolveFilePath(path.trim(), cwd);
    const key = /^(?:[A-Za-z]:|\/\/)/.test(resolved) ? resolved.toLowerCase() : resolved;
    files.set(key, { path: resolved, operation });
  };
  for (const item of items) {
    if (item.kind !== "tool" || item.status !== "done") continue;
    const args = item.args && typeof item.args === "object" ? item.args as Record<string, unknown> : {};
    const path = args.path ?? args.file_path;
    const operation = ({ edit: "修改", write: "写入", delete_file: "删除", remove_file: "删除" } as const)[item.name as "edit" | "write" | "delete_file" | "remove_file"];
    if (operation && typeof path === "string") add(path, operation);
    if (item.name !== "apply_patch") continue;
    const patch = typeof item.args === "string" ? item.args : args.patch ?? args.input;
    if (typeof patch !== "string") continue;
    for (const match of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)\r?$/gm)) {
      add(match[2], match[1] === "Add" ? "新增" : match[1] === "Delete" ? "删除" : "修改");
    }
  }
  return [...files.values()];
}
