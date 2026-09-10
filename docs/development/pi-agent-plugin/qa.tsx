// 仅供本地 Vite + 后台 Chrome 核验，不是生产入口，不访问真实 Pi 或用户配置。
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import "/src/styles/globals.css";

const sessions = Array.from({ length: 8 }, (_, index) => ({ path: `D:/qa/sessions/${index}.jsonl`, id: String(index), cwd: index < 5 ? "D:/qa/Codev" : "D:/qa/Research", name: `研究线程 ${index + 1}`, preview: "分析文件，整理报告", messageCount: 80, createdAt: "2026-09-10", updatedAt: Date.now() - index * 1000 }));
const runtimes = new Map<number, { cwd: string; path: string; name: string; model: object; level: string; messages: object[] }>();
const storage = new Map<string, unknown>();
const models = [{ provider: "qa", id: "reasoning-model", name: "Reasoning model" }, { provider: "qa", id: "fast-model", name: "Fast model" }];
let next = 0;
let modelsText = '{"providers":{}}';
const closed: number[] = [];
const sent: unknown[] = [];
/** 发送隔离的原生形状事件，所有生产组件仍走实际 native.ts。 */
function event(runtimeId: number, value: object) { return emit("codev://pi-agent-event", { sessionId: runtimeId, stream: "stdout", event: value }); }
mockIPC(async (cmd, args: any) => {
  if (cmd === "pi_agent_probe") return { available: true, version: "QA fixture", path: "pi", error: null };
  if (cmd === "pi_agent_list_all_sessions") return sessions;
  if (cmd === "plugin:dialog|open") return "D:/qa/EmptyProject";
  if (cmd === "plugin:dialog|save") return "D:/qa/export.html";
  if (cmd === "pi_agent_read_models") return { path: "~/.pi/agent/models.json", exists: true, content: modelsText };
  if (cmd === "pi_agent_write_models") { JSON.parse(args.content); modelsText = args.content; return; }
  if (cmd === "plugin:store|load") return 1;
  if (cmd === "plugin:store|get") return [storage.get(args.key), storage.has(args.key)];
  if (cmd === "plugin:store|set") { storage.set(args.key, args.value); return; }
  if (cmd === "plugin:store|entries") return [];
  if (cmd === "pi_agent_start") {
    const id = ++next;
    const found = sessions.find((item) => item.path === args.request.sessionPath);
    const messages = found ? Array.from({ length: 40 }, (_, index) => [
      { role: "user", content: `第 ${index + 1} 轮任务：检查 keyword 与代码` },
      { role: "assistant", content: [{ type: "thinking", thinking: "检查数据与参数 keyword" }, { type: "text", text: "先阅读原始内容" }, { type: "toolCall", id: `read-${index}`, name: "read", arguments: { path: "src/main.ts" } }] },
      { role: "toolResult", toolCallId: `read-${index}`, toolName: "read", content: [{ type: "text", text: "原始内容 keyword\n读取成功" }] },
      { role: "assistant", content: [{ type: "text", text: `## 检查结果 ${index + 1}\n\n这是 **keyword** 的结果。\n\n- 数据结构正常\n- 确认输入与滚动可用\n\n\`\`\`ts\nconst keyword = true;\n\`\`\`` }] },
    ]).flat() : [];
    runtimes.set(id, { cwd: args.request.cwd, path: found?.path ?? `D:/qa/sessions/new-${id}.jsonl`, name: found?.name ?? "", model: models[0], level: "high", messages });
    return { sessionId: id, processId: id };
  }
  if (cmd === "pi_agent_close") { closed.push(args.sessionId); return true; }
  if (cmd === "pi_agent_send") {
    const { sessionId, command } = args;
    const runtime = runtimes.get(sessionId)!;
    sent.push({ sessionId, command });
    let data: unknown = {};
    if (command.type === "get_messages") data = { messages: runtime.messages };
    if (command.type === "get_state") data = { sessionFile: runtime.path, sessionName: runtime.name, model: runtime.model, thinkingLevel: runtime.level, isStreaming: false };
    if (command.type === "get_available_models") data = { models };
    if (command.type === "get_available_thinking_levels") data = { levels: ["off", "low", "medium", "high"] };
    if (command.type === "get_session_stats") data = { contextUsage: { percent: 24, tokens: 12000 } };
    if (command.type === "set_model") { runtime.model = models.find((item) => item.id === command.modelId)!; data = runtime.model; }
    if (command.type === "set_thinking_level") runtime.level = command.level;
    if (command.type === "set_session_name") runtime.name = command.name;
    if (command.type === "export_html") data = { path: command.outputPath };
    if (command.type === "prompt") {
      void event(sessionId, { type: "agent_start" });
      void event(sessionId, { type: "message_end", message: { role: "user", content: command.message } });
      void event(sessionId, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "检查任务的上下文" } });
      void event(sessionId, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "正在处理 keyword。" } });
    }
    if (command.type === "abort") void event(sessionId, { type: "agent_settled" });
    if (command.type !== "extension_ui_response") queueMicrotask(() => { void event(sessionId, { type: "response", command: command.type, id: command.id, success: true, data }); });
    return;
  }
  return null;
}, { shouldMockEvents: true });

const { PiAgentPane } = await import("/src/modules/plugins/pi-agent/PiAgentPane");
const { usePluginStore } = await import("/src/modules/plugins/store");
const { ThemeProvider, useTheme } = await import("/src/modules/theme");
usePluginStore.setState({ hydrated: true, piAgentProjects: ["D:/qa/Codev", "D:/qa/Research"], piAgentOrganization: { groups: [{ id: "work", name: "工作" }], projectGroups: { "d:/qa/research": "work" }, archived: [sessions[4].path] } });
(window as any).piQA = { closed, sent, event, runtimes };

/** 以与 Dock 相同的固定父容器检查插件显隐和独立高度。 */
function QA() {
  const [active, setActive] = useState(true);
  const { setMode } = useTheme();
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <div style={{ height: 32, flexShrink: 0, display: "flex", gap: 16, paddingLeft: 12 }}><button onClick={() => setActive(!active)}>切换插件</button><button onClick={() => setMode("light")}>浅色</button><button onClick={() => setMode("dark")}>深色</button></div>
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}><div style={{ position: "absolute", inset: 0, display: active ? undefined : "none" }}><PiAgentPane cwd="D:/qa/Codev" active={active} /></div>{!active && <div>终端占位（核验隐藏页不停止 Pi）</div>}</div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<ThemeProvider defaultMode="dark"><QA /></ThemeProvider>);
