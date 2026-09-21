import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { findLiteralMatches } from "@/modules/editor/lib/textSearch";
import { useVirtualizer } from "@tanstack/react-virtual";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Textarea } from "@/components/ui/textarea";
import { Streamdown, defaultRemarkPlugins } from "streamdown";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  Copy01Icon,
  GitForkIcon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ZoomableImage } from "@/modules/reader/ZoomableImage";
import { MarkdownTable } from "@/modules/markdown/MarkdownTable";
import { CodexFileLink, FileLinkContext, localFileLinks } from "./CodexFileLink";
import { Button } from "@/components/ui/button";
import { itemText, type Item, type Session, type Turn } from "./protocol";
import type { CodexClient } from "./client";
import { editableLastUser } from "./editLastUser";
import { Tool } from "./controls";
import { WebSearchDetails } from "./WebSearchDetails";
import {
  activityLabel,
  elapsedText,
  isCompaction,
  isTool,
  processLabel,
  toolOutput,
} from "./timeline";

const remarkPlugins = [...Object.values(defaultRemarkPlugins), localFileLinks];

const components = { a: CodexFileLink, img: ZoomableImage, table: MarkdownTable };

/** 删除记录定位原目录，其余文件交给主阅读器打开。 */
function openChangedFile(
  file: NonNullable<Item["changes"]>[number],
  onOpenFile?: (path: string) => void,
) {
  if (file.kind?.type === "delete" || !onOpenFile) void revealChangedFile(file);
  else onOpenFile(file.path);
}
/** 定位文件或已删除文件的父目录。 */
async function revealChangedFile(file: NonNullable<Item["changes"]>[number]) {
  try {
    await revealItemInDir(
      file.kind?.type === "delete"
        ? file.path.replace(/[\\/][^\\/]+$/, "/")
        : file.path,
    );
  } catch (error) {
    toast.error(String(error));
  }
}

/** 使用应用公共 Markdown 原语，Codex 的消息与折叠逻辑保持独立。 */
function Markdown({ text }: { text: string }) {
  return (
    <div className="codex-markdown">
      <Streamdown
        components={components}
        remarkPlugins={remarkPlugins}
        controls={{ code: { copy: true, download: false }, table: false }}
      >
        {text}
      </Streamdown>
    </div>
  );
}

/** 消息正文保持可读，复制入口在悬停时展示。 */
function Message({
  item,
  timestamp,
  onFork,
  forkDisabled,
  onEdit,
  onOpenFile,
}: {
  item: Item;
  timestamp?: number | null;
  onFork: () => void;
  forkDisabled: boolean;
  onEdit?: (text: string) => Promise<void>;
  onOpenFile?: (path: string) => void;
}) {
  const text = itemText(item);
  const user = item.type === "userMessage";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const canEdit = Boolean(onEdit) && !forkDisabled;
  useEffect(() => {
    if (!canEdit && !saving) setEditing(false);
  }, [canEdit, saving]);
  const images = user
    ? (
        (item.content as Array<{
          type: string;
          path?: string;
          url?: string;
        }>) ?? []
      ).filter((part) => part.type === "localImage" || part.type === "image")
    : [];
  return (
    <div
      data-codex-item={item.id}
      className={`codex-message ${user ? "codex-user-turn" : ""}`}
    >
      <div className={user ? "codex-user" : ""}>
        {user ? (
          <>
            {editing ? (
              <>
                <Textarea
                  autoFocus
                  aria-label="编辑最后一条输入"
                  value={draft}
                  disabled={saving}
                  className="min-h-20 resize-y rounded-lg border-0 bg-transparent px-0 py-0 text-[13px] shadow-none focus-visible:ring-0"
                  onChange={(event) => setDraft(event.target.value)}
                />
              </>
            ) : (
              <span className="whitespace-pre-wrap">
                {text.split(/\n/).map((line, index) => {
                  const match = /^- 关联(文件|目录) (.+)$/.exec(line);
                  return (
                    <span key={`${index}-${line}`} className="block">
                      {match ? (
                        <button
                          type="button"
                          className="codex-user-file-chip"
                          title={match[2]}
                          onClick={() => onOpenFile?.(match[2])}
                        >
                          {match[1]} ·{" "}
                          {match[2].replace(/\\/g, "/").split("/").pop()}
                        </button>
                      ) : (
                        line
                      )}
                    </span>
                  );
                })}
              </span>
            )}
            {images.map((part, index) => (
              <ZoomableImage
                key={part.path ?? part.url ?? index}
                src={part.path ? convertFileSrc(part.path) : part.url}
                alt="会话图片"
                className="max-h-48 max-w-full rounded-lg"
              />
            ))}
          </>
        ) : (
          <Markdown text={text} />
        )}
      </div>
      {user && editing && (
        <div className="mt-2 flex justify-end gap-1">
          <Button
            variant="ghost"
            size="xs"
            disabled={saving}
            onClick={() => {
              setDraft(text);
              setEditing(false);
            }}
          >
            取消
          </Button>
          <Button
            size="xs"
            disabled={saving || !canEdit || !draft.trim()}
            onClick={() => {
              if (!onEdit || saving) return;
              setSaving(true);
              void onEdit(draft.trim())
                .then(() => setEditing(false))
                .catch((error) => toast.error(String(error)))
                .finally(() => setSaving(false));
            }}
          >
            发送
          </Button>
        </div>
      )}
      {!editing && (
        <div className="codex-message-actions">
          {timestamp != null && (
            <time
              dateTime={new Date(timestamp * 1000).toISOString()}
              title={new Date(timestamp * 1000).toLocaleString()}
            >
              {new Date(timestamp * 1000).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          )}
          <Tool
            icon={Copy01Icon}
            label="复制消息"
            onClick={() =>
              void writeText(text).catch((error) => toast.error(String(error)))
            }
          />
          {!user && (
            <Tool
              icon={GitForkIcon}
              label="从此轮分叉"
              disabled={forkDisabled}
              onClick={onFork}
            />
          )}
          {user && canEdit && (
            <Button
              size="icon-xs"
              variant="ghost"
              title="编辑最后一条输入"
              aria-label="编辑最后一条输入"
              onClick={() => {
                setDraft(text);
                setEditing(true);
              }}
            >
              <HugeiconsIcon icon={PencilEdit01Icon} size={13} />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** 单条工具或思考保留自己的原生 detail 折叠。 */
function Activity({
  item,
  onOpenFile,
  query,
}: {
  item: Item;
  onOpenFile?: (path: string) => void;
  query: string;
}) {
  const text = itemText(item);
  return (
    <details
      data-codex-item={item.id}
      className="codex-activity"
      open={query ? true : undefined}
    >
      <summary>
        <HugeiconsIcon icon={ArrowDown01Icon} size={12} />
        <span>{activityLabel(item)}</span>

      </summary>
      <div className="codex-activity-body">
        {item.type === "reasoning" ? (
          <Markdown text={text} />
        ) : item.type === "webSearch" ? (
          <WebSearchDetails item={item} />
        ) : item.changes ? (
          item.changes.map((change) => (
            <div key={change.path}>
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => openChangedFile(change, onOpenFile)}
              >
                {change.path}
              </button>
              <pre>{change.diff}</pre>
            </div>
          ))
        ) : (
          <>
            {toolOutput(item) && <pre>{toolOutput(item)}</pre>}
            <details open={query ? true : undefined}>
              <summary className="cursor-pointer text-[10px]">调用详情</summary>
              <pre>{JSON.stringify(item, null, 2)}</pre>
            </details>
          </>
        )}
      </div>
    </details>
  );
}

/** 连续思考和执行封装为一行真实摘要，点击后保留原始内部折叠行。 */
function ActivityGroup({
  items,
  onOpenFile,
  query,
}: {
  items: Item[];
  onOpenFile?: (path: string) => void;
  query: string;
}) {
  const latest = items[items.length - 1];
  return (
    <details className="codex-activity-group" open={query ? true : undefined}>
      <summary className="codex-activity-summary">
        <HugeiconsIcon icon={ArrowDown01Icon} size={12} />
        <span key={latest.id} className="codex-summary-transition">
          {activityLabel(latest)}
        </span>
      </summary>
      <div className="pl-4">
        {items.map((item) => (
          <Activity
            key={item.id}
            item={item}
            onOpenFile={onOpenFile}
            query={query}
          />
        ))}
      </div>
    </details>
  );
}

/** 一轮过程中的沟通默认在运行时可见，结束后收起过程而保留最终答复。 */
function Process({
  items,
  running,
  query,
  onOpenFile,
  turn,
}: {
  items: Item[];
  running: boolean;
  query: string;
  onOpenFile?: (path: string) => void;
  turn: Turn;
}) {
  const [expanded, setExpanded] = useState(running);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setExpanded(running);
  }, [running]);
  const steps: Array<{ id: string; items: Item[]; message: boolean }> = [];
  for (const item of items) {
    if (isCompaction(item)) continue;
    const message = item.type === "agentMessage" || item.type === "plan";
    const previous = steps[steps.length - 1];
    if (!message && previous && !previous.message) previous.items.push(item);
    else steps.push({ id: item.id, items: [item], message });
  }
  const visibleItems = items.filter((item) => !isCompaction(item));
  const tools = visibleItems.filter(isTool).length;
  const elapsed = elapsedText(turn, running, now);
  const files = [
    ...new Map(
      items
        .flatMap((item) => item.changes ?? [])
        .map((change) => [change.path, change]),
    ).values(),
  ];
  return (
    <>
      <details className="codex-process" open={expanded || Boolean(query)}>
        <summary
          className="codex-process-summary flex max-w-full cursor-pointer list-none items-center gap-2 py-1.5 text-xs font-normal text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
          onClick={(event) => {
            event.preventDefault();
            touched.current = true;
            setExpanded(!expanded);
          }}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={12} />
          <span
            className={`codex-process-state ${running ? "codex-live" : ""}`}
          >
            {processLabel(turn, running)}
          </span>
          <span className="codex-process-meta">
            {visibleItems.length
              ? `${visibleItems.length} 个步骤${tools ? ` · ${tools} 次工具调用` : ""}`
              : "等待模型响应"}
            {elapsed ? ` · 用时 ${elapsed}` : ""}
          </span>
        </summary>
        <div className="codex-process-body">
          {steps.map((step) =>
            step.message ? (
              <Markdown key={step.id} text={itemText(step.items[0])} />
            ) : (
              <ActivityGroup
                key={step.id}
                items={step.items}
                onOpenFile={onOpenFile}
                query={query}
              />
            ),
          )}
        </div>
      </details>
      {files.length > 0 && (
        <details className="codex-file-summary my-1 min-w-0 text-xs font-normal text-muted-foreground">
          <summary className="flex cursor-pointer list-none items-center gap-2 py-1 leading-6 [overflow-wrap:anywhere] [&::-webkit-details-marker]:hidden">
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={12}
              className="shrink-0"
            />
            <span className="min-w-0">
              修改观测 · {files.length} 个文件：
              {files
                .map((file) => file.path.replace(/\\/g, "/").split("/").pop())
                .join("、")}
            </span>
          </summary>
          <div className="space-y-1 py-1 pl-5">
            {files.map((file) => (
              <details key={file.path}>
                <summary className="truncate">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      openChangedFile(file, onOpenFile);
                    }}
                  >
                    {file.kind?.type === "add"
                      ? "新增"
                      : file.kind?.type === "delete"
                        ? "删除"
                        : "修改"}{" "}
                    · {file.path}
                  </button>
                </summary>
                <button
                  type="button"
                  className="text-xs text-muted-foreground"
                  onClick={() => void revealChangedFile(file)}
                >
                  在资源管理器中显示
                </button>
                <pre>{file.diff}</pre>
              </details>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

/** 按 Codex phase 识别最终答复，历史缺少 phase 时使用最后一条助手消息。 */
function TurnView({
  turn,
  running,
  query,
  onOpenFile,
  onFork,
  forkDisabled,
  onEdit,
  editableId,
}: {
  turn: Turn;
  running: boolean;
  query: string;
  onOpenFile?: (path: string) => void;
  onFork: () => void;
  forkDisabled: boolean;
  onEdit?: (text: string) => Promise<void>;
  editableId?: string;
}) {
  const last = [...turn.items]
    .reverse()
    .find((item) => item.type === "agentMessage");
  const blocks: Array<{ id: string; process: boolean; items: Item[] }> = [];
  for (const item of turn.items) {
    if (isCompaction(item)) continue;
    if (["agentMessage", "reasoning", "plan"].includes(item.type) && !itemText(item).trim()) continue;
    const message =
      item.type === "userMessage" ||
      (item.type === "agentMessage" &&
        (item.phase === "final_answer" ||
          (!running && item.phase == null && item.id === last?.id)));
    const previous = blocks[blocks.length - 1];
    if (!message && previous?.process) previous.items.push(item);
    else blocks.push({ id: item.id, process: !message, items: [item] });
  }
  return (
    <>
      {blocks.map((block) =>
        block.process ? (
          <Process
            key={block.id}
            items={block.items}
            turn={turn}
            running={running}
            query={query}
            onOpenFile={onOpenFile}
          />
        ) : (
          <Message
            onEdit={
              block.items[0].id === editableId &&
              block.items[0].type === "userMessage"
                ? onEdit
                : undefined
            }
            onOpenFile={onOpenFile}
            key={block.id}
            item={block.items[0]}
            timestamp={
              block.items[0].type === "userMessage"
                ? turn.startedAt
                : turn.completedAt
            }
            onFork={onFork}
            forkDisabled={forkDisabled || running}
          />
        ),
      )}
      {running && !blocks.some((block) => block.process) && (
        <Process items={[]} turn={turn} running query={query} />
      )}
    </>
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

/** 按轮次虚拟渲染，保持阅读位置并定位搜索命中。 */
export function CodexTranscript({
  session,
  client,
  search,
  onOpenFile,
  onFork,
  active = true,
}: {
  session: Session;
  client: CodexClient;
  search: string;
  onOpenFile?: (path: string) => void;
  onFork: (id: string) => void;
  active?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const saved = useRef(client.scrollPositions.get(session.thread.id)).current;
  const follow = useRef(saved?.follow ?? true);
  const [atBottom, setAtBottom] = useState(follow.current);
  const [hit, setHit] = useState(0);
  const [jump, setJump] = useState(0);
  const appliedJump = useRef(-1);
  const olderHeight = useRef<number | null>(null);
  const query = search.trim();
  const turns = session.thread.turns;
  const editable =
    client.getSnapshot().connected && !client.getSnapshot().switching
      ? editableLastUser(session)
      : undefined;
  const matches = useMemo(
    () =>
      query
        ? turns.flatMap((turn, index) =>
            turn.items.flatMap((item) =>
              findLiteralMatches(
                [
                  itemText(item),
                  toolOutput(item),
                  ...(item.changes?.map((change) => change.diff) ?? []),
                ].join("\n"),
                query,
                { caseSensitive: false },
              ).map((_, occurrence) => ({
                index,
                itemId: item.id,
                occurrence,
              })),
            ),
          )
        : [],
    [turns, query],
  );
  const virtual = useVirtualizer({
    count: turns.length,
    getScrollElement: () => root.current,
    getItemKey: (index) => turns[index].id,
    estimateSize: () => 300,
    overscan: 3,
    enabled: active,
    useAnimationFrameWithResizeObserver: true,
  });
  const size = virtual.getTotalSize();
  const highlightKey = `codex-search-${session.thread.id}`;
  /** 发送与返回底部重新启用追底。 */
  const bottom = () => {
    follow.current = true;
    setAtBottom(true);
    if (turns.length) virtual.scrollToIndex(turns.length - 1, { align: "end" });
    if (root.current) root.current.scrollTop = root.current.scrollHeight;
  };
  /** 主动阅读立即停止追底。 */
  const pause = () => {
    follow.current = false;
    setAtBottom(false);
  };
  /** 翻页前记录高度，新增旧历史后恢复视觉锚点。 */
  const older = () => {
    if (session.historyLoading || !session.historyCursor) return;
    pause();
    olderHeight.current = size;
    void client.loadOlder(session.thread.id).catch((error) => {
      olderHeight.current = null;
      toast.error(String(error));
    });
  };
  useLayoutEffect(() => {
    if (saved && !saved.follow && root.current)
      root.current.scrollTop = saved.top;
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 新的发送完成事件恢复追底。
  useLayoutEffect(() => {
    if (session.sendRevision) bottom();
  }, [session.sendRevision]);
  useLayoutEffect(() => {
    if (!active) return;
    if (
      olderHeight.current != null &&
      !session.historyLoading &&
      root.current
    ) {
      root.current.scrollTop += size - olderHeight.current;
      olderHeight.current = null;
    } else if (follow.current && !query) bottom();
  }, [active, size, turns, session.historyLoading]);
  useEffect(() => {
    setHit(0);
    if (query) {
      pause();
      setJump((value) => value + 1);
    }
  }, [query]);
  const selected = matches.length ? matches[hit % matches.length] : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 翻页命中或搜索变化时滚动，用户自行滚动不重置位置。
  useEffect(() => {
    if (selected) virtual.scrollToIndex(selected.index, { align: "center" });
  }, [hit, query, jump]);
  useLayoutEffect(() => {
    if (!root.current || !query || !active) return;
    const ranges = textRanges(root.current, query);
    CSS.highlights.set(highlightKey, new Highlight(...ranges));
    const turnNode = root.current.querySelector(
      `[data-codex-turn="${CSS.escape(turns[selected?.index ?? -1]?.id ?? "")}"]`,
    );
    const itemNode = selected
      ? turnNode?.querySelector<HTMLElement>(
          `[data-codex-item="${CSS.escape(selected.itemId)}"]`,
        )
      : null;
    const currentRanges = itemNode ? textRanges(itemNode, query) : [];
    const current = currentRanges[selected?.occurrence ?? 0];
    if (current) {
      CSS.highlights.set(`${highlightKey}-current`, new Highlight(current));
      if (appliedJump.current !== jump) {
        const bounds = current.getBoundingClientRect();
        const viewport = root.current.getBoundingClientRect();
        root.current.scrollTop +=
          bounds.top - viewport.top - viewport.height / 2;
        appliedJump.current = jump;
      }
    }
    const style = document.createElement("style");
    style.textContent = `::highlight(${highlightKey}) {background:#ffe681;color:#201a09;} ::highlight(${highlightKey}-current) {background:#ffc94d;color:#171004;}`;
    document.head.append(style);
    return () => {
      CSS.highlights.delete(highlightKey);
      CSS.highlights.delete(`${highlightKey}-current`);
      style.remove();
    };
  });
  /** 跳到上下命中，不过滤原对话上下文。 */
  const navigate = (delta: number) => {
    if (matches.length) {
      pause();
      setHit((value) => (value + delta + matches.length) % matches.length);
      setJump((value) => value + 1);
    }
  };
  return (
    <FileLinkContext.Provider value={{ cwd: session.thread.cwd, onOpenFile }}>
    <div className="codex-transcript-wrap">
      {query && (
        <div className="flex items-center gap-2 px-3 text-xs">
          <span>
            {matches.length ? (hit % matches.length) + 1 : 0}/{matches.length}{" "}
            处 · 已加载记录
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="上一处"
            onClick={() => navigate(-1)}
          >
            ↑
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="下一处"
            onClick={() => navigate(1)}
          >
            ↓
          </Button>
        </div>
      )}
      <div
        className="codex-transcript reader-scrollbar select-text"
        tabIndex={0}
        ref={root}
        onWheel={(event) => {
          if (event.deltaY < 0) {
            pause();
            if ((root.current?.scrollTop ?? 0) < 80) older();
          }
        }}
        onPointerDown={pause}
        onKeyDown={(event) => {
          if (["PageUp", "ArrowUp", "Home"].includes(event.key)) pause();
        }}
        onScroll={() => {
          const el = root.current;
          if (!el?.clientHeight) return;
          if (
            el.scrollTop > 0 &&
            el.scrollHeight - el.scrollTop - el.clientHeight < 32 &&
            !query
          ) {
            follow.current = true;
            setAtBottom(true);
          }
          client.scrollPositions.set(session.thread.id, {
            top: el.scrollTop,
            follow: follow.current,
          });
        }}
      >
        {session.historyCursor && (
          <Button
            size="xs"
            variant="ghost"
            disabled={session.historyLoading}
            onClick={older}
          >
            {session.historyLoading ? "正在加载更早记录…" : "加载更早记录"}
          </Button>
        )}
        {!session.loaded && <p>正在加载会话...</p>}
        {session.loaded && !turns.length && (
          <div className="py-12 text-center text-muted-foreground">
            从一个任务开始
            <br />
            在下方输入任务或恢复已有线程。
          </div>
        )}
        <div
          className="codex-transcript-content"
          style={{ height: size, position: "relative" }}
        >
          {virtual.getVirtualItems().map((row) => {
            const turn = turns[row.index];
            return (
              <div
                key={row.key}
                data-index={row.index}
                data-codex-turn={turn.id}
                ref={virtual.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${row.start}px)`,
                }}
              >
                <TurnView
                  editableId={
                    editable?.turn.id === turn.id ? editable.item.id : undefined
                  }
                  turn={turn}
                  running={session.turnId === turn.id}
                  query={query}
                  onOpenFile={onOpenFile}
                  forkDisabled={
                    !client.getSnapshot().connected ||
                    session.busy ||
                    session.sending
                  }
                  onFork={() =>
                    void client
                      .fork(session.thread.id, turn.id)
                      .then(onFork)
                      .catch((error) => toast.error(String(error)))
                  }
                  onEdit={
                    editable?.turn.id === turn.id
                      ? async (text) => {
                          onFork(
                            await client.editLast(
                              session.thread.id,
                              text,
                              editable.item.id,
                            ),
                          );
                        }
                      : undefined
                  }
                />
              </div>
            );
          })}
        </div>
        {session.busy && !session.turnId && !session.compacting && (
          <p className="codex-transcript-content codex-live">正在连接会话...</p>
        )}
        {session.error && (
          <p role="alert" className="codex-transcript-content text-destructive whitespace-pre-wrap">
            {session.error}
          </p>
        )}
      </div>
      {!atBottom && !!turns.length && (
        <Button
          className="absolute bottom-2 left-1/2 rounded-full shadow-sm"
          size="icon-sm"
          variant="secondary"
          title="回到底部"
          aria-label="回到底部"
          onClick={bottom}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} />
        </Button>
      )}
    </div>
    </FileLinkContext.Provider>
  );
}
