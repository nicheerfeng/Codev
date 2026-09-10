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
let modelsText = JSON.stringify({ customRoot: true, providers: { qa: { baseUrl: "https://example.invalid", api: "openai-completions", headers: { "X-QA": "$TOKEN" }, models: [{ id: "reasoning-model", name: "Reasoning model", reasoning: true, contextWindow: 128000 }, { id: "fast-model", name: "Fast model", customField: "preserve" }] }, overrides: { modelOverrides: { builtin: { maxTokens: 2048 } } } } }, null, 2);
const closed: number[] = [];
const sent: unknown[] = [];
const clipboard: string[] = [];
const queued = new Map<number, string[]>();
const running = new Set<number>();
const modelTests = new Set<number>();
/** 为隔离历史生成稳定的原生条目 ID。 */
function entriesFor(runtime: { messages: object[] }) {
  return runtime.messages.map((message, index) => ({ id: `entry-${index}`, type: "message", parentId: index ? `entry-${index - 1}` : null, timestamp: new Date(1700000000000 + index * 1000).toISOString(), message }));
}
/** 发送隔离的原生形状事件，所有生产组件仍走实际 native.ts。 */
function event(runtimeId: number, value: object) { return emit("codev://pi-agent-event", { sessionId: runtimeId, stream: "stdout", event: value }); }
mockIPC(async (cmd, args: any) => {
  if (cmd === "plugin:clipboard-manager|write_text") { clipboard.push(args.text); return; }
  if (cmd === "pi_agent_probe") return { available: true, version: "QA fixture", path: "pi", error: null };
  if (cmd === "pi_agent_list_all_sessions") return sessions;
  if (cmd === "pi_agent_delete_session") {
    const index = sessions.findIndex((session) => session.path === args.path);
    if (index >= 0) sessions.splice(index, 1);
    sent.push({ deleted: args.path });
    return;
  }
  if (cmd === "plugin:dialog|open") return "D:/qa/EmptyProject";
  if (cmd === "plugin:dialog|save") return "D:/qa/export.html";
  if (cmd === "pi_agent_read_models") return { path: "~/.pi/agent/models.json", exists: true, content: modelsText };
  if (cmd === "pi_agent_write_models") { JSON.parse(args.content); modelsText = args.content; return; }
  if (cmd === "plugin:store|load") return 1;
  if (cmd === "plugin:store|get") return [storage.get(args.key), storage.has(args.key)];
  if (cmd === "plugin:store|set") { storage.set(args.key, args.value); return; }
  if (cmd === "plugin:store|entries") return [];
  if (cmd === "pi_agent_start") {
    if (args.request.cwd === "D:/qa/MissingProject") {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      throw new Error("工作目录不存在：D:/qa/MissingProject");
    }
    const id = ++next;
    if (args.request.modelTest) modelTests.add(id);
    const found = sessions.find((item) => item.path === args.request.sessionPath);
    const messages = found ? Array.from({ length: 40 }, (_, index) => [
      { role: "user", content: `第 ${index + 1} 轮任务：检查 keyword 与代码` },
      { role: "assistant", content: [{ type: "thinking", thinking: "检查数据与参数 keyword" }, { type: "text", text: "先阅读原始内容" }, { type: "toolCall", id: `read-${index}`, name: "read", arguments: { path: "src/main.ts" } }] },
      { role: "toolResult", toolCallId: `read-${index}`, toolName: "read", content: [{ type: "text", text: "原始内容 keyword\n读取成功" }] },
      { role: "assistant", content: [{ type: "text", text: `## 检查结果 ${index + 1}\n\n这是 **keyword** 的结果。\n\n- 数据结构正常\n- 确认输入与滚动可用\n\n\`\`\`ts\nconst keyword = true;\n\`\`\`` }] },
    ]).flat() : [];
    runtimes.set(id, { cwd: args.request.cwd, path: found?.path ?? `D:/qa/sessions/new-${id}.jsonl`, name: found?.name ?? "", model: models[0], level: "high", messages: messages.map((message, index) => ({ ...message, timestamp: 1700000000000 + index * 1000 })) });
    return { sessionId: id, processId: id };
  }
  if (cmd === "pi_agent_close") { closed.push(args.sessionId); return true; }
  if (cmd === "pi_agent_send") {
    const { sessionId, command } = args;
    const runtime = runtimes.get(sessionId)!;
    sent.push({ sessionId, command });
    let data: unknown = {};
    if (command.type === "get_messages") { await new Promise((resolve) => setTimeout(resolve, 1200)); data = { messages: runtime.messages }; }
    if (command.type === "get_state") data = { sessionFile: runtime.path, sessionName: runtime.name, model: runtime.model, thinkingLevel: runtime.level, isStreaming: running.has(sessionId) };
    if (command.type === "get_commands") data = { commands: Array.from({length: 25}, (_, i) => ({name: `skill:review-${i}`, description: "审核代码", source: "skill"})) };
    if (command.type === "get_entries") data = { entries: entriesFor(runtime), leafId: `entry-${runtime.messages.length - 1}` };
    if (command.type === "get_fork_messages") data = { messages: entriesFor(runtime).filter((entry: any) => entry.message.role === "user").map((entry: any) => ({ entryId: entry.id, text: typeof entry.message.content === "string" ? entry.message.content : entry.message.content[0]?.text })) };
    if (command.type === "get_tree") {
      let children: any[] = [];
      for (const entry of entriesFor(runtime).reverse()) children = [{ entry, children }];
      data = { tree: children, leafId: `entry-${runtime.messages.length - 1}` };
    }
    if (command.type === "clear_queue") { data = { steering: queued.get(sessionId) ?? [], followUp: [] }; queued.delete(sessionId); }
    if (command.type === "compact") { await new Promise((resolve) => setTimeout(resolve, 300)); data = { summary: "已压缩", tokensBefore: 12000 }; }
    if (command.type === "fork" || command.type === "clone") {
      const index = Number(command.entryId?.split("-")[1]);
      const content = (runtime.messages[index] as any)?.content;
      data = { cancelled: false, text: typeof content === "string" ? content : content?.[0]?.text ?? "" };
      if (command.type === "fork") runtime.messages = runtime.messages.slice(0, index);
      runtime.path = `D:/qa/sessions/branch-${Date.now()}.jsonl`;
      runtime.name = "新分支";
    }
    if (command.type === "get_available_models") data = { models };
    if (command.type === "get_available_thinking_levels") data = { levels: ["off", "low", "medium", "high"] };
    if (command.type === "get_session_stats") data = { contextUsage: { percent: 24, tokens: 12000 } };
    if (command.type === "set_model") { runtime.model = models.find((item) => item.id === command.modelId)!; data = runtime.model; }
    if (command.type === "set_thinking_level") runtime.level = command.level;
    if (command.type === "set_session_name") runtime.name = command.name;
    if (command.type === "export_html") data = { path: command.outputPath };
    if (command.type === "prompt") {
      if (modelTests.has(sessionId)) {
        void event(sessionId, { type: "agent_start" });
        setTimeout(() => {
          void event(sessionId, { type: "message_end", message: { role:"assistant", timestamp: Date.now(), content:[{type:"text",text:"OK"}] } });
          void event(sessionId, { type:"agent_settled" });
        }, (window as any).piQA?.testDelay ?? 100);
        queueMicrotask(() => { void event(sessionId, { type:"response", command:command.type, id:command.id, success:true }); });
        return;
      }
      if (running.has(sessionId)) {
        queued.set(sessionId, [...(queued.get(sessionId) ?? []), command.message]);
        queueMicrotask(() => { void event(sessionId, { type: "response", command: command.type, id: command.id, success: true }); });
        return;
      }
      running.add(sessionId);
      const userMessage = { role: "user", timestamp: Date.now(), content: [{ type: "text", text: command.message }, ...(command.images ?? [])] };
      runtime.messages.push(userMessage);
      void event(sessionId, { type: "agent_start" });
      void event(sessionId, { type: "message_end", message: userMessage });
      void event(sessionId, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "检查任务的上下文" } });
      void event(sessionId, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "正在处理 keyword。" } });
    }
    if (command.type === "abort") { running.delete(sessionId); void event(sessionId, { type: "agent_settled" }); }
    if (command.type !== "extension_ui_response") queueMicrotask(() => { void event(sessionId, { type: "response", command: command.type, id: command.id, success: true, data }); });
    return;
  }
  return null;
}, { shouldMockEvents: true });

const { PiAgentPane } = await import("/src/modules/plugins/pi-agent/PiAgentPane");
const { usePluginStore } = await import("/src/modules/plugins/store");
const { ThemeProvider, useTheme } = await import("/src/modules/theme");
usePluginStore.setState({ hydrated: true, piAgentProjects: ["D:/qa/Codev", "D:/qa/Research"], piAgentOrganization: { groups: [{ id: "work", name: "工作" }], projectGroups: { "d:/qa/research": "work" }, archived: [sessions[4].path] } });
(window as any).piQA = { closed, sent, clipboard, event, runtimes, getModels: () => JSON.parse(modelsText), addMissing: () => usePluginStore.setState({ piAgentProjects: [...usePluginStore.getState().piAgentProjects, "D:/qa/MissingProject"] }) };

/** 以与 Dock 相同的固定父容器检查插件显隐和独立高度。 */
function QA() {
  const [active, setActive] = useState(true);
  const { setMode } = useTheme();
  (window as any).piQA.setMode = setMode;
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <div style={{ height: 32, flexShrink: 0, display: "flex", gap: 16, paddingLeft: 12 }}><button onClick={() => setActive(!active)}>切换插件</button><button onClick={() => setMode("light")}>浅色</button><button onClick={() => setMode("dark")}>深色</button></div>
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}><div style={{ position: "absolute", inset: 0, display: active ? undefined : "none" }}><PiAgentPane cwd="D:/qa/Codev" active={active} /></div>{!active && <div>终端占位（核验隐藏页不停止 Pi）</div>}</div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<ThemeProvider defaultMode="dark"><QA /></ThemeProvider>);
