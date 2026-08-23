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
  useCallback,
  useEffect,
  useImperativeHandle,
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

const components = { a: MarkdownLink };

export const MarkdownPreviewPane = forwardRef<EditorPaneHandle, Props>(
  function MarkdownPreviewPane({ path, visible, onSetView }, ref) {
    const [status, setStatus] = useState<Status>({ kind: "loading" });
    const [reloadKey, setReloadKey] = useState(0);
    const rootRef = useRef<HTMLDivElement>(null);
    const contentRootRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef("");
    const queryRef = useRef("");
    const optionsRef = useRef<TextSearchOptions>({ caseSensitive: false });
    const matchesRef = useRef<number[]>([]);
    const currentMatchRef = useRef(-1);
    const searchListenersRef = useRef<Set<(status: TextSearchStatus) => void>>(
      new Set(),
    );

    /** 计算当前 Markdown 原文的字面量搜索状态。 */
    const getSearchStatus = useCallback(
      (): TextSearchStatus => ({
        count: matchesRef.current.length,
        index: currentMatchRef.current >= 0 ? currentMatchRef.current + 1 : 0,
      }),
      [],
    );

    /** 通知 Header 当前 Markdown 搜索状态已经变化。 */
    const emitSearchStatus = useCallback(() => {
      const value = getSearchStatus();
      for (const listener of searchListenersRef.current) listener(value);
    }, [getSearchStatus]);

    /** 在渲染后的 Markdown 页面中定位当前文本命中并滚动到可视区域。 */
    const selectRenderedMatch = useCallback(() => {
      const query = queryRef.current;
      const root = contentRootRef.current;
      if (!query || !root) return;
      const rendered = collectRenderedText(root);
      const renderedMatches = findLiteralMatches(
        rendered.text,
        query,
        optionsRef.current,
      );
      if (renderedMatches.length > 0) {
        const index = currentMatchRef.current % renderedMatches.length;
        const from = renderedMatches[index];
        const start = resolveTextPoint(rendered.spans, from);
        const end = resolveTextPoint(rendered.spans, from + query.length);
        if (start && end) {
          const range = document.createRange();
          range.setStart(start.node, start.offset);
          range.setEnd(end.node, end.offset);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          start.node.parentElement?.scrollIntoView({
            block: "nearest",
            inline: "nearest",
          });
          return;
        }
      }
    }, []);

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
        queryRef.current = query;
        optionsRef.current = options;
        matchesRef.current = findLiteralMatches(
          contentRef.current,
          query,
          options,
        );
        currentMatchRef.current = matchesRef.current.length > 0 ? 0 : -1;
        emitSearchStatus();
        requestAnimationFrame(selectRenderedMatch);
      },
      [emitSearchStatus, selectRenderedMatch],
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
          if (matchesRef.current.length === 0) return;
          currentMatchRef.current =
            (currentMatchRef.current + 1) % matchesRef.current.length;
          selectRenderedMatch();
          emitSearchStatus();
        },
        findPrevious: () => {
          if (matchesRef.current.length === 0) return;
          currentMatchRef.current =
            (currentMatchRef.current - 1 + matchesRef.current.length) %
            matchesRef.current.length;
          selectRenderedMatch();
          emitSearchStatus();
        },
        clearQuery: () => {
          queryRef.current = "";
          matchesRef.current = [];
          currentMatchRef.current = -1;
          window.getSelection()?.removeAllRanges();
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
        emitSearchStatus,
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
        className={cn(
          "relative flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background",
          !visible && "pointer-events-none",
        )}
      >
        <MarkdownViewToggle mode="rendered" onChange={onSetView} />
        <div className="flex-1 overflow-auto">
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
                className="select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
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
