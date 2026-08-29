import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import type { EditorPaneHandle } from "@/modules/editor";
import {
  findLiteralMatches,
  type TextSearchOptions,
  type TextSearchStatus,
} from "@/modules/editor/lib/textSearch";
import { invoke } from "@tauri-apps/api/core";
import {
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useId,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { MarkdownLink } from "./MarkdownLink";
import { MarkdownViewToggle } from "./MarkdownViewToggle";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type Status =
  | { kind: "loading" }
  | { kind: "ready"; content: string }
  | { kind: "binary" }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

type Props = {
  path: string;
  visible: boolean;
  onSetView: (mode: "rendered" | "raw") => void;
};

type TextSpan = { node: Text; start: number; end: number };
type RenderedMatch = { range: Range };

/** 收集渲染 Markdown 中的文本节点，建立可定位的连续文本坐标。 */
function collectRenderedText(root: HTMLElement): {
  text: string;
  spans: TextSpan[];
} {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const spans: TextSpan[] = [];
  const chunks: string[] = [];
  let cursor = 0;
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    const value = node.nodeValue ?? "";
    if (value) {
      spans.push({ node, start: cursor, end: cursor + value.length });
      chunks.push(value);
      cursor += value.length;
    }
    current = walker.nextNode();
  }
  return { text: chunks.join(""), spans };
}

/** 将渲染文本偏移转换为 DOM Range 可用的文本节点位置。 */
function resolveTextPoint(
  spans: TextSpan[],
  offset: number,
): { node: Text; offset: number } | null {
  if (spans.length === 0) return null;
  const target = Math.max(0, offset);
  for (const span of spans) {
    if (target <= span.end) {
      return {
        node: span.node,
        offset: Math.min(target - span.start, span.node.data.length),
      };
    }
  }
  const last = spans[spans.length - 1];
  return { node: last.node, offset: last.node.data.length };
}

/** 返回当前 WebView 是否提供 CSS Custom Highlight API。 */
function getHighlightRegistry(): HighlightRegistry | null {
  if (
    typeof CSS === "undefined" ||
    !("highlights" in CSS) ||
    typeof Highlight === "undefined"
  ) {
    return null;
  }
  return CSS.highlights;
}

/** 将渲染文本中的全部命中转换为可绘制的 DOM Range。 */
function collectRenderedMatches(
  root: HTMLElement,
  query: string,
  options: TextSearchOptions,
): RenderedMatch[] {
  if (!query) return [];
  const rendered = collectRenderedText(root);
  return findLiteralMatches(rendered.text, query, options).flatMap((from) => {
    const start = resolveTextPoint(rendered.spans, from);
    const end = resolveTextPoint(rendered.spans, from + query.length);
    if (!start || !end) return [];
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return [{ range }];
  });
}

/** 将 DOM 命中范围在实际 Markdown 阅读容器中垂直居中。 */
function revealRenderedRange(range: Range, scrollRoot: HTMLElement): void {
  const rangeRect = range.getBoundingClientRect();
  const rootRect = scrollRoot.getBoundingClientRect();
  if (rangeRect.height > 0) {
    const delta =
      rangeRect.top -
      rootRect.top -
      (scrollRoot.clientHeight - rangeRect.height) / 2;
    scrollRoot.scrollTop += delta;
    return;
  }
  range.startContainer.parentElement?.scrollIntoView({
    block: "center",
    inline: "nearest",
  });
}

const components = { a: MarkdownLink };

export const MarkdownPreviewPane = forwardRef<EditorPaneHandle, Props>(
  function MarkdownPreviewPane({ path, visible, onSetView }, ref) {
    const [status, setStatus] = useState<Status>({ kind: "loading" });
    const [reloadKey, setReloadKey] = useState(0);
    const [outlineCollapsed, setOutlineCollapsed] = useState(false);
    const highlightId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
    const matchHighlightName = `codev-md-match-${highlightId}`;
    const activeHighlightName = `codev-md-active-${highlightId}`;
    const rootRef = useRef<HTMLDivElement>(null);
    const scrollRootRef = useRef<HTMLDivElement>(null);
    const contentRootRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef("");
    const queryRef = useRef("");
    const optionsRef = useRef<TextSearchOptions>({ caseSensitive: false });
    const matchesRef = useRef<number[]>([]);
    const renderedMatchesRef = useRef<RenderedMatch[]>([]);
    const renderedSearchReadyRef = useRef(false);
    const currentMatchRef = useRef(-1);
    const searchListenersRef = useRef<Set<(status: TextSearchStatus) => void>>(
      new Set(),
    );

    /** 在当前渲染视图内处理全文折叠与展开快捷键。 */
    const handleOutlineShortcut = useCallback(
      (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) {
          return;
        }
        const key = event.key.toLowerCase();
        if (key !== "k" && key !== "l") return;
        event.preventDefault();
        event.stopPropagation();
        setOutlineCollapsed(key === "k");
      },
      [],
    );

    /** 将指针所在的 Markdown 预览设为当前快捷键作用域。 */
    const focusPreview = useCallback(() => {
      rootRef.current?.focus({ preventScroll: true });
    }, []);

    /** 计算当前 Markdown 原文的字面量搜索状态。 */
    const getSearchStatus = useCallback(
      (): TextSearchStatus => {
        const count = renderedSearchReadyRef.current
          ? renderedMatchesRef.current.length
          : matchesRef.current.length;
        const index =
          count > 0 && currentMatchRef.current >= 0
            ? Math.min(currentMatchRef.current + 1, count)
            : 0;
        return { count, index };
      },
      [],
    );

    /** 通知 Header 当前 Markdown 搜索状态已经变化。 */
    const emitSearchStatus = useCallback(() => {
      const value = getSearchStatus();
      for (const listener of searchListenersRef.current) listener(value);
    }, [getSearchStatus]);

    /** 清除当前 Markdown 页面中的全部搜索高亮范围。 */
    const clearRenderedHighlights = useCallback(() => {
      const registry = getHighlightRegistry();
      registry?.delete(matchHighlightName);
      registry?.delete(activeHighlightName);
      renderedMatchesRef.current = [];
      renderedSearchReadyRef.current = false;
    }, [activeHighlightName, matchHighlightName]);

    /** 绘制 Markdown 中的全部命中并将当前命中滚动到视口中央。 */
    const applyRenderedSearch = useCallback(
      (reveal: boolean) => {
        const root = contentRootRef.current;
        const scrollRoot = scrollRootRef.current;
        const query = queryRef.current;
        if (!root || !scrollRoot) return;

        const renderedMatches = collectRenderedMatches(
          root,
          query,
          optionsRef.current,
        );
        renderedMatchesRef.current = renderedMatches;
        renderedSearchReadyRef.current = true;

        const registry = getHighlightRegistry();
        registry?.delete(matchHighlightName);
        registry?.delete(activeHighlightName);
        const activeIndex =
          renderedMatches.length > 0
            ? Math.max(
                0,
                Math.min(
                  currentMatchRef.current < 0 ? 0 : currentMatchRef.current,
                  renderedMatches.length - 1,
                ),
              )
            : -1;
        if (currentMatchRef.current !== activeIndex && activeIndex >= 0) {
          currentMatchRef.current = activeIndex;
        }
        if (registry && renderedMatches.length > 0) {
          const ordinary = renderedMatches.filter(
            (_, index) => index !== activeIndex,
          );
          if (ordinary.length > 0) {
            registry.set(
              matchHighlightName,
              new Highlight(...ordinary.map((match) => match.range)),
            );
          }
          const active = renderedMatches[activeIndex];
          if (active) {
            registry.set(activeHighlightName, new Highlight(active.range));
            if (reveal) revealRenderedRange(active.range, scrollRoot);
          }
        } else if (reveal) {
          const active = renderedMatches[activeIndex];
          if (active) revealRenderedRange(active.range, scrollRoot);
        }
      },
      [activeHighlightName, matchHighlightName],
    );

    /** 在渲染内容完成后重新应用当前搜索会话。 */
    const scheduleRenderedSearch = useCallback(() => {
      requestAnimationFrame(() => {
        applyRenderedSearch(true);
        emitSearchStatus();
      });
    }, [applyRenderedSearch, emitSearchStatus]);

    /** 在渲染后的 Markdown 页面中定位当前文本命中。 */
    const selectRenderedMatch = useCallback(() => {
      applyRenderedSearch(true);
    }, [applyRenderedSearch]);

    /** 返回当前渲染视图实际可见的命中数量。 */
    const getRenderedMatchCount = useCallback(() => {
      if (!renderedSearchReadyRef.current) return matchesRef.current.length;
      return renderedMatchesRef.current.length;
    }, []);

    /*
     * The rendered pane owns browser ranges for search only. The browser's
     * user selection remains untouched so selecting text still works normally.
     */
    useEffect(() => {
      const style = document.createElement("style");
      style.dataset.codevMarkdownSearch = highlightId;
      style.textContent = `
        ::highlight(${matchHighlightName}) {
          background-color: #E8C75A !important;
          color: #171A1F !important;
        }
        ::highlight(${activeHighlightName}) {
          background-color: #F0A43B !important;
          color: #111318 !important;
        }
      `;
      document.head.appendChild(style);
      return () => {
        clearRenderedHighlights();
        style.remove();
      };
    }, [
      activeHighlightName,
      clearRenderedHighlights,
      highlightId,
      matchHighlightName,
    ]);

    /** 清除内容切换时遗留的渲染搜索范围。 */
    useEffect(() => {
      if (status.kind !== "ready") clearRenderedHighlights();
    }, [clearRenderedHighlights, status.kind]);

    /** 读取 Markdown 文件并刷新当前渲染内容。 */
    const loadContent = useCallback(async () => {
      setStatus({ kind: "loading" });
      try {
        const res = await invoke<ReadResult>("fs_read_file", {
          path,
          workspace: currentWorkspaceEnv(),
        });
        if (res.kind === "text") {
          contentRef.current = res.content;
          setStatus({ kind: "ready", content: res.content });
        } else if (res.kind === "binary") {
          contentRef.current = "";
          setStatus({ kind: "binary" });
        } else {
          contentRef.current = "";
          setStatus({ kind: "toolarge", size: res.size, limit: res.limit });
        }
      } catch (error) {
        contentRef.current = "";
        setStatus({ kind: "error", message: String(error) });
      }
    }, [path]);

    useEffect(() => {
      void loadContent();
    }, [loadContent, reloadKey]);

    /** 更新 Markdown 当前搜索条件并计算原文命中位置。 */
    const setSearchQuery = useCallback(
      (
        query: string,
        options: TextSearchOptions = { caseSensitive: false },
      ) => {
        if (query) setOutlineCollapsed(false);
        queryRef.current = query;
        optionsRef.current = options;
        matchesRef.current = findLiteralMatches(
          contentRef.current,
          query,
          options,
        );
        currentMatchRef.current = matchesRef.current.length > 0 ? 0 : -1;
        if (!query) {
          clearRenderedHighlights();
          emitSearchStatus();
          return;
        }
        scheduleRenderedSearch();
        emitSearchStatus();
      },
      [
        clearRenderedHighlights,
        emitSearchStatus,
        scheduleRenderedSearch,
      ],
    );

    useEffect(() => {
      if (status.kind === "ready" && queryRef.current) {
        setSearchQuery(queryRef.current, optionsRef.current);
      }
    }, [setSearchQuery, status.kind]);

    useImperativeHandle(
      ref,
      () => ({
        setQuery: setSearchQuery,
        findNext: () => {
          const count = getRenderedMatchCount();
          if (count === 0) return;
          currentMatchRef.current =
            (currentMatchRef.current + 1) % count;
          selectRenderedMatch();
          emitSearchStatus();
        },
        findPrevious: () => {
          const count = getRenderedMatchCount();
          if (count === 0) return;
          currentMatchRef.current =
            (currentMatchRef.current - 1 + count) % count;
          selectRenderedMatch();
          emitSearchStatus();
        },
        clearQuery: () => {
          queryRef.current = "";
          matchesRef.current = [];
          currentMatchRef.current = -1;
          clearRenderedHighlights();
          emitSearchStatus();
        },
        getSearchStatus,
        subscribeSearchStatus: (listener) => {
          searchListenersRef.current.add(listener);
          listener(getSearchStatus());
          return () => searchListenersRef.current.delete(listener);
        },
        replaceCurrent: async (replacement: string) => {
          const index = currentMatchRef.current;
          const query = queryRef.current;
          const offset = matchesRef.current[index];
          if (!query || offset === undefined) return 0;
          const replaced = await invoke<number>("fs_replace_text", {
            path,
            query,
            replacement,
            caseSensitive: optionsRef.current.caseSensitive,
            matchOffset: offset,
            replaceAll: false,
            workspace: currentWorkspaceEnv(),
          });
          if (replaced > 0) {
            await loadContent();
            setSearchQuery(query, optionsRef.current);
          }
          return replaced;
        },
        replaceAll: async (replacement: string) => {
          const query = queryRef.current;
          if (!query) return 0;
          const replaced = await invoke<number>("fs_replace_text", {
            path,
            query,
            replacement,
            caseSensitive: optionsRef.current.caseSensitive,
            matchOffset: null,
            replaceAll: true,
            workspace: currentWorkspaceEnv(),
          });
          if (replaced > 0) {
            await loadContent();
            setSearchQuery(query, optionsRef.current);
          }
          return replaced;
        },
        focus: () => rootRef.current?.focus(),
        getSelection: () => null,
        getPath: () => path,
        reload: () => {
          setReloadKey((value) => value + 1);
          return true;
        },
        gotoLine: () => {},
        undo: () => {},
        redo: () => {},
      }),
      [
        clearRenderedHighlights,
        emitSearchStatus,
        getRenderedMatchCount,
        getSearchStatus,
        loadContent,
        path,
        selectRenderedMatch,
        setSearchQuery,
      ],
    );

    return (
      <div
        ref={rootRef}
        tabIndex={0}
        onKeyDown={handleOutlineShortcut}
        onPointerDownCapture={focusPreview}
        className={cn(
          "relative flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background outline-none",
          !visible && "pointer-events-none",
        )}
      >
        <MarkdownViewToggle mode="rendered" onChange={onSetView} />
        <div
          ref={scrollRootRef}
          className="reader-scrollbar flex-1 overflow-auto"
        >
          <div ref={contentRootRef} className="px-8 py-6">
            {status.kind === "loading" && (
              <p className="text-[12px] text-muted-foreground">Loading…</p>
            )}
            {status.kind === "error" && (
              <p className="text-[12px] text-destructive">
                Failed to read file: {status.message}
              </p>
            )}
            {status.kind === "binary" && (
              <p className="text-[12px] text-muted-foreground">
                Binary file — cannot render as markdown.
              </p>
            )}
            {status.kind === "toolarge" && (
              <p className="text-[12px] text-muted-foreground">
                File is {status.size} bytes; limit {status.limit}.
              </p>
            )}
            {status.kind === "ready" && (
              <Streamdown
                className={cn(
                  "select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
                  outlineCollapsed &&
                    "[&>:not(h1):not(h2):not(h3):not(h4):not(h5):not(h6)]:hidden",
                )}
                components={components}
                mode="static"
                parseIncompleteMarkdown={false}
              >
                {status.content}
              </Streamdown>
            )}
          </div>
        </div>
      </div>
    );
  },
);
