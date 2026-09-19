import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { itemText, type Thread } from "./protocol";
import type { CodexClient } from "./client";

/** 将原生消息转成可移植 Markdown，包含思考、工具和文件 diff。 */
export function threadMarkdown(thread: Thread): string {
  return (
    [
      `# ${thread.name || thread.preview || "Codex 对话"}`,
      `项目：${thread.cwd}`,
      ...thread.turns.flatMap((turn) =>
        turn.items.map((item) => {
          const title =
            item.type === "userMessage"
              ? "用户"
              : item.type === "agentMessage"
                ? "助手"
                : item.type === "reasoning"
                  ? "思考"
                  : item.type;
          const extra =
            item.aggregatedOutput ||
            item.changes
              ?.map((change) => `${change.path}\n${change.diff}`)
              .join("\n\n") ||
            "";
          return `## ${title}\n\n${itemText(item)}${extra ? `\n\n${extra}` : ""}`;
        }),
      ),
    ].join("\n\n") + "\n"
  );
}
/** 用户选择保存位置后导出 Markdown，不修改原会话。 */
export async function exportMarkdown(client: CodexClient, id: string) {
  const thread = await client.exportThread(id);
  const name = (thread.name || "Codex 对话").replace(/[<>:"/\\|?*]/g, "_");
  const path = await save({
    defaultPath: `${name}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (path)
    await invoke("codex_agent_export", {
      path,
      content: threadMarkdown(thread),
    });
}
