import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";

const KEY = "codev.pi.turn-diff";

type ReadResult =
  | { kind: "text"; content: string }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type Original = {
  path: string;
  before: string | null;
  toolName: string;
  args: Record<string, unknown> | null;
};

export type PiTurnFile = {
  path: string;
  before: string | null;
  diff: string;
  adds: number;
  dels: number;
  kind: "created" | "modified" | "deleted";
};

export type PiTurnSnapshot = {
  id: string;
  anchorId?: string;
  files: PiTurnFile[];
};

type ActiveTurn = {
  id: string;
  anchorId?: string;
  originals: Map<string, Original>;
  pending: Map<string, Promise<void>>;
};

const activeTurns = new Map<string, ActiveTurn>();
const frozenTurns = new Map<string, PiTurnSnapshot[]>();
const serials = new Map<string, number>();

export function piTurnDiffEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function normalizePath(cwd: string, input: string): string {
  const raw = input.replace(/\\/g, "/").trim();
  const absolute = /^[A-Za-z]:\//u.test(raw) || raw.startsWith("/");
  const value = absolute ? raw : `${cwd.replace(/\\/g, "/")}/${raw}`;
  const drive = /^[A-Za-z]:\//u.test(value)
    ? value.slice(0, 3)
    : value.startsWith("/")
      ? "/"
      : "";
  const body = drive ? value.slice(drive.length) : value;
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts[parts.length - 1] !== "..")
      parts.pop();
    else if (part !== "..") parts.push(part);
  }
  return `${drive}${parts.join("/")}`;
}

function pathKey(path: string): string {
  return /^[A-Za-z]:/u.test(path) ? path.toLowerCase() : path;
}

async function readText(path: string): Promise<string | null> {
  try {
    const result = await invoke<ReadResult>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    });
    return result.kind === "text" ? result.content : null;
  } catch {
    return null;
  }
}

function pathsFromTool(toolName: string, args: unknown, cwd: string): string[] {
  const value =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const rawPath = value.path ?? value.file_path;
  if (
    typeof rawPath === "string" &&
    ["edit", "write", "delete", "delete_file", "remove_file"].includes(toolName)
  )
    return [normalizePath(cwd, rawPath)];
  if (toolName !== "apply_patch") return [];
  const patch = typeof args === "string" ? args : (value.patch ?? value.input);
  if (typeof patch !== "string") return [];
  return [
    ...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu),
  ].map((match) => normalizePath(cwd, match[1]));
}

export function beginPiTurn(threadKey: string): void {
  if (!piTurnDiffEnabled() || activeTurns.has(threadKey)) return;
  const next = (serials.get(threadKey) ?? 0) + 1;
  serials.set(threadKey, next);
  activeTurns.set(threadKey, {
    id: `pi-turn-${next}`,
    originals: new Map(),
    pending: new Map(),
  });
}

export function anchorPiTurn(threadKey: string, itemId: string): void {
  const turn = activeTurns.get(threadKey);
  if (turn && !turn.anchorId) turn.anchorId = itemId;
}

function argsObject(args: unknown): Record<string, unknown> | null {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : null;
}

function snapshotValue(
  snapshots: Record<string, unknown> | null,
  path: string,
): string | null | undefined {
  if (!snapshots) return undefined;
  const exact = snapshots[path];
  if (typeof exact === "string") return exact;
  if (exact === null) return null;
  const wanted = pathKey(path);
  for (const [raw, value] of Object.entries(snapshots)) {
    if (pathKey(raw.replace(/\\/g, "/")) !== wanted) continue;
    if (typeof value === "string") return value;
    if (value === null) return null;
  }
  return undefined;
}

export async function recordPiToolPre(
  threadKey: string,
  cwd: string,
  toolName: string,
  args: unknown,
  snapshots?: Record<string, unknown> | null,
): Promise<void> {
  if (!piTurnDiffEnabled()) return;
  if (!activeTurns.has(threadKey)) beginPiTurn(threadKey);
  const turn = activeTurns.get(threadKey);
  if (!turn) return;
  const parsed = argsObject(args);
  for (const path of pathsFromTool(toolName, args, cwd)) {
    const key = pathKey(path);
    if (turn.originals.has(key) || turn.pending.has(key)) continue;
    const captured = snapshotValue(snapshots ?? null, path);
    if (captured !== undefined) {
      turn.originals.set(key, {
        path,
        before: captured,
        toolName,
        args: parsed,
      });
      continue;
    }
    const pending = readText(path).then((before) => {
      turn.originals.set(key, { path, before, toolName, args: parsed });
      turn.pending.delete(key);
    });
    turn.pending.set(key, pending);
    await pending;
  }
}

function reverseReplace(
  text: string,
  next: string,
  previous: string,
  replaceAll: boolean,
): string | null {
  if (!next) return null;
  if (replaceAll) {
    if (!text.includes(next)) return null;
    return text.split(next).join(previous);
  }
  const index = text.indexOf(next);
  if (index < 0) return null;
  if (text.indexOf(next, index + next.length) >= 0) return null;
  return text.slice(0, index) + previous + text.slice(index + next.length);
}

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, "\n").split("\n");
}

function makeDiff(
  path: string,
  before: string,
  after: string,
): { diff: string; adds: number; dels: number } {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  )
    start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  if (start === oldEnd && start === newEnd)
    return { diff: "", adds: 0, dels: 0 };
  const context = 3;
  const oldStart = Math.max(0, start - context);
  const newStart = Math.max(0, start - context);
  const oldStop = Math.min(oldLines.length, oldEnd + context);
  const newStop = Math.min(newLines.length, newEnd + context);
  const oldChanged = oldLines.slice(start, oldEnd).length;
  const newChanged = newLines.slice(start, newEnd).length;
  const hunk: string[] = [];
  for (let index = oldStart; index < start; index++)
    hunk.push(` ${oldLines[index]}`);
  for (const line of oldLines.slice(start, oldEnd)) hunk.push(`-${line}`);
  for (const line of newLines.slice(start, newEnd)) hunk.push(`+${line}`);
  for (const line of newLines.slice(newEnd, newStop)) hunk.push(` ${line}`);
  const oldCount = oldStop - oldStart;
  const newCount = newStop - newStart;
  return {
    diff: [
      `--- ${path}`,
      `+++ ${path}`,
      `@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`,
      ...hunk,
    ].join("\n"),
    adds: newChanged,
    dels: oldChanged,
  };
}

export async function freezePiTurn(
  threadKey: string,
): Promise<PiTurnSnapshot | null> {
  const turn = activeTurns.get(threadKey);
  if (!turn) return null;
  activeTurns.delete(threadKey);
  await Promise.all(turn.pending.values());
  const files: PiTurnFile[] = [];
  for (const original of turn.originals.values()) {
    const after = await readText(original.path);
    let before = original.before;
    const oldString = original.args?.old_string;
    const newString = original.args?.new_string;
    if (
      original.toolName === "edit" &&
      typeof oldString === "string" &&
      typeof newString === "string" &&
      after != null &&
      (before == null || before === after)
    ) {
      const reversed = reverseReplace(
        after,
        newString,
        oldString,
        original.args?.replace_all === true,
      );
      if (reversed != null) before = reversed;
    }
    const result = makeDiff(original.path, before ?? "", after ?? "");
    if (!result.diff) continue;
    files.push({
      path: original.path,
      before,
      diff: result.diff,
      adds: result.adds,
      dels: result.dels,
      kind: before == null ? "created" : after == null ? "deleted" : "modified",
    });
  }
  if (!files.length) return null;
  const snapshot = { id: turn.id, anchorId: turn.anchorId, files };
  const history = frozenTurns.get(threadKey) ?? [];
  frozenTurns.set(threadKey, [...history, snapshot].slice(-50));
  return snapshot;
}

export function piTurnSnapshots(threadKey: string): PiTurnSnapshot[] {
  return frozenTurns.get(threadKey) ?? [];
}

/** 文件写完就重算当前回合，不等到回合结束。失败不替换已冻结的结果。 */
export async function refreshPiTurn(
  threadKey: string,
): Promise<PiTurnSnapshot | null> {
  const turn = activeTurns.get(threadKey);
  if (!turn || !turn.originals.size) return null;
  await Promise.all(turn.pending.values());
  if (activeTurns.get(threadKey) !== turn) return null;
  const files: PiTurnFile[] = [];
  for (const original of turn.originals.values()) {
    const after = await readText(original.path);
    let before = original.before;
    const oldString = original.args?.old_string;
    const newString = original.args?.new_string;
    if (
      original.toolName === "edit" &&
      typeof oldString === "string" &&
      typeof newString === "string" &&
      after != null &&
      (before == null || before === after)
    ) {
      const reversed = reverseReplace(
        after,
        newString,
        oldString,
        original.args?.replace_all === true,
      );
      if (reversed != null) before = reversed;
    }
    const result = makeDiff(original.path, before ?? "", after ?? "");
    if (!result.diff) continue;
    files.push({
      path: original.path,
      before,
      diff: result.diff,
      adds: result.adds,
      dels: result.dels,
      kind: before == null ? "created" : after == null ? "deleted" : "modified",
    });
  }
  if (!files.length) return null;
  const snapshot = { id: turn.id, anchorId: turn.anchorId, files };
  const history = frozenTurns.get(threadKey) ?? [];
  const index = history.findIndex((item) => item.id === snapshot.id);
  frozenTurns.set(
    threadKey,
    index >= 0
      ? history.map((item, itemIndex) =>
          itemIndex === index ? snapshot : item,
        )
      : [...history, snapshot].slice(-50),
  );
  return snapshot;
}

export function dropPiTurnSnapshots(threadKey: string): void {
  activeTurns.delete(threadKey);
  frozenTurns.delete(threadKey);
  serials.delete(threadKey);
}
