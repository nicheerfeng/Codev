import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { Toaster } from "sonner";
import type { Message, Thread } from "../../../src/modules/plugins/codex-agent/protocol";
import "/src/styles/globals.css";

const threads: Thread[] = Array.from({ length: 8 }, (_, index) => ({ id: `qa-${index}`, name: `工作会话 ${index + 1}`, preview: "检查项目", cwd: `D:/qa/${index < 4 ? "Codev" : "Research"}`, updatedAt: index, turns: [{ id: `history-${index}`, status: "completed", items: [{ id: "user", type: "userMessage", content: [{ type: "text", text: "查看当前项目的执行进展" }] }, { id: "reason", type: "reasoning", summary: ["先阅读项目结构，再检查已有实现与测试覆盖。"] }, { id: "tool", type: "commandExecution", command: "git status --short", status: "completed", aggregatedOutput: " M src/main.ts" }, { id: "answer", type: "agentMessage", text: "## 检查结果\n\n已检查 **项目结构**。\n\n| 模块 | 状态 |\n| --- | --- |\n| UI | 正常 |\n| 进程桥接 | 正常 |\n\n```ts\nconst status = 'ready';\n```" }] }] }));
const sent: Message[] = [];
const exports: Array<{ path: string; content: string }> = [];
for (const thread of threads) { thread.turns[0].startedAt = 1750000000; thread.turns[0].completedAt = 1750000185; thread.turns[0].durationMs = 185000; }
const archived = new Set<string>();
let connectionId = 0;
let resourceId = "native";
const resourceCatalog = { provider: "qa-provider", activeResourceId: "native", path: "QA/codev.json", resources: [{ id: "native", alias: "原生资源", baseUrl: "", keyMask: "沿用原生认证" }, { id: "qa-resource", alias: "资源 B", baseUrl: "https://example.invalid/v1", keyMask: "••••••••" }] };
/** 发送隔离协议事件，所有生产组件仍走真实 IPC 封装。 */
function event(message: Message) { return emit("codev://codex-agent-event", { connectionId, message }); }
mockWindows("main");
mockIPC(async (command, args: any) => {
  if (command === "plugin:store|load") return 1;
  if (command === "plugin:store|get") return [null, false];
  if (command === "plugin:store|entries") return [];
  if (command === "plugin:path|resolve_directory") return "C:/qa/home";
  if (command === "plugin:dialog|save") return "D:/qa/export.md";
  if (command === "codex_agent_export") { exports.push(args); return; }
  if (command === "fs_stat") return { kind: String(args.path).endsWith("/folder") ? "dir" : "file" };
  if (command === "fs_read_asset_bytes") return [137, 80, 78, 71];
  if (command === "plugin:dialog|open") return args.options?.directory ? "D:/qa/NewProject" : ["D:/qa/readme.md"];
  if (command === "codex_agent_start") { resourceId = args.resourceId ?? resourceId; return ++connectionId; }
  if (command === "codex_agent_ready") { resourceCatalog.activeResourceId = resourceId; return { resourceId, provider: "qa-provider" }; }
  if (command === "codex_resources_list") return structuredClone(resourceCatalog);
  if (command === "codex_resources_probe") return "模型目录可达，共 1 个模型；未执行生成调用。";
  if (command === "codex_resources_save") { const input = args.input; const existing = resourceCatalog.resources.findIndex((r) => r.id === input.id); const row = { id: input.id, alias: input.alias, baseUrl: input.baseUrl, keyMask: "••••••••" }; if (existing >= 0) resourceCatalog.resources[existing] = row; else resourceCatalog.resources.push(row); return structuredClone(resourceCatalog); }
  if (command === "codex_resources_delete") { resourceCatalog.resources = resourceCatalog.resources.filter((r) => r.id !== args.id); return structuredClone(resourceCatalog); }
  if (command !== "codex_agent_send") return;
  const message: Message = args.message; sent.push(message);
  if (!message.method || message.id === undefined) return;
  let result: unknown = {};
  if (message.method === "skills/list") result = { data: (message.params?.cwds as string[]).map((cwd) => ({ cwd, errors: [], skills: [{ name: "shared-skill", description: "全局技能", scope: "user", path: "C:/qa/.agents/skills/shared/SKILL.md", enabled: true }, { name: "shared-skill", description: `项目技能 ${cwd}`, scope: "repo", path: `${cwd}/.agents/skills/shared/SKILL.md`, enabled: true }, { name: "disabled-skill", description: "已禁用", scope: "repo", path: `${cwd}/disabled/SKILL.md`, enabled: false }] })) };
  const id = message.params?.threadId as string;
  if (message.method === "thread/list") result = { data: threads.filter((thread) => archived.has(thread.id) === Boolean(message.params?.archived)).map((thread) => ({ ...thread, turns: [] })), nextCursor: null };
  if (message.method === "model/list") result = { data: [{ id: "qa", model: "qa", displayName: "QA Model", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] };
  if (message.method === "thread/read" || message.method === "thread/resume") result = { thread: threads.find((thread) => thread.id === id), sandbox: { type: "readOnly", networkAccess: false } };
  if (message.method === "thread/turns/list") { const turns=[...(threads.find((thread) => thread.id === id)?.turns ?? [])]; if(message.params?.sortDirection!=="asc")turns.reverse(); const offset=Number(message.params?.cursor??0),limit=Number(message.params?.limit??30); result = { data: turns.slice(offset,offset+limit), nextCursor: offset+limit<turns.length?String(offset+limit):null }; }
  if (message.method === "thread/delete") { const index = threads.findIndex((thread) => thread.id === id); if (index >= 0) threads.splice(index, 1); }
  if (message.method === "thread/archive") archived.add(id);
  if (message.method === "thread/unarchive") archived.delete(id);
  if (message.method === "thread/fork") { const source = threads.find((thread) => thread.id === id)!; const thread = { ...source, id: `qa-${threads.length}`, name: `${source.name} fork`, turns: message.params?.beforeTurnId ? [] : source.turns }; threads.push(thread); result = { thread }; }
  if (message.method === "thread/name/set") { const thread = threads.find((thread) => thread.id === id); if (thread) thread.name = String(message.params?.name); }
  if (message.method === "thread/start") { const thread = { ...threads[0], id: `qa-${threads.length}`, name: null, preview: "", cwd: String(message.params?.cwd), turns: [] }; threads.unshift(thread); result = { thread }; }
  if (message.method === "turn/start") {
    await event({ method: "turn/started", params: { threadId: id, turn: { id: `turn-${id}`, items: [], status: "inProgress" } } });
    await event({ method: "item/started", params: { threadId: id, turnId: `turn-${id}`, item: { id: "stream", type: "agentMessage", text: "" } } });
    await event({ method: "item/agentMessage/delta", params: { threadId: id, turnId: `turn-${id}`, itemId: "stream", delta: "正在执行隔离测试任务..." } });
  }
  if (message.method === "turn/interrupt") await event({ method: "turn/completed", params: { threadId: id, turn: { id: `turn-${id}`, items: [], status: "interrupted" } } });
  if (message.method === "thread/compact/start") {
    await event({ method: "turn/started", params: { threadId: id, turn: { id: `compact-${id}`, items: [], status: "inProgress" } } });
    await event({ method: "turn/completed", params: { threadId: id, turn: { id: `compact-${id}`, items: [{ id: `compaction-${id}`, type: "contextCompaction" }], status: "completed" } } });
  }
  queueMicrotask(() => { void event({ id: message.id, result }); });
}, { shouldMockEvents: true });

const { CodexPane } = await import("../../../src/modules/plugins/codex-agent/CodexPane");
const { createCodexComposerPathDropTarget } = await import("../../../src/modules/plugins/codex-agent/codexComposerDrop");
const { useCodexComposerDropStore } = await import("../../../src/modules/plugins/codex-agent/codexComposerDropStore");
const dropTarget = createCodexComposerPathDropTarget({ active: () => useCodexComposerDropStore.getState().active, onDrop: (items, key) => useCodexComposerDropStore.getState().drop?.(items, key), onHover: (hover, key) => useCodexComposerDropStore.getState().setHover(hover, key) });
const { ThemeProvider, useTheme } = await import("../../../src/modules/theme");
(window as any).codexQA = { sent, event, exports, dropTarget, threads };
/** 在固定容器内核验插件显隐及浅深色主题。 */
function QA() {
  const [active, setActive] = useState(true);
  const { setMode } = useTheme();
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}><header style={{ display: "flex", gap: 16, height: 30 }}><button onClick={() => setActive(!active)}>切换插件</button><button onClick={() => setMode("light")}>浅色</button><button onClick={() => setMode("dark")}>深色</button></header><div style={{ flex: 1, minHeight: 0, display: active ? "block" : "none" }}><CodexPane /><Toaster /></div></div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><ThemeProvider defaultMode="dark"><QA /></ThemeProvider></React.StrictMode>);
