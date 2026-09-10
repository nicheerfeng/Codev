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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
} from "@hugeicons/core-free-icons";
import { findLiteralMatches } from "@/modules/editor/lib/textSearch";
import {
  buildTimelineBlocks,
  itemText,
  type PiTimelineBlock,
} from "./timeline";
import type { PiMessageItem, PiTranscriptItem, PiViewState } from "./types";

type MessageActions = {
  onCopy?: (text: string) => void;
  onEdit?: (item: PiMessageItem) => void;
  onFork?: (item: PiMessageItem) => void;
  lastUserId?: string;
};

/** 显示原始消息或工具内容，选中与搜索不改变输入焦点。 */
const TranscriptItem = memo(function TranscriptItem({
  item,
  actions,
}: {
  item: PiTranscriptItem;
  actions: MessageActions;
}) {
  if (item.kind === "tool")
    return (
      <details
        data-pi-text={item.id}
        className="my-2 rounded-lg border border-border/60 bg-muted/20"
      >
        <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
          <span className={item.status === "running" ? "text-[#8eacc9]" : ""}>
            {item.status === "running"
              ? "执行中"
              : item.status === "error"
                ? "执行失败"
                : "已完成"}
          </span>{" "}
          · {item.name}
        </summary>
        <div className="reader-scrollbar max-h-80 overflow-auto border-t border-border/50 px-3 py-2">
          {item.args != null && (
            <pre className="mb-2 whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
              {JSON.stringify(item.args, null, 2)}
            </pre>
          )}
          <pre className="whitespace-pre-wrap break-all font-mono text-xs">
            {item.output || "等待工具结果…"}
          </pre>
        </div>
      </details>
    );
  return (
    <article
      className={
        item.kind === "message" && item.role === "user"
          ? "ml-auto max-w-[90%] rounded-2xl bg-muted px-4 py-3"
          : "min-w-0 py-2"
      }
    >
      <div
        data-pi-text={item.id}
        className={`pi-markdown select-text ${item.kind === "thinking" ? "text-muted-foreground" : ""}`}
      >
        {item.kind === "message" && item.role === "user" ? (
          <div className="whitespace-pre-wrap">{item.text}</div>
        ) : (
          <Streamdown>{item.text}</Streamdown>
        )}
      </div>
      {item.kind === "message" &&
        item.images?.map((image, index) => (
          <img
            key={`${item.id}-${index}`}
            className="mt-2 max-h-60 max-w-full rounded-lg"
            src={`data:${image.mimeType};base64,${image.data}`}
            alt="用户附件"
          />
        ))}
      {item.kind === "message" && (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
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
          {item.role === "user" && item.id === actions.lastUserId && (
            <Button
              variant="ghost"
              size="icon-xs"
              title="停止并编辑此输入"
              aria-label="编辑最后一条输入"
              onClick={() => actions.onEdit?.(item)}
            >
              <HugeiconsIcon icon={PencilEdit01Icon} size={13} />
            </Button>
          )}
          {!item.streaming && (
            <Button
              variant="ghost"
              size="icon-xs"
              title="分叉当前线程"
              aria-label="分叉当前线程"
              onClick={() => actions.onFork?.(item)}
            >
              <HugeiconsIcon icon={GitForkIcon} size={13} />
            </Button>
          )}
        </div>
      )}
    </article>
  );
});

/** 展示一轮的可折叠过程，运行标记和展开状态相互独立。 */
function TimelineBlock({
  block,
  query,
  actions,
}: {
  block: PiTimelineBlock;
  query: string;
  actions: MessageActions;
}) {
  const [expanded, setExpanded] = useState(false);
  if (block.kind === "item")
    return <TranscriptItem item={block.item} actions={actions} />;
  const searchExpanded =
    !!query &&
    block.items.some((item) =>
      itemText(item).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    );
  const open = expanded || searchExpanded;
  const tools = block.items.filter((item) => item.kind === "tool");
  const live = tools.find(
    (item) => item.kind === "tool" && item.status === "running",
  );
  return (
    <div className="py-2">
      <button
        type="button"
        aria-expanded={open}
        className="flex max-w-full items-center gap-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded(!expanded)}
      >
        <HugeiconsIcon
          icon={open ? ArrowUp01Icon : ArrowDown01Icon}
          size={12}
        />
        <span className={block.running ? "text-[#8eacc9]" : ""}>
          {block.running
            ? live?.kind === "tool"
              ? `正在执行 ${live.name}`
              : "处理中"
            : "已处理"}
        </span>
        <span>
          {block.items.length} 个步骤
          {tools.length ? ` · ${tools.length} 次工具调用` : ""}
        </span>
      </button>
      {open && (
        <div className="ml-1.5 border-l border-border pl-4">
          {block.items.map((item) => (
            <TranscriptItem key={item.id} item={item} actions={actions} />
          ))}
        </div>
      )}
    </div>
  );
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
  active,
  searchOpen,
  onCloseSearch,
  onCopy,
  onEdit,
  onFork,
}: {
  view: PiViewState;
  loading?: boolean;
  sendRevision?: number;
  threadKey: string;
  active: boolean;
  searchOpen: boolean;
  onCloseSearch: () => void;
} & MessageActions) {
  const actions: MessageActions = useMemo(
    () => ({
      onCopy,
      onEdit,
      onFork,
      lastUserId: [...view.items]
        .reverse()
        .find((item) => item.kind === "message" && item.role === "user")?.id,
    }),
    [view.items, onCopy, onEdit, onFork],
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
  const running = view.status === "running" || view.status === "stopping";
  const blocks = useMemo(
    () => buildTimelineBlocks(view.items, running),
    [view.items, running],
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
  /** 返回最新消息并重新启用后续流式跟随。 */
  const scrollBottom = () => {
    follow.current = true;
    setFollowing(true);
    const node = viewport.current;
    if (node) node.scrollTop = node.scrollHeight;
  };
  useLayoutEffect(() => {
    const node = viewport.current;
    const position = positions.current.get(threadKey);
    follow.current = position?.follow ?? true;
    setFollowing(follow.current);
    setQuery("");
    setHit(0);
    if (node) node.scrollTop = position?.top ?? node.scrollHeight;
    return () => {
      if (node)
        positions.current.set(threadKey, {
          top: node.scrollTop,
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
    const node = viewport.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [threadKey, sendRevision, jump]);
  useLayoutEffect(() => {
    if (active && follow.current) {
      const node = viewport.current;
      if (node) node.scrollTop = node.scrollHeight;
    }
  }, [active, view.items, virtualizer.getTotalSize()]);
  useEffect(() => {
    const node = viewport.current;
    if (!active || !node) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (follow.current) node.scrollTop = node.scrollHeight;
      });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [active]);
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
  useEffect(() => {
    if (!active || !query || !content.current) return;
    for (const details of content.current.querySelectorAll("details"))
      if (details.textContent?.toLowerCase().includes(query.toLowerCase()))
        details.open = true;
  }, [query, jump, active, view.items]);
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
          if (event.deltaY < 0) pauseFollow();
        }}
        onPointerDown={pauseFollow}
        onKeyDown={(event) => {
          if (["PageUp", "ArrowUp", "Home"].includes(event.key)) pauseFollow();
        }}
        onScroll={(event) => {
          const node = event.currentTarget;
          if (node.scrollHeight - node.scrollTop - node.clientHeight < 32) {
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
          {virtualizer.getVirtualItems().map((row) => (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full px-4 py-2"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <TimelineBlock
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
