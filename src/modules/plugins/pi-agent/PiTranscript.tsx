import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Streamdown } from "streamdown";
import { PiFileOperations } from "./PiFileOperations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Search01Icon,
  Copy01Icon,
  PencilEdit01Icon,
  GitForkIcon,
  File01Icon,
  Folder01Icon,
} from "@hugeicons/core-free-icons";
import { splitUserAttachmentText } from "./piAttachments";
import { findLiteralMatches } from "@/modules/editor/lib/textSearch";
import { ZoomableImage } from "@/modules/reader/ZoomableImage";
import { MarkdownTable } from "@/modules/markdown/MarkdownTable";
import {
  buildTimelineBlocks,
  itemText,
  activitySummary,
  currentActivity,
  activityPreview,
  toolSummary,
  type PiTimelineBlock,
  type PiTimelineStep,
} from "./timeline";
import type {
  PiMessageItem,
  PiThinkingItem,
  PiTranscriptItem,
  PiViewState,
} from "./types";

const STREAMDOWN_CONTROLS = {
  code: { copy: true, download: false },
  table: false,
} as const;
const STREAMDOWN_COMPONENTS = { img: ZoomableImage, table: MarkdownTable };

type MessageActions = {
  onCopy?: (text: string) => void;
  onEdit?: (
    item: PiMessageItem,
    text: string,
  ) => boolean | undefined | Promise<boolean | undefined>;
  onFork?: () => void;
  onOpenFile?: (path: string) => void;
  canEditLastUser?: boolean;
  lastUserId?: string;
};

/** 将毫秒耗时格式化为紧凑的中文时间。 */
function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

/** 用户正文与关联路径分开：人看文件名标签，复制/模型仍是完整路径。 */
function UserMessageText({
  text,
  onOpenFile,
}: {
  text: string;
  onOpenFile?: (path: string) => void;
}) {
  const { body, attachments } = splitUserAttachmentText(text);
  return (
    <div className="pi-user-text">
      {body ? <div className="whitespace-pre-wrap">{body}</div> : null}
      {attachments.length > 0 ? (
        <div
          className={`flex flex-wrap justify-end gap-1 ${body ? "mt-1.5" : ""}`}
        >
          {attachments.map((item) => (
            <button
              key={item.path}
              type="button"
              title={item.path}
              className="pi-user-file-chip"
              onClick={() => onOpenFile?.(item.path)}
            >
              <HugeiconsIcon
                icon={item.kind === "dir" ? Folder01Icon : File01Icon}
                size={10}
              />
              <span className="max-w-40 truncate">{item.name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 显示原始消息或工具内容，选中与搜索不改变输入焦点。 */
const TranscriptItem = memo(function TranscriptItem({
  item,
  actions,
  openForSearch = false,
  showActions = false,
}: {
  item: PiTranscriptItem;
  actions: MessageActions;
  openForSearch?: boolean;
  showActions?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(
    item.kind === "message" && item.role === "user" ? item.text : "",
  );
  const [editSubmitting, setEditSubmitting] = useState(false);
  useEffect(() => {
    if (openForSearch) setExpanded(true);
  }, [openForSearch]);
  useEffect(() => {
    if (item.kind === "message" && item.role === "user" && !editing)
      setEditText(item.text);
  }, [item, editing]);
  if (item.kind === "tool")
    return (
      <details
        data-pi-text={item.id}
        className="pi-tool"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="pi-tool-summary pi-record-summary cursor-pointer text-xs text-muted-foreground">
          <HugeiconsIcon icon={File01Icon} size={13} className="shrink-0" />
          <span
            className={`pi-tool-status ${item.status === "running" ? "pi-process-live" : ""}`}
          >
            {item.status === "running"
              ? "执行中"
              : item.status === "error"
                ? "执行失败"
                : "已完成"}
          </span>
          <span aria-hidden="true">·</span>
          <span className="pi-tool-command">
            {toolSummary(item).replace(/\s+/gu, " ")}
          </span>
        </summary>
        {expanded && (
          <div className="pi-tool-body reader-scrollbar max-h-80 overflow-auto">
            {item.args != null && (
              <>
                <div className="mb-1 text-[10px] text-muted-foreground">
                  调用参数
                </div>
                <pre className="mb-2 whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                  {JSON.stringify(item.args, null, 2)}
                </pre>
              </>
            )}
            <div className="mb-1 text-[10px] text-muted-foreground">
              执行结果
            </div>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs">
              {item.output || "等待工具结果…"}
            </pre>
          </div>
        )}
      </details>
    );
  const isUser = item.kind === "message" && item.role === "user";
  const isAssistant = item.kind === "message" && item.role === "assistant";
  return (
    <article
      className={
        isUser
          ? "pi-user-turn ml-auto w-fit max-w-[80%]"
          : isAssistant
            ? "pi-assistant-message min-w-0 py-2"
            : "min-w-0 py-2"
      }
    >
      <div
        className={
          isUser ? "pi-user-message rounded-2xl bg-muted px-3 py-2" : undefined
        }
      >
        <div
          data-pi-text={item.id}
          className={`pi-markdown select-text ${item.kind === "thinking" ? "text-muted-foreground" : ""}`}
        >
          {item.kind === "message" && item.role === "user" && editing ? (
            <Textarea
              autoFocus
              aria-label="编辑最后一条输入"
              value={editText}
              disabled={editSubmitting}
              className="pi-user-edit-input min-h-20 resize-y rounded-lg border-0 bg-transparent px-0 py-0 text-[13px] shadow-none focus-visible:ring-0"
              onChange={(event) => setEditText(event.target.value)}
            />
          ) : item.kind === "message" && item.role === "user" ? (
            <UserMessageText text={item.text} onOpenFile={actions.onOpenFile} />
          ) : (
            <Streamdown
              components={STREAMDOWN_COMPONENTS}
              controls={STREAMDOWN_CONTROLS}
            >
              {item.text}
            </Streamdown>
          )}
        </div>
        {item.kind === "message" &&
          item.images?.map((image, index) => (
            <ZoomableImage
              key={`${item.id}-${index}`}
              className="mt-2 max-h-60 max-w-full rounded-lg"
              src={`data:${image.mimeType};base64,${image.data}`}
              alt="用户附件"
            />
          ))}
      </div>
      {item.kind === "message" && item.role === "user" && editing && (
        <div className="pi-user-edit-actions mt-2 flex justify-end gap-1">
          <Button
            variant="ghost"
            size="xs"
            disabled={editSubmitting}
            onClick={() => {
              setEditText(item.text);
              setEditing(false);
            }}
          >
            取消
          </Button>
          <Button
            size="xs"
            disabled={editSubmitting || !editText.trim()}
            onClick={async () => {
              if (!actions.onEdit || editSubmitting) return;
              setEditSubmitting(true);
              try {
                const accepted = await actions.onEdit(item, editText.trim());
                if (accepted !== false) setEditing(false);
              } catch {
                // 保留编辑态，父层负责展示原生操作错误。
              } finally {
                setEditSubmitting(false);
              }
            }}
          >
            发送
          </Button>
        </div>
      )}
      {item.kind === "message" && showActions && !editing && (
        <div className="pi-message-actions text-[10px] text-muted-foreground">
          {item.timestamp !== undefined && (
            <time
              dateTime={new Date(item.timestamp).toISOString()}
              title={new Date(item.timestamp).toLocaleString()}
            >
              {new Date(item.timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            title="复制消息"
            aria-label="复制消息"
            onClick={() => actions.onCopy?.(item.text)}
          >
            <HugeiconsIcon icon={Copy01Icon} size={13} />
          </Button>
          {item.role === "user" &&
            item.id === actions.lastUserId &&
            actions.canEditLastUser && (
              <Button
                variant="ghost"
                size="icon-xs"
                title="编辑最后一条输入"
                aria-label="编辑最后一条输入"
                onClick={() => {
                  setEditText(item.text);
                  setEditing(true);
                }}
              >
                <HugeiconsIcon icon={PencilEdit01Icon} size={13} />
              </Button>
            )}
          {item.role === "assistant" && !item.streaming && (
            <Button
              variant="ghost"
              size="icon-xs"
              title="从此线程分叉"
              aria-label="从此线程分叉"
              onClick={actions.onFork}
            >
              <HugeiconsIcon icon={GitForkIcon} size={13} />
            </Button>
          )}
        </div>
      )}
    </article>
  );
});

/** 保留单条思考的独立折叠，搜索命中时才主动展开。 */
function ThinkingDetail({
  item,
  openForSearch,
}: {
  item: PiThinkingItem;
  openForSearch: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (openForSearch) setExpanded(true);
  }, [openForSearch]);
  return (
    <details
      className="pi-process-step"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="pi-record-summary cursor-pointer text-xs text-muted-foreground">
        <HugeiconsIcon icon={PencilEdit01Icon} size={13} className="shrink-0" />
        <span className="pi-record-preview">{activityPreview(item)}</span>
      </summary>
      {expanded && (
        <div
          data-pi-text={item.id}
          className="pi-process-step-body pi-markdown select-text"
        >
          <Streamdown
            components={STREAMDOWN_COMPONENTS}
            controls={STREAMDOWN_CONTROLS}
          >
            {item.text}
          </Streamdown>
        </div>
      )}
    </details>
  );
}

/** 封装内按时间直接呈现单行记录，点击记录才展开完整内容。 */
function ActivityGroup({
  items,
  actions,
  openForSearch,
}: {
  items: PiTranscriptItem[];
  actions: MessageActions;
  openForSearch?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const current = currentActivity(items);
  const transitionKey = current
    ? `${current.id}:${current.kind === "tool" ? current.status : current.streaming}`
    : "waiting";
  const matched = items.some((item) => item.id === openForSearch);
  useEffect(() => {
    if (matched) setExpanded(true);
  }, [matched]);
  return (
    <details
      className="pi-activity min-w-0 max-w-full"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="pi-activity-summary cursor-pointer py-1 text-xs text-muted-foreground hover:text-foreground">
        <span
          key={transitionKey}
          className="pi-record-preview pi-summary-transition"
        >
          {activitySummary(current)}
        </span>
      </summary>
      <div className="pl-4">
        {items.map((item) =>
          item.kind === "thinking" ? (
            <ThinkingDetail
              key={item.id}
              item={item}
              openForSearch={item.id === openForSearch}
            />
          ) : (
            <TranscriptItem
              key={item.id}
              item={item}
              actions={actions}
              openForSearch={item.id === openForSearch}
            />
          ),
        )}
      </div>
    </details>
  );
}

/** 展示 Codex 风格的单行过程摘要，详细步骤只在用户展开后显示。 */
function TimelineBlock({
  block,
  query,
  actions,
  cwd,
}: {
  cwd: string;
  block: PiTimelineBlock;
  query: string;
  actions: MessageActions;
}) {
  const isProcess = block.kind === "process";
  const blockRunning = isProcess ? block.running : false;
  const [expanded, setExpanded] = useState(blockRunning);
  const userToggled = useRef(false);
  const [now, setNow] = useState(Date.now());
  const blockFinishedAt = isProcess ? block.finishedAt : undefined;
  const searchExpanded =
    isProcess &&
    !!query &&
    block.items.some((item) =>
      itemText(item).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    );
  useEffect(() => {
    if (searchExpanded) setExpanded(true);
  }, [searchExpanded]);
  useEffect(() => {
    if (userToggled.current || !isProcess) return;
    setExpanded(blockRunning);
  }, [blockRunning, isProcess]);
  useEffect(() => {
    if (!isProcess || !blockRunning || blockFinishedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isProcess, blockRunning, blockFinishedAt]);
  if (block.kind === "item")
    return (
      <TranscriptItem
        item={block.item}
        actions={actions}
        showActions={block.item.kind === "message"}
      />
    );
  const tools = block.items.filter((item) => item.kind === "tool");
  const searchItem = searchExpanded
    ? block.items.find((item) =>
        itemText(item).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      )
    : undefined;
  const firstStarted = block.startedAt;
  const lastFinished = block.finishedAt;
  let elapsed: number | null = null;
  if (firstStarted != null) {
    if (block.running) elapsed = Math.max(0, now - firstStarted);
    else if (lastFinished != null)
      elapsed = Math.max(0, lastFinished - firstStarted);
  }
  const elapsedText =
    elapsed === null ? "" : ` · 用时 ${formatElapsed(elapsed)}`;
  return (
    <>
      <details className="pi-process" open={expanded}>
        <summary
          className="pi-process-summary flex max-w-full cursor-pointer list-none items-center gap-2 py-1.5 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
          onClick={(event) => {
            event.preventDefault();
            userToggled.current = true;
            setExpanded((value) => !value);
          }}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={12} />
          <span
            className={`pi-process-title ${block.running ? "pi-process-live" : ""}`}
          >
            {block.label}
          </span>
          <span className="pi-process-meta">
            {block.items.length
              ? `${block.items.length} 个步骤${tools.length ? ` · ${tools.length} 次工具调用` : ""}`
              : "等待模型响应"}
            {elapsedText}
          </span>
        </summary>
        <div className="pi-process-body pl-5">
          {block.steps.map((step) => (
            <ProcessStep
              key={step.id}
              step={step}
              actions={actions}
              activitySearchId={
                step.kind === "activity" ? searchItem?.id : undefined
              }
            />
          ))}
        </div>
      </details>
      <PiFileOperations
        items={block.items}
        cwd={cwd}
        onOpenFile={actions.onOpenFile}
      />
    </>
  );
}

/** 过程正文直接展示，思考和工具统一交由活动折叠项呈现。 */
function ProcessStep({
  step,
  actions,
  activitySearchId,
}: {
  step: PiTimelineStep;
  actions: MessageActions;
  activitySearchId?: string;
}) {
  if (step.kind === "activity")
    return (
      <ActivityGroup
        items={step.items ?? []}
        actions={actions}
        openForSearch={activitySearchId}
      />
    );
  return step.item ? (
    <TranscriptItem item={step.item} actions={actions} showActions={false} />
  ) : null;
}

/** 收集渲染正文中的命中范围，可跨 Markdown 内联节点。 */
function textRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const spans: { node: Text; start: number; end: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const current = node as Text;
    spans.push({
      node: current,
      start: text.length,
      end: text.length + current.length,
    });
    text += current.data;
    node = walker.nextNode();
  }
  return findLiteralMatches(text, query, { caseSensitive: false }).flatMap(
    (offset) => {
      const start = spans.find(
        (span) => offset >= span.start && offset < span.end,
      );
      const end = spans.find(
        (span) =>
          offset + query.length > span.start &&
          offset + query.length <= span.end,
      );
      if (!start || !end) return [];
      const range = document.createRange();
      range.setStart(start.node, offset - start.start);
      range.setEnd(end.node, offset + query.length - end.start);
      return [range];
    },
  );
}

/** 虚拟化会话内容，借鉴 Zeno 将主动翻阅与流式自动跟随分离。 */
export function PiTranscript({
  view,
  loading = false,
  sendRevision = 0,
  threadKey,
  cwd = "",
  active,
  searchOpen,
  onCloseSearch,
  onCopy,
  onEdit,
  onFork,
  onOpenFile,
  onLoadOlder,
  canEditLastUser,
}: {
  view: PiViewState;
  loading?: boolean;
  sendRevision?: number;
  threadKey: string;
  cwd?: string;
  active: boolean;
  searchOpen: boolean;
  onCloseSearch: () => void;
  onLoadOlder?: () => void;
} & MessageActions) {
  const actions: MessageActions = useMemo(
    () => ({
      onCopy,
      onEdit,
      onFork,
      onOpenFile,
      canEditLastUser,
      lastUserId: [...view.items]
        .reverse()
        .find((item) => item.kind === "message" && item.role === "user")?.id,
    }),
    [view.items, onCopy, onEdit, onFork, onOpenFile, canEditLastUser],
  );
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const positions = useRef(new Map<string, { top: number; follow: boolean }>());
  const [following, setFollowing] = useState(true);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [jump, setJump] = useState(0);
  const appliedJump = useRef(0);
  const revealPending = useRef(false);
  const seenSends = useRef(new Map<string, number>());
  const loadingOlder = useRef(false);
  const pendingOlderRestore = useRef<number | null>(null);
  const running = view.status === "running" || view.status === "stopping";
  const blocks = useMemo(
    () =>
      buildTimelineBlocks(view.items, running, {
        startedAt: view.processStartedAt,
        finishedAt: view.processFinishedAt,
      }),
    [view.items, running, view.processStartedAt, view.processFinishedAt],
  );
  const matches = useMemo(
    () =>
      query
        ? blocks.flatMap((block, blockIndex) =>
            (block.kind === "process" ? block.items : [block.item]).flatMap(
              (item) =>
                findLiteralMatches(itemText(item), query, {
                  caseSensitive: false,
                }).map((_, occurrence) => ({
                  blockIndex,
                  itemId: item.id,
                  occurrence,
                })),
            ),
          )
        : [],
    [blocks, query],
  );
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => viewport.current,
    getItemKey: (index) => blocks[index].id,
    estimateSize: () => 110,
    overscan: 4,
    enabled: active,
    useAnimationFrameWithResizeObserver: true,
    useFlushSync: false,
  });
  /** 用户主动开始翻阅时暂停滚动跟随。 */
  const pauseFollow = () => {
    follow.current = false;
    setFollowing(false);
  };
  /** 顶部滚轮也可翻页，内容不足一屏时无需等待 scroll 事件。 */
  const loadEarlier = () => {
    const node = viewport.current;
    if (
      !node ||
      node.scrollTop >= 80 ||
      !view.historyHasMore ||
      loading ||
      view.historyLoadingMore ||
      loadingOlder.current ||
      !onLoadOlder
    )
      return;
    pauseFollow();
    loadingOlder.current = true;
    pendingOlderRestore.current = virtualizer.getTotalSize();
    onLoadOlder();
  };
  const transcriptSize = virtualizer.getTotalSize();
  /** 钉在最后一块真实底边，避免估高把视口停在中部。 */
  const pinBottom = () => {
    const node = viewport.current;
    if (!node) return;
    const last = blocks.length - 1;
    if (last >= 0) virtualizer.scrollToIndex(last, { align: "end" });
    node.scrollTop = node.scrollHeight;
  };
  /** 返回最新消息并重新启用后续流式跟随。 */
  const scrollBottom = () => {
    follow.current = true;
    setFollowing(true);
    pinBottom();
  };
  useLayoutEffect(() => {
    const node = viewport.current;
    const position = positions.current.get(threadKey);
    pendingOlderRestore.current = null;
    loadingOlder.current = false;
    follow.current = position?.follow ?? true;
    setFollowing(follow.current);
    setQuery("");
    setHit(0);
    if (follow.current) pinBottom();
    else if (node && position) node.scrollTop = position.top;
    return () => {
      if (node)
        positions.current.set(threadKey, {
          top: follow.current ? 0 : node.scrollTop,
          follow: follow.current,
        });
    };
  }, [threadKey]);
  useLayoutEffect(() => {
    if (!sendRevision || seenSends.current.get(threadKey) === sendRevision)
      return;
    seenSends.current.set(threadKey, sendRevision);
    follow.current = true;
    setFollowing(true);
    setQuery("");
    appliedJump.current = jump;
    revealPending.current = false;
    pinBottom();
  }, [threadKey, sendRevision, jump]);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const previous = pendingOlderRestore.current;
    if (previous != null && !view.historyLoadingMore) {
      node.scrollTop += transcriptSize - previous;
      pendingOlderRestore.current = null;
      loadingOlder.current = false;
      return;
    }
    if (active && follow.current) pinBottom();
  }, [active, view.items, view.historyLoadingMore, transcriptSize]);
  useEffect(() => {
    const node = viewport.current;
    const body = content.current;
    if (!active || !node) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (follow.current) pinBottom();
      });
    });
    observer.observe(node);
    if (body) observer.observe(body);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [active, threadKey]);
  useLayoutEffect(() => {
    if (jump === appliedJump.current || !matches.length) return;
    appliedJump.current = jump;
    revealPending.current = true;
    follow.current = false;
    setFollowing(false);
    virtualizer.scrollToIndex(matches[hit % matches.length].blockIndex, {
      align: "center",
    });
    // 仅用户搜索动作触发定位，流式输出不会重新跳转。
  }, [jump, matches, hit, virtualizer]);
  useLayoutEffect(() => {
    if (!active || !content.current || !CSS.highlights) return;
    const ranges: Range[] = [];
    const current: Range[] = [];
    const target = matches[hit % matches.length];
    for (const node of content.current.querySelectorAll<HTMLElement>(
      "[data-pi-text]",
    )) {
      if (
        searchOpen &&
        query &&
        node instanceof HTMLDetailsElement &&
        node.textContent
          ?.toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())
      )
        node.open = true;
      const found = textRanges(node, searchOpen ? query : "");
      ranges.push(...found);
      if (target?.itemId === node.dataset.piText && found[target.occurrence])
        current.push(found[target.occurrence]);
    }
    CSS.highlights.set("codev-pi-search", new Highlight(...ranges));
    CSS.highlights.set("codev-pi-search-current", new Highlight(...current));
    if (revealPending.current && current[0] && viewport.current) {
      const rect = current[0].getBoundingClientRect();
      if (rect.height > 0) {
        const node = viewport.current;
        node.scrollTop +=
          rect.top -
          node.getBoundingClientRect().top -
          node.clientHeight / 2 +
          rect.height / 2;
        revealPending.current = false;
      }
    }
    return () => {
      CSS.highlights.delete("codev-pi-search");
      CSS.highlights.delete("codev-pi-search-current");
    };
  });
  /** 导航到上一处或下一处命中，同时展开目标工具详情。 */
  const navigate = (direction: number) => {
    setHit((value) =>
      matches.length
        ? (value + direction + matches.length) % matches.length
        : 0,
    );
    setJump((value) => value + 1);
  };
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-busy={loading}
    >
      {loading && (
        <div
          data-testid="pi-history-loading"
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground"
        >
          <Spinner className="size-6" aria-label="正在加载线程" />
          <span className="text-xs">正在加载线程…</span>
        </div>
      )}
      {searchOpen && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
          <HugeiconsIcon icon={Search01Icon} size={14} />
          <Input
            aria-label="搜索当前线程"
            autoFocus
            placeholder="搜索当前线程"
            className="h-7 min-w-0 flex-1 rounded-lg text-xs!"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHit(0);
              setJump((value) => value + 1);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                navigate(event.shiftKey ? -1 : 1);
              }
              if (event.key === "Escape") onCloseSearch();
            }}
          />
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {matches.length ? (hit % matches.length) + 1 : 0}/{matches.length}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="上一处"
            onClick={() => navigate(-1)}
          >
            <HugeiconsIcon icon={ArrowUp01Icon} size={12} />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="下一处"
            onClick={() => navigate(1)}
          >
            <HugeiconsIcon icon={ArrowDown01Icon} size={12} />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="关闭搜索"
            onClick={onCloseSearch}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} />
          </Button>
        </div>
      )}
      <div
        ref={viewport}
        tabIndex={0}
        data-testid="pi-transcript"
        className="reader-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none [overflow-anchor:none]"
        onWheel={(event) => {
          if (event.deltaY < 0) {
            pauseFollow();
            loadEarlier();
          }
        }}
        onPointerDown={pauseFollow}
        onKeyDown={(event) => {
          if (["PageUp", "ArrowUp", "Home"].includes(event.key)) {
            pauseFollow();
            loadEarlier();
          }
        }}
        onScroll={(event) => {
          const node = event.currentTarget;
          if (!follow.current) loadEarlier();
          if (
            !loadingOlder.current &&
            !view.historyLoadingMore &&
            node.scrollTop > 0 &&
            node.scrollHeight - node.scrollTop - node.clientHeight < 32
          ) {
            follow.current = true;
            setFollowing(true);
          }
        }}
      >
        {!blocks.length && (
          <div className="flex h-full min-h-24 flex-col items-center justify-center gap-2 px-5 text-center">
            <span className="text-base font-medium">从一个任务开始</span>
            <span className="text-xs text-muted-foreground">
              选择项目，在下方输入任务或恢复已有线程。
            </span>
          </div>
        )}
        <div
          ref={content}
          className="relative mx-auto w-full max-w-3xl"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {view.historyLoadingMore && (
            <div className="px-4 py-2 text-center text-[11px] text-muted-foreground">
              正在加载更早记录…
            </div>
          )}
          {virtualizer.getVirtualItems().map((row) => (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full px-4 py-2"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <TimelineBlock
                cwd={cwd}
                block={blocks[row.index]}
                query={searchOpen ? query : ""}
                actions={actions}
              />
            </div>
          ))}
        </div>
      </div>
      {!following && !!blocks.length && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 gap-1 shadow"
          onClick={scrollBottom}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={13} />
          回到最新
        </Button>
      )}
    </div>
  );
}
