/// <reference types="vite/client" />
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { PiTranscript } from "../../../src/modules/plugins/pi-agent/PiTranscript";
import { INITIAL_PI_VIEW_STATE, piViewReducer } from "../../../src/modules/plugins/pi-agent/reducer";
import "../../../src/styles/globals.css";
import "../../../src/modules/plugins/pi-agent/pi-agent.css";

const completed = piViewReducer(INITIAL_PI_VIEW_STATE, {
  type: "history", offset: 0, hasMore: false,
  messages: [
    { id: "user", message: { role: "user", content: [{ type: "text", text: "请检查配置并给出结论" }] } },
    { id: "work", message: { role: "assistant", content: [
      { type: "thinking", thinking: "", thinkingSignature: "opaque" },
      { type: "thinking", thinking: "正在检查配置，这是应当保留的真实思考。" },
      { type: "toolCall", id: "tool", name: "read", arguments: { path: "config.json" } },
    ] } },
    { message: { role: "toolResult", toolCallId: "tool", toolName: "read", content: [{ type: "text", text: "配置正常" }] } },
    { id: "final", message: { role: "assistant", stopReason: "stop", content: [
      { type: "text", text: "最终结论：配置正常。此回复必须直接可见，不能被尾部空思考折叠。" },
      { type: "thinking", thinking: "", thinkingSignature: "opaque" },
      { type: "thinking", thinking: { invalid: true } },
    ] } },
  ],
});
function QA() {
  const [mode, setMode] = useState("completed");
  const view = mode === "completed" ? { ...completed, status: "idle" as const } : {
    ...INITIAL_PI_VIEW_STATE,
    status: "running" as const,
    items: [completed.items[0], { id: "stream", kind: "thinking" as const, text: mode === "text" ? "收到真实思考后正常显示" : "", streaming: true }],
  };
  return <main className="pi-agent" style={{ height: "100vh", display: "flex", flexDirection: "column", maxWidth: 850, margin: "auto" }}>
    <nav style={{ display: "flex", gap: 16, padding: 12 }}>
      <button type="button" onClick={() => setMode("completed")}>完成态尾部空思考</button>
      <button type="button" onClick={() => setMode("empty")}>空思考运行态</button>
      <button type="button" onClick={() => setMode("text")}>思考正文到达</button>
    </nav>
    <PiTranscript view={view} threadKey={mode} active searchOpen={false} onCloseSearch={() => {}} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><QA /></StrictMode>);
