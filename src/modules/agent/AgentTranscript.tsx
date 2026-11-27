import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  File01Icon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MarkdownLink } from "@/modules/markdown/MarkdownLink";
import { MarkdownTable } from "@/modules/markdown/MarkdownTable";
import { ZoomableImage } from "@/modules/reader/ZoomableImage";
import { splitUserAttachmentText } from "@/modules/plugins/pi-agent/piAttachments";
import {
  speakVoice,
  stopVoiceOutput,
  useVoiceOutput,
} from "@/modules/voice/output";
import { splitInlineThinking } from "./inlineThinking";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { TurnGitCard } from "@/modules/vcs/TurnGitCard";
import type { VcsTurnDiffSummary } from "@/modules/vcs/types";
import {
  EditDiffView,
  PlanCard,
  PlanProgressStrip,
  StructuredRequestCard,
  TurnFileChangesBar,
} from "./PlanAndRequest";
import {
  collectTurnFileChanges,
  compactToolTitlePaths,
  describeToolCall,
} from "./toolFormat";
import {
  buildTranscriptBlocks,
  type TurnProcessBlock,
  type TurnStep,
} from "./turnTimeline";
import { useAgentStore } from "./store";
import {
  isBusy,
  statusLabel,
  type AgentMessage,
  type SessionView,
} from "./types";

const markdownComponents = {
  a: MarkdownLink,
  img: ZoomableImage,
  table: MarkdownTable,
};
const STREAMDOWN_CONTROLS = {
  code: { copy: true, download: false },
  table: false,
} as const;

type ScrollMemoryEntry = {
  id: string;
  offset: number;
  following: boolean;
};

const scrollMemory = new Map<string, ScrollMemoryEntry>();

function formatClockTime(ts?: number): string {
  if (!ts || ts <= 0) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const Message = memo(function Message({
  message,
  canFork,
  hideThinking,
  recoveredAfterFailure,
  onFork,
  onOpenDiff,
}: {
  message: AgentMessage;
  canFork?: boolean;
  hideThinking?: boolean;
  recoveredAfterFailure?: boolean;
  onFork?: (entryId: string) => void;
  onOpenDiff?: (path: string, diff: string) => void;
}) {
  const voice = useVoiceOutput();
  const [speakingThis, setSpeakingThis] = useState(false);

  useEffect(() => {
    if (voice.status !== "playing" && speakingThis) {
      setSpeakingThis(false);
    }
  }, [voice.status, speakingThis]);

  if (message.kind === "toolCall" || message.kind === "toolResult") {
    const desc = describeToolCall(message);
    const failed =
      !desc.isGrepEmpty &&
      (message.isError ||
        message.status === "error" ||
        message.status === "failed");
    const runningTool =
      message.status === "running" ||
      message.status === "in_progress" ||
      message.status === "pending";
    const statusText = desc.isGrepEmpty
      ? "无匹配"
      : runningTool
        ? "执行中"
        : failed
          ? "执行失败"
          : "已完成";
    const toneClass = desc.isGrepEmpty
      ? "is-neutral"
      : failed
        ? "is-error"
        : runningTool
          ? "is-running"
          : "is-done";
    const summaryTarget =
      desc.category === "command" && desc.commandText
        ? `${desc.badge} · ${desc.commandText}`
        : desc.target
          ? `${desc.badge} · ${desc.target}`
          : compactToolTitlePaths(desc.title);
    const fullTargetTitle =
      desc.paths[0] ??
      (message.toolName && message.toolName !== summaryTarget
        ? message.toolName
        : undefined);
    const tailLines =
      desc.category === "command" && message.text
        ? message.text.trimEnd().split(/\r?\n/u).slice(-14).join("\n")
        : message.text;

    return (
      <details
        data-agent-message-id={message.id}
        className={`agent-step-row ${toneClass}`}
      >
        <summary className="agent-step-summary" title={fullTargetTitle}>
          <HugeiconsIcon
            icon={File01Icon}
            size={13}
            className="agent-step-icon"
          />
          <span className="agent-step-status">{statusText}</span>
          <span aria-hidden="true">·</span>
          <span className="agent-step-target">{summaryTarget}</span>
          {recoveredAfterFailure && (
            <span
              className="agent-tool-recovered"
              title="先前的同类步骤失败后，在此步骤恢复"
            >
              已恢复
            </span>
          )}
        </summary>
        <div className="agent-step-body reader-scrollbar max-h-80 overflow-auto">
          {desc.commandText && (
            <pre className="agent-cmd-line">$ {desc.commandText}</pre>
          )}
          {desc.diff && (
            <EditDiffView
              diff={desc.diff}
              path={desc.paths[0]}
              onOpenDiff={onOpenDiff}
            />
          )}
          {tailLines && !desc.diff && <pre>{tailLines}</pre>}
          {(message.arguments != null || (desc.diff && message.text)) && (
            <details className="mt-1 text-[10px] text-muted-foreground">
              <summary className="cursor-pointer select-none">
                查看原始参数与输出
              </summary>
              {message.arguments != null && (
                <pre className="mt-1">
                  {typeof message.arguments === "string"
                    ? message.arguments
                    : JSON.stringify(message.arguments, null, 2)}
                </pre>
              )}
              {message.text && <pre>{message.text}</pre>}
            </details>
          )}
        </div>
      </details>
    );
  }
  if (message.kind === "plan") {
    return <PlanCard raw={message.text} />;
  }
  if (message.kind === "notice") {
    return (
      <details
        className={`agent-notice ${message.isError ? "text-destructive" : ""}`}
      >
        <summary>{message.text}</summary>
      </details>
    );
  }
  const user = message.role === "user";
  const userParsed = user ? splitUserAttachmentText(message.text) : null;
  const resolved = user
    ? { thinking: message.thinking, text: userParsed?.body ?? message.text }
    : splitInlineThinking(message.text, message.thinking, message.streaming);
  const clock = formatClockTime(message.createdAt);
  const isPlaying = speakingThis && voice.status === "playing";
  const imageList = !!message.images?.length && (
    <div className="agent-message-images">
      {message.images.map((image) =>
        image.data ? (
          <ZoomableImage
            key={image.id ?? `${image.mimeType}:${image.data.slice(-32)}`}
            src={`data:${image.mimeType};base64,${image.data}`}
            alt="消息附件"
            loading="lazy"
          />
        ) : (
          <span key={`${message.id}:native-image`}>原生历史中的图片</span>
        ),
      )}
    </div>
  );
  return (
    <article
      className={`agent-message ${user ? "agent-user" : "agent-assistant"} ${message.status === "error" ? "agent-message-error" : ""}`}
    >
      {!hideThinking && resolved.thinking && (
        <details className="agent-thinking">
          <summary>{message.streaming ? "正在思考…" : "思考过程"}</summary>
          <div>
            <Streamdown
              isAnimating={message.streaming}
              controls={STREAMDOWN_CONTROLS}
              components={markdownComponents}
            >
              {resolved.thinking}
            </Streamdown>
          </div>
        </details>
      )}
      {user && imageList}
      {resolved.text && (
        <div className={user ? "agent-user-bubble" : "agent-markdown"}>
          {user ? (
            resolved.text
          ) : (
            <Streamdown
              isAnimating={message.streaming}
              controls={STREAMDOWN_CONTROLS}
              components={markdownComponents}
            >
              {resolved.text}
            </Streamdown>
          )}
        </div>
      )}
      {!!userParsed?.attachments.length && (
        <div className="agent-file-chips mt-1 justify-end">
          {userParsed.attachments.map((att) => (
            <span
              key={att.path}
              title={att.path}
              className="agent-draft-file-chip"
            >
              <span className="agent-file-chip-kind">
                {att.kind === "dir" ? "目录" : "文件"}
              </span>
              <span className="max-w-48 truncate">{att.name}</span>
            </span>
          ))}
        </div>
      )}
      {!user && imageList}
      {!message.streaming && (resolved.text || clock) && (
        <div className="agent-message-actions">
          {clock && <span className="agent-msg-time">{clock}</span>}
          {resolved.text && (
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(resolved.text)
                  .catch((error) => useAgentStore.getState().report(error))
              }
            >
              复制
            </button>
          )}
          {!user && resolved.text && (
            <button
              type="button"
              onClick={() => {
                if (isPlaying) {
                  stopVoiceOutput();
                  setSpeakingThis(false);
                } else {
                  setSpeakingThis(true);
                  void speakVoice(resolved.text);
                }
              }}
            >
              {isPlaying ? "停止朗读" : "朗读"}
            </button>
          )}
          {user &&
            canFork &&
            message.sourceEventId &&
            onFork &&
            (() => {
              const entryId = message.sourceEventId;
              return (
                <button
                  type="button"
                  onClick={() => onFork(entryId)}
                  title="从这条消息分叉为新会话"
                >
                  分叉
                </button>
              );
            })()}
        </div>
      )}
    </article>
  );
});

function formatElapsed(milliseconds: number) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}分${total % 60}秒` : `${total}秒`;
}

function renderTurnStep(
  step: TurnStep,
  onOpenDiff?: (path: string, diff: string) => void,
) {
  if (step.kind === "thinking") {
    const preview = step.text.replace(/\s+/gu, " ").trim();
    const short = preview.length > 140 ? `${preview.slice(0, 140)}…` : preview;
    return (
      <details key={step.id} className="agent-step-row">
        <summary className="agent-step-summary">
          <HugeiconsIcon
            icon={PencilEdit01Icon}
            size={13}
            className="agent-step-icon"
          />
          <span className="agent-step-status">
            {step.streaming ? "思考中" : "已思考"}
          </span>
          <span aria-hidden="true">·</span>
          <span className="agent-step-target">{short || "等待思考内容"}</span>
        </summary>
        <div className="agent-step-body agent-markdown">
          <Streamdown
            isAnimating={step.streaming}
            controls={STREAMDOWN_CONTROLS}
            components={markdownComponents}
          >
            {step.text}
          </Streamdown>
        </div>
      </details>
    );
  }
  if (step.kind === "narrative") {
    return (
      <div
        key={step.id}
        data-agent-message-id={step.message.id}
        className="agent-step-narrative agent-markdown"
      >
        <Streamdown
          isAnimating={step.message.streaming}
          controls={STREAMDOWN_CONTROLS}
          components={markdownComponents}
        >
          {step.text}
        </Streamdown>
      </div>
    );
  }
  if (step.kind === "plan") {
    return (
      <div key={step.id} data-agent-message-id={step.message.id}>
        <PlanCard raw={step.message.text} />
      </div>
    );
  }
  if (step.kind === "notice") {
    return (
      <div key={step.id} data-agent-message-id={step.message.id}>
        <Message message={step.message} />
      </div>
    );
  }
  if (step.kind === "explore") {
    if (step.messages.length === 1) {
      return (
        <Message
          key={step.messages[0].id}
          message={step.messages[0]}
          onOpenDiff={onOpenDiff}
        />
      );
    }
    const sampleTargets = step.messages
      .map((m) => describeToolCall(m).target)
      .filter(Boolean);
    const uniqueTargets = [...new Set(sampleTargets)];
    const preview =
      uniqueTargets.length > 0
        ? uniqueTargets.slice(0, 2).join("、") +
          (uniqueTargets.length > 2 ? " 等" : "")
        : `${step.messages.length} 个文件或检索`;
    const allRunning = step.messages.some(
      (m) =>
        m.status === "running" ||
        m.status === "in_progress" ||
        m.status === "pending",
    );
    return (
      <details key={step.id} className="agent-step-row agent-explore-sub">
        <summary className="agent-step-summary">
          <HugeiconsIcon
            icon={File01Icon}
            size={13}
            className="agent-step-icon"
          />
          <span className="agent-step-status">
            {allRunning ? "正在探索" : "已探索"}
          </span>
          <span aria-hidden="true">·</span>
          <span className="agent-step-target">
            {step.messages.length} 项 · {preview}
          </span>
        </summary>
        <div className="agent-explore-sublist">
          {step.messages.map((m) => (
            <Message key={m.id} message={m} onOpenDiff={onOpenDiff} />
          ))}
        </div>
      </details>
    );
  }
  return (
    <Message
      key={step.id}
      message={step.message}
      recoveredAfterFailure={step.recoveredAfterFailure}
      onOpenDiff={onOpenDiff}
    />
  );
}

export function TurnProcessView({
  block,
  now,
  cwd,
  mobile,
  searchQuery,
  onOpenFile,
  onOpenDiff,
}: {
  block: TurnProcessBlock;
  now: number;
  cwd: string;
  mobile?: boolean;
  searchQuery?: string;
  onOpenFile: (path: string) => void;
  onOpenDiff?: (
    path: string,
    diff: string,
    options?: { activate?: boolean },
  ) => void;
}) {
  const [open, setOpen] = useState(false);

  const searchMatched = useMemo(() => {
    const q = searchQuery?.trim().toLowerCase();
    if (!q) return false;
    return block.rawMessages.some((m) => {
      const argsText =
        m.arguments == null
          ? ""
          : typeof m.arguments === "string"
            ? m.arguments
            : JSON.stringify(m.arguments);
      return `${m.text} ${m.thinking} ${m.toolName} ${argsText}`
        .toLowerCase()
        .includes(q);
    });
  }, [block.rawMessages, searchQuery]);

  useEffect(() => {
    if (searchMatched) setOpen(true);
  }, [searchMatched]);

  const elapsedMs = !block.startedAt
    ? 0
    : block.running
      ? Math.max(0, now - block.startedAt)
      : block.finishedAt && block.finishedAt > block.startedAt
        ? block.finishedAt - block.startedAt
        : 0;
  const elapsed = !block.startedAt
    ? ""
    : block.running
      ? `用时 ${formatElapsed(elapsedMs)}`
      : elapsedMs >= 1000
        ? `用时 ${formatElapsed(elapsedMs)}`
        : block.finishedAt && block.finishedAt > block.startedAt
          ? "用时 <1秒"
          : "";

  const tickerWindow = useRef<HTMLDivElement>(null);
  const tickerFollowing = useRef(true);
  const visibleTicker = block.tickerItems;
  useLayoutEffect(() => {
    const node = tickerWindow.current;
    if (!node || !block.running || open || !tickerFollowing.current) return;
    node.scrollTop = node.scrollHeight;
  }, [block.running, open, visibleTicker]);
  const stepSummary =
    block.stepCount > 0
      ? `${block.stepCount} 个步骤${block.toolCount > 0 ? ` · ${block.toolCount} 次工具调用` : ""}`
      : block.running
        ? ""
        : "思考过程";
  const metaText = [stepSummary, elapsed].filter(Boolean).join(" · ");

  return (
    <div className={`agent-turn-process ${block.running ? "is-live" : ""}`}>
      <details
        className="agent-process"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary
          className="agent-turn-summary"
          title={
            !block.running && block.summaryText ? block.summaryText : undefined
          }
        >
          <span className="agent-turn-chevron" aria-hidden="true">
            ▸
          </span>
          {block.running && <span className="agent-state-dot is-working" />}
          <span
            className={`agent-process-title ${block.running ? "is-live" : ""}`}
          >
            {block.statusTitle}
          </span>
          {metaText && <span className="agent-process-meta">{metaText}</span>}
        </summary>

        {open && (
          <div className="agent-turn-timeline">
            {block.steps.length ? (
              block.steps.map((step) => renderTurnStep(step, onOpenDiff))
            ) : (
              <div className="agent-step-narrative">等待首条步骤返回…</div>
            )}
          </div>
        )}
      </details>

      {block.running && !open && visibleTicker.length > 0 && (
        <div className="agent-ticker-shell">
          <div
            ref={tickerWindow}
            className="agent-ticker-window reader-scrollbar"
            role="log"
            aria-label="当前执行步骤"
            onWheel={(event) => {
              if (event.deltaY < 0) tickerFollowing.current = false;
              const node = event.currentTarget;
              if (node.scrollHeight > node.clientHeight) {
                event.stopPropagation();
              }
            }}
            onScroll={(event) => {
              const node = event.currentTarget;
              tickerFollowing.current =
                node.scrollHeight - node.clientHeight - node.scrollTop < 12;
            }}
          >
            {visibleTicker.map((item, idx) => {
              const isCurrent = idx === visibleTicker.length - 1;
              const statusWord =
                item.status === "running"
                  ? item.verb === "思考"
                    ? "思考中"
                    : "执行中"
                  : item.status === "error"
                    ? "执行失败"
                    : item.verb === "思考"
                      ? "已思考"
                      : "已完成";
              return (
                <div
                  key={item.id}
                  className={`agent-ticker-row is-${item.status} ${isCurrent ? "is-current" : "is-past"}`}
                >
                  <HugeiconsIcon
                    icon={item.verb === "思考" ? PencilEdit01Icon : File01Icon}
                    size={12}
                    className="agent-step-icon"
                  />
                  <span className="agent-ticker-status">{statusWord}</span>
                  <span aria-hidden="true">·</span>
                  <span className="agent-ticker-text">
                    {item.verb === "思考" || item.verb === "说明"
                      ? item.text
                      : `${item.verb} · ${item.text}`}
                  </span>
                </div>
              );
            })}
          </div>
          {block.tickerItems.length > 3 && (
            <button
              type="button"
              className="agent-ticker-expand"
              onClick={() => setOpen(true)}
            >
              展开全部 {block.tickerItems.length} 步
            </button>
          )}
        </div>
      )}

      {!block.running && block.fileChanges.length > 0 && (
        <TurnFileChangesBar
          changes={block.fileChanges}
          cwd={cwd}
          mobile={mobile}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      )}
    </div>
  );
}

export function AgentTranscript({
  session,
  onOpenFile,
  onOpenDiff,
  onFork,
  searchOpen,
  onCloseSearch,
}: {
  session: SessionView;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (
    path: string,
    diff: string,
    options?: { activate?: boolean },
  ) => void;
  onFork?: (entryId: string) => void;
  searchOpen: boolean;
  onCloseSearch: () => void;
}) {
  const scroll = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const sendRevision = useAgentStore((s) => s.sendRevisions[session.id] ?? 0);
  const seenSend = useRef(sendRevision);
  const userUntil = useRef(0);
  const lastScrollTop = useRef(0);
  const saved = useRef<ScrollMemoryEntry | null>(
    scrollMemory.get(session.id) ?? null,
  );
  const following = useRef(saved.current ? saved.current.following : true);
  const previous = useRef({ first: "", height: 0 });
  const [away, setAway] = useState(!following.current);
  const [filter, setFilter] = useState("");
  const [hit, setHit] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [file, setFile] = useState<{ path: string; content: string } | null>(
    null,
  );
  const selectedText = useRef("");
  const [hasSelection, setHasSelection] = useState(false);
  const restored = useRef(false);
  const rememberScroll = (node: HTMLElement) => {
    if (!node.clientHeight) return;
    const top = node.getBoundingClientRect().top;
    const anchor = Array.from(
      node.querySelectorAll<HTMLElement>("[data-agent-message-id]"),
    ).find((item) => item.getBoundingClientRect().bottom > top);
    scrollMemory.set(session.id, {
      id: anchor?.dataset.agentMessageId ?? "",
      offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      following: following.current,
    });
  };
  const running = isBusy(session);
  const turnRunning =
    session.state === "working" || session.state === "stopping";
  useLayoutEffect(() => {
    if (!turnRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [turnRunning]);
  const openPath = (path: string) => {
    if (onOpenFile && !useAgentStore.getState().mobile) {
      onOpenFile(path);
      return;
    }
    void useAgentStore
      .getState()
      .command<{ content: string }>(
        "session.file.read",
        { path, limit: 2000 },
        session.id,
      )
      .then((result) => setFile({ path, content: result.content }))
      .catch((error) => useAgentStore.getState().report(error));
  };
  const detachFollowing = (node: HTMLElement) => {
    if (following.current) {
      following.current = false;
      setAway(true);
    }
    if (restored.current) rememberScroll(node);
  };
  useLayoutEffect(() => {
    const node = scroll.current;
    const body = content.current;
    if (!node || !body || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current && node.clientHeight > 0) {
        node.scrollTop = node.scrollHeight;
        lastScrollTop.current = node.scrollTop;
      }
    });
    observer.observe(node);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (sendRevision === seenSend.current) return;
    seenSend.current = sendRevision;
    userUntil.current = 0;
    following.current = true;
    setAway(false);
    scrollMemory.set(session.id, { id: "", offset: 0, following: true });
    const pin = () => {
      const node = scroll.current;
      if (node) {
        node.scrollTop = node.scrollHeight;
        lastScrollTop.current = node.scrollTop;
      }
    };
    pin();
    const frame = requestAnimationFrame(() => {
      if (following.current) pin();
    });
    return () => cancelAnimationFrame(frame);
  }, [sendRevision, session.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pending requests and state change the measured height
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const first = session.messages[0]?.id ?? "";
    if (!restored.current && session.messages.length) {
      restored.current = true;
      const anchor = saved.current?.id
        ? node.querySelector<HTMLElement>(
            `[data-agent-message-id="${CSS.escape(saved.current.id)}"]`,
          )
        : null;
      if (anchor && saved.current && !saved.current.following) {
        following.current = false;
        node.scrollTop +=
          anchor.getBoundingClientRect().top -
          node.getBoundingClientRect().top -
          saved.current.offset;
        setAway(true);
      } else if (following.current) {
        node.scrollTop = node.scrollHeight;
      }
    }
    if (
      !following.current &&
      previous.current.first &&
      previous.current.first !== first &&
      session.messages.some((message) => message.id === previous.current.first)
    ) {
      node.scrollTop += node.scrollHeight - previous.current.height;
    } else if (following.current) {
      node.scrollTop = node.scrollHeight;
    }
    lastScrollTop.current = node.scrollTop;
    previous.current = { first, height: node.scrollHeight };
  }, [session.messages, session.pendingRequests, session.state]);
  const bottom = () => {
    userUntil.current = 0;
    following.current = true;
    setAway(false);
    scrollMemory.set(session.id, { id: "", offset: 0, following: true });
    scroll.current?.scrollTo({
      top: scroll.current.scrollHeight,
      behavior: "smooth",
    });
  };
  const query = filter.trim().toLowerCase();
  const matches = useMemo(
    () =>
      query
        ? session.messages.filter((message) => {
            const argsText =
              message.arguments == null
                ? ""
                : typeof message.arguments === "string"
                  ? message.arguments
                  : JSON.stringify(message.arguments);
            return `${message.text} ${message.thinking} ${message.toolName} ${argsText}`
              .toLowerCase()
              .includes(query);
          })
        : [],
    [session.messages, query],
  );
  const jump = (index: number) => {
    if (!matches.length) return;
    const next = (index + matches.length) % matches.length;
    setHit(next);
    const el = scroll.current?.querySelector<HTMLElement>(
      `[data-agent-message-id="${CSS.escape(matches[next].id)}"]`,
    );
    if (el) {
      let parent = el.parentElement;
      while (parent && parent !== scroll.current) {
        if (parent instanceof HTMLDetailsElement && !parent.open) {
          parent.open = true;
        }
        parent = parent.parentElement;
      }
      userUntil.current = performance.now() + 1000;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };
  useEffect(() => {
    if (!searchOpen) {
      setFilter("");
      setHit(0);
    }
  }, [searchOpen]);
  const userTurns = useMemo(
    () =>
      session.messages
        .filter((m) => m.role === "user" && m.kind === "message")
        .map((m, idx) => ({
          id: m.id,
          index: idx + 1,
          label:
            m.text.replace(/\s+/g, " ").trim().slice(0, 40) ||
            `提问 ${idx + 1}`,
        })),
    [session.messages],
  );
  const mobile = useAgentStore((s) => s.mobile);
  const gitUiEnabled = usePreferencesStore((s) => s.gitUiEnabled);
  const cwd =
    useAgentStore(
      (s) => s.workspaces.find((w) => w.id === session.workspaceId)?.cwd,
    ) ?? "";
  const turnGit =
    (session.statuses?.turnGit as VcsTurnDiffSummary | undefined) ?? null;
  const blocks = useMemo(
    () => buildTranscriptBlocks(session.messages, turnRunning, cwd, turnGit),
    [session.messages, turnRunning, cwd, turnGit],
  );
  const hasTurnChanges = useMemo(
    () => blocks.some((b) => b.kind === "process" && b.fileChanges.length > 0),
    [blocks],
  );
  const fallbackTurnChanges = useMemo(
    () => (hasTurnChanges ? [] : collectTurnFileChanges(session.messages, cwd)),
    [hasTurnChanges, session.messages, cwd],
  );
  return (
    <div className="agent-transcript-wrap">
      <PlanProgressStrip messages={session.messages} />
      {searchOpen && (
        <div className="agent-transcript-actions is-searching">
          <>
            <Input
              autoFocus
              aria-label="搜索当前对话"
              placeholder="搜索已加载对话"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setHit(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  jump(hit + (event.shiftKey ? -1 : 1));
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  onCloseSearch();
                }
              }}
            />
            {query && (
              <span className="agent-search-count">
                {matches.length ? `${hit + 1}/${matches.length}` : "0/0"}
              </span>
            )}
            {query && (
              <>
                <button
                  type="button"
                  aria-label="上一个匹配"
                  disabled={!matches.length}
                  onClick={() => jump(hit - 1)}
                >
                  <HugeiconsIcon icon={ArrowUp01Icon} size={14} />
                </button>
                <button
                  type="button"
                  aria-label="下一个匹配"
                  disabled={!matches.length}
                  onClick={() => jump(hit + 1)}
                >
                  <HugeiconsIcon icon={ArrowDown01Icon} size={14} />
                </button>
              </>
            )}
            <button
              type="button"
              aria-label="关闭搜索"
              title="关闭搜索"
              onClick={onCloseSearch}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={14} />
            </button>
          </>
        </div>
      )}
      <section
        ref={scroll}
        tabIndex={-1}
        aria-label="对话记录"
        className="agent-transcript reader-scrollbar select-text outline-none"
        onLoadCapture={() => {
          if (following.current && scroll.current) {
            scroll.current.scrollTop = scroll.current.scrollHeight;
            lastScrollTop.current = scroll.current.scrollTop;
          }
        }}
        onClickCapture={(event) => {
          const anchor = (event.target as Element).closest<HTMLAnchorElement>(
            "a[href]",
          );
          const href = anchor?.getAttribute("href");
          if (!href || href.startsWith("#")) return;
          const mobile = useAgentStore.getState().mobile;
          if (/^(https?:|mailto:|tel:|\/\/)/i.test(href)) {
            if (!mobile) {
              event.preventDefault();
              void import("@tauri-apps/plugin-opener")
                .then((module) => module.openUrl(href))
                .catch((error) => useAgentStore.getState().report(error));
            }
            return;
          }
          event.preventDefault();
          if (
            /^[a-z][a-z0-9+.-]*:/i.test(href) &&
            !/^file:/i.test(href) &&
            !/^[a-z]:[\\/]/i.test(href)
          )
            return;
          let path: string;
          try {
            path = decodeURIComponent(
              href.startsWith("file:")
                ? new URL(href).pathname
                : href.split("#")[0],
            );
          } catch {
            return;
          }
          path = path.replace(/^\/([a-z]:\/)/i, "$1").replace(/\\/g, "/");
          const cwd =
            useAgentStore
              .getState()
              .workspaces.find(
                (workspace) => workspace.id === session.workspaceId,
              )?.cwd ?? "";
          if (!path.startsWith("/") && !/^[a-z]:\//i.test(path))
            path = `${cwd}/${path}`;
          openPath(path);
        }}
        onWheel={(event) => {
          userUntil.current = performance.now() + 1000;
          if (event.deltaY < 0) {
            detachFollowing(event.currentTarget);
          }
        }}
        onPointerDown={() => {
          userUntil.current = performance.now() + 1000;
        }}
        onTouchStart={() => {
          userUntil.current = performance.now() + 1000;
        }}
        onKeyDown={(event) => {
          if (
            [
              "PageUp",
              "ArrowUp",
              "Home",
              "PageDown",
              "ArrowDown",
              "End",
              " ",
            ].includes(event.key)
          ) {
            userUntil.current = performance.now() + 1000;
            if (["PageUp", "ArrowUp", "Home"].includes(event.key)) {
              detachFollowing(event.currentTarget);
            }
          }
        }}
        onScroll={(event) => {
          const node = event.currentTarget;
          if (!node.clientHeight) return;
          const prevTop = lastScrollTop.current;
          lastScrollTop.current = node.scrollTop;
          const nearBottom =
            node.scrollHeight - node.clientHeight - node.scrollTop < 48;
          const userScrolling = performance.now() < userUntil.current;
          if (userScrolling) userUntil.current = performance.now() + 200;
          if (userScrolling && node.scrollTop < prevTop - 1) {
            detachFollowing(node);
            return;
          }
          if (nearBottom) {
            if (!following.current) {
              following.current = true;
              setAway(false);
            }
          } else if (userScrolling && following.current) {
            following.current = false;
            setAway(true);
          }
          if (restored.current) rememberScroll(node);
        }}
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              ref={content}
              className="agent-transcript-content select-text"
              onContextMenuCapture={() => {
                const text = window.getSelection()?.toString() ?? "";
                selectedText.current = text;
                setHasSelection(text.length > 0);
              }}
            >
              {session.historyOffset > 0 && (
                <Button
                  variant="ghost"
                  className="mx-auto block text-xs"
                  onClick={() =>
                    void useAgentStore
                      .getState()
                      .command(
                        "session.history",
                        { before: session.historyOffset },
                        session.id,
                      )
                      .catch((error) => useAgentStore.getState().report(error))
                  }
                >
                  加载更早的原生历史
                </Button>
              )}
              {session.truncated && (
                <p className="agent-notice">
                  为保持阅读流畅，较早内容已从实时视图释放；原生历史保留。
                </p>
              )}
              {!session.messages.length && !running && (
                <div className="agent-empty">
                  <h3>从一个任务开始</h3>
                  <p>
                    {session.readOnly
                      ? "这份原生历史当前以只读方式打开。"
                      : "在下方输入任务。模型、权限和会话由当前代理管理。"}
                  </p>
                </div>
              )}
              {!session.historyAvailable &&
                session.imported &&
                session.harnessId !== "pi" &&
                !session.readOnly && (
                  <p className="agent-notice">
                    历史展示由代理的会话恢复结果提供。
                  </p>
                )}
              {blocks.map((block) =>
                block.kind === "process" ? (
                  <TurnProcessView
                    key={block.id}
                    block={block}
                    now={now}
                    cwd={cwd}
                    mobile={mobile}
                    searchQuery={query}
                    onOpenFile={openPath}
                    onOpenDiff={onOpenDiff}
                  />
                ) : (
                  <div
                    key={block.message.id}
                    data-agent-message-id={block.message.id}
                    className={
                      query && block.message.text.toLowerCase().includes(query)
                        ? "agent-search-hit"
                        : undefined
                    }
                  >
                    <Message
                      message={block.message}
                      hideThinking={block.hideThinking}
                      canFork={
                        !session.readOnly && !!session.capabilities.supportsFork
                      }
                      onFork={onFork}
                      onOpenDiff={onOpenDiff}
                    />
                  </div>
                ),
              )}
              <TurnFileChangesBar
                changes={fallbackTurnChanges}
                cwd={cwd}
                mobile={mobile}
                onOpenFile={openPath}
                onOpenDiff={onOpenDiff}
              />
              {gitUiEnabled && (
                <TurnGitCard
                  sessionId={session.id}
                  summary={turnGit}
                  mobile={mobile}
                  onOpenDiff={onOpenDiff}
                />
              )}
              {session.pendingRequests.map((request) => (
                <StructuredRequestCard
                  key={request.id}
                  request={request}
                  session={session}
                />
              ))}
              {((turnRunning &&
                !blocks.some((b) => b.kind === "process" && b.running)) ||
                session.state === "starting") && (
                <div className="agent-activity">
                  <span className="agent-state-dot is-working" />
                  {statusLabel(session.state)}
                </div>
              )}
              {session.error && (
                <div className="agent-error" role="alert">
                  {session.error}
                </div>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <ContextMenuItem
              disabled={!hasSelection}
              onSelect={() => {
                const text = selectedText.current;
                if (!text) return;
                void writeText(text).catch((error) => {
                  toast.error(`复制失败：${String(error)}`);
                });
              }}
            >
              复制<ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </section>
      {userTurns.length >= 4 && (
        <nav className="agent-conv-nav" aria-label="对话回合快速跳转">
          {userTurns.slice(-12).map((turn) => (
            <button
              key={turn.id}
              type="button"
              title={`#${turn.index} ${turn.label}`}
              onClick={() => {
                userUntil.current = performance.now() + 1000;
                scroll.current
                  ?.querySelector<HTMLElement>(
                    `[data-agent-message-id="${CSS.escape(turn.id)}"]`,
                  )
                  ?.scrollIntoView({ block: "start", behavior: "smooth" });
              }}
            >
              {turn.index}
            </button>
          ))}
        </nav>
      )}
      {away && (
        <Button
          className="agent-jump"
          variant="secondary"
          size="sm"
          onClick={bottom}
        >
          回到最新 ↓
        </Button>
      )}
      <Dialog
        open={!!file}
        onOpenChange={(open) => {
          if (!open) setFile(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogTitle className="break-all text-xs">{file?.path}</DialogTitle>
          <DialogDescription>
            绑定工作区内的只读文件预览，最多显示 2000 行。
          </DialogDescription>
          <pre className="reader-scrollbar max-h-[65vh] overflow-auto whitespace-pre-wrap text-xs">
            {file?.content}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
