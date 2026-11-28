import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

const INLINE_RE =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|#[\p{L}\p{N}_-]+|https?:\/\/[^\s)]+)/gu;

/** 轻量渲染行内 Markdown（行内代码、粗体、删除线、链接、#标签）以及多行子说明。 */
function renderInlineTokens(line: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;

  while ((match = INLINE_RE.exec(line)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(line.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;

    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-muted/80 px-1 py-0.2 font-mono text-[10.5px] text-foreground"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong key={key} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      nodes.push(
        <del key={key} className="opacity-70">
          {token.slice(2, -2)}
        </del>,
      );
    } else if (token.startsWith("[") && match[2] && match[3]) {
      const url = match[3];
      nodes.push(
        <a
          key={key}
          href={url}
          title={url}
          className="text-sky-400 underline decoration-sky-400/50 underline-offset-2 hover:text-sky-300"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void openUrl(url).catch(() => {});
          }}
        >
          {match[2]}
        </a>,
      );
    } else if (token.startsWith("http://") || token.startsWith("https://")) {
      nodes.push(
        <a
          key={key}
          href={token}
          title={token}
          className="text-sky-400 underline decoration-sky-400/50 underline-offset-2 hover:text-sky-300"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void openUrl(token).catch(() => {});
          }}
        >
          {token}
        </a>,
      );
    } else if (token.startsWith("#")) {
      nodes.push(
        <span
          key={key}
          className="inline-block rounded bg-sky-500/15 px-1 text-[10px] font-medium text-sky-400"
        >
          {token}
        </span>,
      );
    } else {
      nodes.push(token);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < line.length) {
    nodes.push(line.slice(lastIndex));
  }
  return nodes;
}

export function NoteInlineMarkdown({
  text,
  done,
  clamp = false,
}: {
  text: string;
  done: boolean;
  clamp?: boolean;
}) {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.trim()) {
    return (
      <div className="min-w-0 flex-1 text-left text-[11.5px] leading-[1.45] text-muted-foreground/60">
        未命名待办
      </div>
    );
  }
  const lines = normalized.split("\n");
  const head = lines[0] ?? "";
  const rest = lines.slice(1);

  if (clamp) {
    return (
      <div className="min-w-0 flex-1 space-y-0.5 text-left">
        <div
          className={`break-words text-[11.5px] leading-[1.45] ${
            rest.length > 0 ? "line-clamp-1" : "line-clamp-2"
          } ${done ? "text-muted-foreground line-through" : "text-foreground"}`}
        >
          {renderInlineTokens(head, "h")}
        </div>
        {rest.length > 0 ? (
          <div className="line-clamp-1 break-words border-l border-border/60 pl-2 text-[10.5px] leading-[1.4] text-muted-foreground">
            {renderInlineTokens(
              rest
                .map((line) => line.trim())
                .filter(Boolean)
                .join(" "),
              "r",
            )}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-w-0 flex-1 space-y-0.5 text-left">
      <div
        className={`break-words text-[11.5px] leading-[1.45] ${
          done ? "text-muted-foreground line-through" : "text-foreground"
        }`}
      >
        {renderInlineTokens(head, "h")}
      </div>
      {rest.length > 0 ? (
        <div className="space-y-0.5 border-l border-border/60 pl-2 text-[10.5px] leading-[1.4] text-muted-foreground">
          {rest.map((line, idx) => (
            <div key={idx} className="break-words">
              {line.trim() ? renderInlineTokens(line, `r${idx}`) : "\u00A0"}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
