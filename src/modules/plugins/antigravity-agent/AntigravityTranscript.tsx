import { useLayoutEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  AntigravityPermission,
  AntigravitySession,
  AntigravityTranscriptItem,
} from "./types";

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolItem({ item }: { item: AntigravityTranscriptItem }) {
  const failed = item.status === "failed";
  return (
    <details
      className={cn("ag-tool", failed && "ag-tool-failed")}
      open={item.status === "in_progress"}
    >
      <summary className="ag-tool-summary">
        <HugeiconsIcon icon={ArrowDown01Icon} size={11} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{item.text}</span>
        {item.name ? <span className="ag-tool-name">{item.name}</span> : null}
      </summary>
      <div className="ag-tool-body reader-scrollbar max-h-80 overflow-auto">
        {item.input !== undefined && item.input !== null ? (
          <pre>{printable(item.input)}</pre>
        ) : null}
        {item.output !== undefined && item.output !== null ? (
          <pre>{printable(item.output)}</pre>
        ) : null}
      </div>
    </details>
  );
}

/**
 * 会话正文：与 Pi 相同的滚动容器 + 居中限宽列。
 * 视口只跟随贴底状态，用户上滑后不再抢滚动。
 */
export function AntigravityTranscript({
  session,
  messages,
  permission,
  busy,
  onPermission,
  onStart,
}: {
  session: AntigravitySession | null;
  messages: AntigravityTranscriptItem[];
  permission?: AntigravityPermission;
  busy: boolean;
  onPermission: (
    request: AntigravityPermission,
    optionId: string | null,
  ) => void;
  onStart: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const last = messages[messages.length - 1];
  const sessionIdRef = useRef(session?.id);
  if (sessionIdRef.current !== session?.id) {
    sessionIdRef.current = session?.id;
    setFollowing(true);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: 新内容到达时需要重新贴底
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node || !following) return;
    node.scrollTop = node.scrollHeight;
  }, [following, messages, last?.text, permission]);

  if (!session) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
        <span className="text-base font-medium">从一个任务开始</span>
        <span className="text-xs text-muted-foreground">
          选择右侧线程，或新建对话后在下方输入任务。
        </span>
        <Button variant="outline" size="sm" className="mt-1" onClick={onStart}>
          新建对话
        </Button>
      </div>
    );
  }

  if (!messages.length && !permission) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
        <span className="text-base font-medium">从一个任务开始</span>
        <span className="text-xs text-muted-foreground">
          在下方输入任务，Antigravity 会按自己的权限策略执行。
        </span>
      </div>
    );
  }

  return (
    <div
      ref={scroll}
      tabIndex={0}
      className="ag-conversation reader-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none [overflow-anchor:none] [scrollbar-gutter:stable]"
      onWheel={(event) => {
        if (event.deltaY < 0 && scroll.current) {
          const node = scroll.current;
          const atBottom =
            node.scrollHeight - node.clientHeight - node.scrollTop < 40;
          if (!atBottom) setFollowing(false);
        }
      }}
      onScroll={() => {
        const node = scroll.current;
        if (!node) return;
        setFollowing(
          node.scrollHeight - node.clientHeight - node.scrollTop < 40,
        );
      }}
    >
      <div className="relative mx-auto w-full max-w-3xl">
        {messages.map((item) => (
          <div key={`${item.role}-${item.id}`} className="px-4 py-2">
            {item.role === "tool" ? (
              <ToolItem item={item} />
            ) : item.role === "user" ? (
              <div className="flex justify-end">
                <div className="ag-user-message max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                  {item.text}
                </div>
              </div>
            ) : (
              <div
                className={cn(
                  "ag-assistant-message min-w-0 py-2",
                  item.role === "error" && "ag-error",
                )}
              >
                {item.role === "assistant" ? (
                  <div className="ag-markdown">
                    <Streamdown>{item.text}</Streamdown>
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap break-words text-[13px]">
                    {item.text}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {permission && (
          <div className="px-4 py-2">
            <fieldset className="ag-permission">
              <legend>{permission.title}</legend>
              {permission.name ? (
                <p className="ag-permission-name">{permission.name}</p>
              ) : null}
              {permission.input !== undefined && permission.input !== null ? (
                <pre>{printable(permission.input)}</pre>
              ) : null}
              <div className="ag-permission-actions">
                {permission.options.map((option) => (
                  <Button
                    key={option.optionId}
                    size="xs"
                    variant={
                      option.kind.startsWith("allow") ? "default" : "outline"
                    }
                    onClick={() => onPermission(permission, option.optionId)}
                  >
                    {option.name}
                  </Button>
                ))}
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onPermission(permission, null)}
                >
                  取消
                </Button>
              </div>
            </fieldset>
          </div>
        )}

        {busy && (
          <div className="flex items-center gap-2 px-4 py-1 text-[11px] text-muted-foreground">
            <span className="ag-running-dot" />
          </div>
        )}
      </div>
    </div>
  );
}
