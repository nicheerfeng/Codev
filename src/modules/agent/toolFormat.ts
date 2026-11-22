import type { AgentMessage } from "./types";

export type ToolCategory =
  | "read"
  | "search"
  | "list"
  | "edit"
  | "write"
  | "command"
  | "web"
  | "subagent"
  | "other";

export type DiffLine = {
  kind: "meta" | "add" | "del" | "ctx";
  text: string;
};

export type DiffSummary = {
  adds: number;
  dels: number;
  lines: DiffLine[];
  rawPatch: string;
  path?: string;
};

export type DescribedTool = {
  category: ToolCategory;
  badge: string;
  title: string;
  target: string;
  commandText?: string;
  isGrepEmpty: boolean;
  diff: DiffSummary | null;
  paths: string[];
};

export type TurnFileChange = {
  path: string;
  operation: "新增" | "修改" | "写入" | "删除";
  adds: number;
  dels: number;
  diffText: string | null;
};

const TOOL_LABELS: Record<ToolCategory, string> = {
  read: "读取",
  search: "搜索",
  list: "列表",
  edit: "修改",
  write: "写入",
  command: "命令",
  web: "网络",
  subagent: "子代理",
  other: "工具",
};

function baseName(name: string): string {
  return name.split(/[.:/]/u).pop()?.toLowerCase() ?? name.toLowerCase();
}

export function normalizeToolCategory(
  toolName: string,
  toolKind?: string,
): ToolCategory {
  const k = (toolKind ?? "").toLowerCase();
  if (k === "read") return "read";
  if (k === "edit" || k === "delete") return "edit";
  if (k === "execute") return "command";
  if (k === "search") return "search";
  if (k === "fetch" || k === "web") return "web";

  const n = baseName(toolName);
  if (
    ["read", "read_file", "view_file", "view_file_outline", "view_code_item", "cat"].includes(
      n,
    )
  )
    return "read";
  if (
    [
      "grep",
      "grep_search",
      "ripgrep",
      "rg",
      "find_by_name",
      "glob",
      "search",
      "symbol_search",
      "search_files",
    ].includes(n)
  )
    return "search";
  if (["list_dir", "ls", "list", "tree"].includes(n)) return "list";
  if (
    [
      "edit",
      "replace_file_content",
      "multi_replace_file_content",
      "apply_patch",
      "delete_file",
      "remove_file",
      "delete",
    ].includes(n)
  )
    return "edit";
  if (["write", "write_file", "write_to_file", "create_file"].includes(n))
    return "write";
  if (
    [
      "bash",
      "sh",
      "exec",
      "execute",
      "run_command",
      "command_status",
      "shell",
      "terminal",
    ].includes(n)
  )
    return "command";
  if (["web_search", "web_fetch", "fetch_url", "read_url_content"].includes(n))
    return "web";
  if (["subagent", "task", "agent", "invoke_subagent"].includes(n))
    return "subagent";
  return "other";
}

export function displayCommand(command: string): string {
  const value = command.trim();
  const match = value.match(
    /^(?:"([^"]+\.exe)"|'([^']+\.exe)'|(\S+\.exe)|\b(?:powershell|pwsh|bash|sh|zsh|cmd)\b)\s+([\s\S]+)$/i,
  );
  if (!match) return command;
  const executable = (match[1] ?? match[2] ?? match[3] ?? match[0].split(/\s+/)[0])
    .split(/[\\/]/u)
    .pop()!
    .toLowerCase();
  const args = match[4].trim();
  let script: string | undefined;
  if (["powershell.exe", "pwsh.exe", "powershell", "pwsh"].includes(executable)) {
    script = args.match(/^(?:(?:-[\w-]+)\s+)*(?:-command|-c)\s+([\s\S]+)$/i)?.[1];
  } else if (
    ["bash.exe", "bash", "sh.exe", "sh", "zsh.exe", "zsh"].includes(executable)
  ) {
    script = args.match(/^(?:(?:-[\w-]+)\s+)*-(?:l)?c\s+([\s\S]+)$/i)?.[1];
  } else if (["cmd.exe", "cmd"].includes(executable)) {
    script = args.match(/^(?:(?:\/[\w]+)\s+)*\/c\s+([\s\S]+)$/i)?.[1];
  }
  if (!script) return command;
  const trimmed = script.trim();
  const quote = trimmed[0];
  if ((quote === "'" || quote === '"') && trimmed[trimmed.length - 1] === quote) {
    return trimmed.slice(1, -1).trim() || command;
  }
  return trimmed || command;
}

export function extractToolPaths(value: unknown, output = new Set<string>()): string[] {
  const scan = (node: unknown) => {
    if (!node || output.size >= 10) return;
    if (Array.isArray(node)) {
      for (const item of node) scan(item);
      return;
    }
    if (typeof node === "string") {
      for (const match of node.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)\r?$/gm)) {
        output.add(match[1].trim());
      }
      return;
    }
    if (typeof node !== "object") return;
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (
        typeof item === "string" &&
        /^(path|file_?path|absolute_?path|filePath|target_?file|directory|dir)$/i.test(
          key,
        ) &&
        item.length < 400 &&
        !item.includes("\n")
      ) {
        output.add(item);
      } else if (
        typeof item === "string" &&
        /^(patch|input)$/i.test(key) &&
        item.includes("*** ")
      ) {
        scan(item);
      } else if (item && typeof item === "object") {
        scan(item);
      }
    }
  };
  scan(value);
  return [...output];
}

export function parseDiffSummary(diff: unknown): DiffSummary | null {
  if (!diff || typeof diff !== "object") return null;
  const obj = diff as Record<string, unknown>;
  if (Array.isArray(obj.items)) {
    const combined: DiffLine[] = [];
    let adds = 0;
    let dels = 0;
    const rawParts: string[] = [];
    let firstPath: string | undefined;
    for (const item of obj.items) {
      const sub = parseDiffSummary(item);
      if (!sub) continue;
      adds += sub.adds;
      dels += sub.dels;
      combined.push(...sub.lines);
      rawParts.push(sub.rawPatch);
      if (!firstPath && sub.path) firstPath = sub.path;
    }
    if (!rawParts.length) return null;
    return {
      adds,
      dels,
      lines: combined,
      rawPatch: rawParts.join("\n\n"),
      path: firstPath,
    };
  }
  const path = typeof obj.path === "string" ? obj.path : undefined;
  if (typeof obj.patch === "string" && obj.patch.trim()) {
    const lines: DiffLine[] = [];
    let adds = 0;
    let dels = 0;
    for (const raw of obj.patch.split(/\r?\n/u)) {
      if (
        raw.startsWith("+++") ||
        raw.startsWith("---") ||
        raw.startsWith("@@") ||
        raw.startsWith("*** ")
      ) {
        lines.push({ kind: "meta", text: raw });
      } else if (raw.startsWith("+")) {
        adds += 1;
        lines.push({ kind: "add", text: raw });
      } else if (raw.startsWith("-")) {
        dels += 1;
        lines.push({ kind: "del", text: raw });
      } else {
        lines.push({ kind: "ctx", text: raw });
      }
    }
    return { adds, dels, lines, rawPatch: obj.patch, path };
  }
  const oldText = typeof obj.oldText === "string" ? obj.oldText : "";
  const newText = typeof obj.newText === "string" ? obj.newText : "";
  if (!oldText && !newText) return null;
  const lines: DiffLine[] = [];
  const oldLines = oldText ? oldText.split(/\r?\n/u) : [];
  const newLines = newText ? newText.split(/\r?\n/u) : [];
  for (const l of oldLines) lines.push({ kind: "del", text: `-${l}` });
  for (const l of newLines) lines.push({ kind: "add", text: `+${l}` });
  const header = path ? `--- a/${path}\n+++ b/${path}\n` : "--- a\n+++ b\n";
  return {
    adds: newLines.length,
    dels: oldLines.length,
    lines,
    rawPatch: `${header}@@\n${lines.map((l) => l.text).join("\n")}`,
    path,
  };
}

function isGrepNoMatch(
  category: ToolCategory,
  toolName: string,
  commandText: string | undefined,
  message: AgentMessage,
): boolean {
  const failed =
    message.isError || message.status === "error" || message.status === "failed";
  if (!failed) return false;
  const cmdLower = (commandText ?? "").toLowerCase();
  const isSearchCmd =
    category === "search" ||
    /\b(rg|ripgrep|grep|findstr)\b/u.test(baseName(toolName)) ||
    /^(rg|grep|findstr)\b/u.test(cmdLower);
  if (!isSearchCmd) return false;
  const txt = message.text.trim();
  return (
    !txt ||
    /(?:exited with|exit) (?:code|status):?\s*1\b|\bno match/iu.test(txt)
  );
}

export function describeToolCall(message: AgentMessage): DescribedTool {
  const category = normalizeToolCategory(message.toolName, message.toolKind);
  const args =
    message.arguments && typeof message.arguments === "object"
      ? (message.arguments as Record<string, unknown>)
      : {};
  const paths = extractToolPaths(message.arguments);
  for (const loc of message.locations ?? []) {
    if (typeof loc?.path === "string" && !paths.includes(loc.path)) {
      paths.push(loc.path);
    }
  }
  const rawCmd =
    typeof args.command === "string"
      ? args.command
      : typeof args.cmd === "string"
        ? args.cmd
        : undefined;
  const commandText = rawCmd ? displayCommand(rawCmd) : undefined;
  const shortPath = (p: string) => p.split(/[\\/]/u).pop() || p;

  let target = "";
  if (category === "command" && commandText) {
    target = commandText;
  } else if (
    category === "search" &&
    typeof (args.query ?? args.pattern) === "string"
  ) {
    target = `"${String(args.query ?? args.pattern)}"`;
    if (paths[0]) target += ` · ${shortPath(paths[0])}`;
  } else if (paths[0]) {
    target = shortPath(paths[0]);
    if (category === "read" && typeof args.offset === "number") {
      target += ` (L${args.offset}${typeof args.limit === "number" ? `-${args.offset + args.limit}` : ""})`;
    }
  } else if (typeof args.url === "string") {
    target = args.url;
  } else if (typeof message.arguments === "string" && message.arguments.trim()) {
    target = message.arguments.trim().split(/\r?\n/u)[0].slice(0, 80);
  }

  const diff = parseDiffSummary(message.diff);
  if (diff && target && !target.includes("+") && (diff.adds || diff.dels)) {
    target += ` (+${diff.adds} -${diff.dels})`;
  }

  const badge = TOOL_LABELS[category];
  const baseTitle = message.toolName || badge;
  const title = target ? `${badge} ${target}` : baseTitle;
  const isGrepEmpty = isGrepNoMatch(category, message.toolName, commandText, message);

  return {
    category,
    badge,
    title,
    target,
    commandText,
    isGrepEmpty,
    diff,
    paths,
  };
}

function normalizePath(cwd: string, input: string): string {
  const raw = input.replace(/\\/g, "/").trim();
  const abs = /^[A-Za-z]:\//u.test(raw) || raw.startsWith("/");
  const full = abs || !cwd ? raw : `${cwd.replace(/\\/g, "/")}/${raw}`;
  const drive = /^[A-Za-z]:\//u.test(full)
    ? full.slice(0, 3)
    : full.startsWith("/")
      ? "/"
      : "";
  const body = drive ? full.slice(drive.length) : full;
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && !parts[parts.length - 1].endsWith(":")) {
      parts.pop();
    } else if (part !== "..") {
      parts.push(part);
    }
  }
  return `${drive}${parts.join("/")}`;
}

export function collectTurnFileChanges(
  messages: AgentMessage[],
  cwd: string,
): TurnFileChange[] {
  const byKey = new Map<string, TurnFileChange>();
  const add = (
    rawPath: string,
    operation: TurnFileChange["operation"],
    diff: DiffSummary | null,
  ) => {
    if (!rawPath.trim()) return;
    const resolved = normalizePath(cwd, rawPath);
    const key = /^[A-Za-z]:/u.test(resolved) ? resolved.toLowerCase() : resolved;
    const prev = byKey.get(key);
    byKey.set(key, {
      path: resolved,
      operation,
      adds: (prev?.adds ?? 0) + (diff?.adds ?? 0),
      dels: (prev?.dels ?? 0) + (diff?.dels ?? 0),
      diffText: diff?.rawPatch ?? prev?.diffText ?? null,
    });
  };

  for (const m of messages) {
    if (m.kind !== "toolCall") continue;
    if (m.status === "running" || m.status === "pending" || m.status === "in_progress") {
      continue;
    }
    const desc = describeToolCall(m);
    if (desc.category !== "edit" && desc.category !== "write") continue;
    const lower = baseName(m.toolName);
    if (lower === "apply_patch") {
      const args =
        m.arguments && typeof m.arguments === "object"
          ? (m.arguments as Record<string, unknown>)
          : {};
      const patch =
        typeof m.arguments === "string"
          ? m.arguments
          : String(args.patch ?? args.input ?? "");
      let matched = false;
      for (const match of patch.matchAll(
        /^\*\*\* (Add|Update|Delete) File: (.+)\r?$/gm,
      )) {
        matched = true;
        add(
          match[2],
          match[1] === "Add" ? "新增" : match[1] === "Delete" ? "删除" : "修改",
          desc.diff,
        );
      }
      if (!matched && desc.paths[0]) {
        add(desc.paths[0], "修改", desc.diff);
      }
      continue;
    }
    const op: TurnFileChange["operation"] =
      lower.includes("delete") || lower.includes("remove")
        ? "删除"
        : desc.category === "write"
          ? "写入"
          : "修改";
    for (const p of desc.paths) {
      add(p, op, desc.diff);
    }
  }
  return [...byKey.values()];
}

export type ProcessStepGroup =
  | { kind: "explore"; id: string; messages: AgentMessage[] }
  | { kind: "single"; id: string; message: AgentMessage; recoveredAfterFailure?: boolean };

export function groupProcessSteps(messages: AgentMessage[]): ProcessStepGroup[] {
  const result: ProcessStepGroup[] = [];
  const failedCats = new Set<ToolCategory>();
  for (const msg of messages) {
    const desc = describeToolCall(msg);
    const isExplore =
      msg.kind === "toolCall" &&
      (desc.category === "read" ||
        desc.category === "search" ||
        desc.category === "list");
    const last = result[result.length - 1];
    if (isExplore) {
      if (last?.kind === "explore") {
        last.messages.push(msg);
      } else {
        result.push({ kind: "explore", id: `exp:${msg.id}`, messages: [msg] });
      }
      continue;
    }
    const failed =
      !desc.isGrepEmpty &&
      (msg.isError || msg.status === "error" || msg.status === "failed");
    const succeeded = msg.status === "completed";
    let recoveredAfterFailure = false;
    if (succeeded && failedCats.has(desc.category)) {
      recoveredAfterFailure = true;
      failedCats.delete(desc.category);
    } else if (failed) {
      failedCats.add(desc.category);
    }
    result.push({
      kind: "single",
      id: msg.id,
      message: msg,
      recoveredAfterFailure,
    });
  }
  return result;
}

export function summarizeProcessBlock(
  messages: AgentMessage[],
  running: boolean,
): string {
  if (running) {
    const live = [...messages]
      .reverse()
      .find((m) => m.status === "running" || m.status === "in_progress");
    if (live) return `正在执行：${describeToolCall(live).title}`;
  }
  const counts: Partial<Record<ToolCategory, number>> = {};
  for (const m of messages) {
    if (m.kind !== "toolCall") continue;
    const cat = describeToolCall(m).category;
    counts[cat] = (counts[cat] ?? 0) + 1;
  }
  const parts: string[] = [];
  if (counts.read) parts.push(`读取 ${counts.read}`);
  if (counts.search) parts.push(`搜索 ${counts.search}`);
  if (counts.list) parts.push(`列目录 ${counts.list}`);
  if (counts.edit) parts.push(`修改 ${counts.edit}`);
  if (counts.write) parts.push(`写入 ${counts.write}`);
  if (counts.command) parts.push(`命令 ${counts.command}`);
  if (counts.web) parts.push(`网络 ${counts.web}`);
  if (counts.subagent) parts.push(`子代理 ${counts.subagent}`);
  if (!parts.length) return `${messages.length} 个步骤`;
  return parts.join(" · ");
}
