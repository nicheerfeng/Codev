import { bindFileScroll } from "@/modules/reader/fileScroll";
import { ImageViewport } from "@/modules/reader/ImageViewport";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { useVirtualizer } from "@tanstack/react-virtual";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { EditorPaneHandle } from "./EditorPane";
import {
  collectLineOffsets,
  formatPreviewBytes,
  selectedLineIndexes,
} from "./lib/textLinePreview";
import type {
  TextSearchHandle,
  TextSearchOptions,
  TextSearchStatus,
} from "./lib/textSearch";
import { findLiteralMatches } from "./lib/textSearch";
import type { ClipboardEvent, ReactNode } from "react";

type Props = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
  textOnly?: boolean;
};

type PreviewKind = "asset" | "text";

type TextLinePreview = {
  preview: string;
  offset: number;
  nextOffset: number;
  truncated: boolean;
};

type TextLinePreviewWindow = {
  startLine: number;
  lines: TextLinePreview[];
  nextOffset: number;
  totalBytes: number;
  hasMore: boolean;
};

type TextMatch = {
  offset: number;
  lineStart: number;
  line: number;
  column: number;
};

type TextSearchResult = {
  matches: TextMatch[];
  total: number;
  truncated: boolean;
};

type WindowSearchMatch = {
  from: number;
  to: number;
  globalOffset: number;
};

type LoadState =
  | { kind: "loading" }
  | {
      kind: "ready";
      lines: TextLinePreview[];
      nextOffset: number;
      totalBytes: number;
      hasMore: boolean;
    }
  | { kind: "error"; message: string };

const ASSET_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "bmp",
  "avif",
  "pdf",
  "mp4",
  "webm",
  "ogg",
  "mov",
  "mp3",
  "wav",
  "flac",
  "aac",
  "m4a",
]);
const TEXT_PREVIEW_EXTENSIONS = new Set([
  "csv",
  "tsv",
  "log",
  "out",
  "err",
  "trace",
]);

const LINE_ROW_HEIGHT = 20;
const LINE_PREVIEW_PAGE = 40;

// 根据扩展名选择媒体直读或纯文本窗口预览。
export function getPreviewKind(path: string): PreviewKind | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (ASSET_EXTENSIONS.has(extension)) return "asset";
  if (TEXT_PREVIEW_EXTENSIONS.has(extension)) return "text";
  return null;
}

// 从路径中提取展示名，避免预览工具栏重复显示完整路径。
function filenameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 计算 UTF-8 文本前缀的字节长度，用于对齐 Rust 返回的文件偏移。 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** 收集当前纯文本窗口内的全部搜索命中并映射到文件偏移。 */
function collectWindowSearchMatches(
  content: string,
  windowOffset: number,
  query: string,
  options: TextSearchOptions,
): WindowSearchMatch[] {
  return findLiteralMatches(content, query, options).map((from) => ({
    from,
    to: from + query.length,
    globalOffset: windowOffset + utf8ByteLength(content.slice(0, from)),
  }));
}

/** 渲染纯文本窗口中的全部命中，保持正文可复制且不创建浏览器选区。 */
function renderWindowSearchText(
  content: string,
  matches: WindowSearchMatch[],
  activeOffset: number | undefined,
) {
  if (matches.length === 0) return content;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (match.from > cursor) {
      parts.push(content.slice(cursor, match.from));
    }
    parts.push(
      <span
        className={
          match.globalOffset === activeOffset
            ? "codev-search-active"
            : "codev-search-match"
        }
        key={`${match.from}:${index}`}
      >
        {content.slice(match.from, match.to)}
      </span>,
    );
    cursor = match.to;
  }
  if (cursor < content.length) parts.push(content.slice(cursor));
  return parts;
}

// 返回图片字节流对应的 MIME 类型，供 Blob URL 直接交给 WebView 解码。
function imageMimeType(extension: string): string {
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      ico: "image/x-icon",
      bmp: "image/bmp",
      avif: "image/avif",
    }[extension] ?? "application/octet-stream"
  );
}

function mergePreviewWindow(
  current: Extract<LoadState, { kind: "ready" }> | null,
  window: TextLinePreviewWindow,
): Extract<LoadState, { kind: "ready" }> {
  const existing = current?.lines ?? [];
  const start = window.startLine;
  const next = existing.slice(0, start);
  while (next.length < start) {
    next.push({
      preview: "",
      offset: window.nextOffset,
      nextOffset: window.nextOffset,
      truncated: false,
    });
  }
  next.push(...window.lines);
  return {
    kind: "ready",
    lines: next,
    nextOffset: window.nextOffset,
    totalBytes: window.totalBytes,
    hasMore: window.hasMore,
  };
}

// 以短预览按窗填充高度，全文只在复制时从磁盘读取。
const TextWindowPreview = forwardRef<
  TextSearchHandle,
  { path: string; reloadKey: number }
>(function TextWindowPreview({ path, reloadKey }, ref) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const queryRef = useRef("");
  const optionsRef = useRef<TextSearchOptions>({ caseSensitive: false });
  const matchesRef = useRef<TextMatch[]>([]);
  const totalMatchesRef = useRef(0);
  const truncatedRef = useRef(false);
  const currentMatchRef = useRef(-1);
  const searchBusyRef = useRef(false);
  const searchGenerationRef = useRef(0);
  const searchListenersRef = useRef<Set<(status: TextSearchStatus) => void>>(
    new Set(),
  );
  const [searchRevision, setSearchRevision] = useState(0);
  const textScrollRef = useRef<HTMLDivElement>(null);
  const fetchRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const stateRef = useRef(state);
  const virtualizerRef = useRef<{
    scrollToIndex: (
      index: number,
      options?: { align?: "start" | "center" | "end" | "auto" },
    ) => void;
  } | null>(null);
  stateRef.current = state;

  /** 计算大文本预览的当前搜索状态。 */
  const getSearchStatus = useCallback(
    (): TextSearchStatus => ({
      count: totalMatchesRef.current,
      index: currentMatchRef.current >= 0 ? currentMatchRef.current + 1 : 0,
      truncated: truncatedRef.current,
      busy: searchBusyRef.current,
    }),
    [],
  );

  /** 通知 Header 大文本检索状态已经更新。 */
  const emitSearchStatus = useCallback(() => {
    const status = getSearchStatus();
    setSearchRevision((value) => value + 1);
    for (const listener of searchListenersRef.current) listener(status);
  }, [getSearchStatus]);

  const loadWindow = useCallback(
    async (startLine: number, startOffset: number, replace = false) => {
      const generation = fetchRef.current + 1;
      fetchRef.current = generation;
      const window = await invoke<TextLinePreviewWindow>(
        "fs_read_text_line_previews",
        {
          path,
          startLine,
          startOffset,
          maxLines: LINE_PREVIEW_PAGE,
          previewChars: 240,
          workspace: currentWorkspaceEnv(),
        },
      );
      if (generation !== fetchRef.current) return window;
      const current = stateRef.current;
      const next = mergePreviewWindow(
        replace || current.kind !== "ready" ? null : current,
        window,
      );
      stateRef.current = next;
      setState(next);
      return window;
    },
    [path],
  );

  useEffect(() => {
    let cancelled = false;
    fetchRef.current += 1;
    setState({ kind: "loading" });
    void loadWindow(0, 0, true).catch((error) => {
      if (!cancelled) setState({ kind: "error", message: String(error) });
    });
    return () => {
      cancelled = true;
    };
  }, [loadWindow, path, reloadKey]);

  const lines = state.kind === "ready" ? state.lines : [];
  const totalBytes = state.kind === "ready" ? state.totalBytes : 0;
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => textScrollRef.current,
    estimateSize: () => LINE_ROW_HEIGHT,
    overscan: 12,
  });
  virtualizerRef.current = virtualizer;
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisible = virtualItems[virtualItems.length - 1]?.index ?? -1;

  useEffect(() => {
    if (state.kind !== "ready" || !state.hasMore || loadingMoreRef.current)
      return;
    if (lastVisible < 0 || lastVisible < state.lines.length - 8) return;
    loadingMoreRef.current = true;
    void loadWindow(state.lines.length, state.nextOffset)
      .catch(() => undefined)
      .finally(() => {
        loadingMoreRef.current = false;
      });
  }, [lastVisible, loadWindow, state]);

  const ensureLine = useCallback(
    async (lineIndex: number) => {
      let current = stateRef.current;
      while (
        current.kind === "ready" &&
        current.hasMore &&
        current.lines.length <= lineIndex
      ) {
        await loadWindow(current.lines.length, current.nextOffset);
        current = stateRef.current;
      }
    },
    [loadWindow],
  );

  /** 根据当前命中行滚到虚拟列表对应位置。 */
  const moveToMatch = useCallback(
    (index: number) => {
      const match = matchesRef.current[index];
      if (!match) return;
      currentMatchRef.current = index;
      void ensureLine(Math.max(0, match.line - 1)).then(() => {
        virtualizerRef.current?.scrollToIndex(Math.max(0, match.line - 1), {
          align: "center",
        });
        emitSearchStatus();
      });
    },
    [emitSearchStatus, ensureLine],
  );

  /** 发起大文本字面量搜索，并把首个命中行定位到阅读器。 */
  const setSearchQuery = useCallback(
    (query: string, options: TextSearchOptions = { caseSensitive: false }) => {
      const generation = searchGenerationRef.current + 1;
      searchGenerationRef.current = generation;
      queryRef.current = query;
      optionsRef.current = options;
      matchesRef.current = [];
      totalMatchesRef.current = 0;
      truncatedRef.current = false;
      currentMatchRef.current = -1;
      if (!query) {
        searchBusyRef.current = false;
        emitSearchStatus();
        return;
      }
      searchBusyRef.current = true;
      emitSearchStatus();
      void invoke<TextSearchResult>("fs_find_text", {
        path,
        query,
        caseSensitive: options.caseSensitive,
        maxMatches: 2000,
        workspace: currentWorkspaceEnv(),
      })
        .then(async (result) => {
          if (generation !== searchGenerationRef.current) return;
          matchesRef.current = result.matches;
          totalMatchesRef.current = result.total;
          truncatedRef.current = result.truncated;
          currentMatchRef.current = result.matches.length > 0 ? 0 : -1;
          searchBusyRef.current = false;
          if (result.matches[0]) {
            await ensureLine(Math.max(0, result.matches[0].line - 1));
            virtualizerRef.current?.scrollToIndex(
              Math.max(0, result.matches[0].line - 1),
              { align: "center" },
            );
          }
          emitSearchStatus();
        })
        .catch(() => {
          if (generation !== searchGenerationRef.current) return;
          searchBusyRef.current = false;
          emitSearchStatus();
        });
    },
    [emitSearchStatus, ensureLine, path],
  );

  const reloadPreview = useCallback(() => {
    setState({ kind: "loading" });
    void loadWindow(0, 0, true).catch((error) =>
      setState({ kind: "error", message: String(error) }),
    );
  }, [loadWindow]);

  useImperativeHandle(
    ref,
    () => ({
      setQuery: setSearchQuery,
      findNext: () => {
        if (matchesRef.current.length === 0) return;
        moveToMatch((currentMatchRef.current + 1) % matchesRef.current.length);
      },
      findPrevious: () => {
        if (matchesRef.current.length === 0) return;
        moveToMatch(
          (currentMatchRef.current - 1 + matchesRef.current.length) %
            matchesRef.current.length,
        );
      },
      clearQuery: () => {
        searchGenerationRef.current += 1;
        queryRef.current = "";
        matchesRef.current = [];
        totalMatchesRef.current = 0;
        currentMatchRef.current = -1;
        searchBusyRef.current = false;
        emitSearchStatus();
      },
      getSearchStatus,
      subscribeSearchStatus: (listener) => {
        searchListenersRef.current.add(listener);
        listener(getSearchStatus());
        return () => searchListenersRef.current.delete(listener);
      },
      replaceCurrent: async (replacement: string) => {
        const match = matchesRef.current[currentMatchRef.current];
        const query = queryRef.current;
        if (!match || !query) return 0;
        const replaced = await invoke<number>("fs_replace_text", {
          path,
          query,
          replacement,
          caseSensitive: optionsRef.current.caseSensitive,
          matchOffset: match.offset,
          replaceAll: false,
          workspace: currentWorkspaceEnv(),
        });
        if (replaced > 0) {
          reloadPreview();
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
          reloadPreview();
          setSearchQuery(query, optionsRef.current);
        }
        return replaced;
      },
    }),
    [
      emitSearchStatus,
      getSearchStatus,
      moveToMatch,
      path,
      reloadPreview,
      setSearchQuery,
    ],
  );

  useEffect(() => {
    if (state.kind !== "ready" || !queryRef.current) return;
    const frame = requestAnimationFrame(() => {
      textScrollRef.current
        ?.querySelector<HTMLElement>(".codev-search-active")
        ?.scrollIntoView({ block: "center", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [searchRevision, state]);
  useEffect(
    () =>
      bindFileScroll(textScrollRef.current, path, {
        ready: state.kind === "ready",
      }),
    [path, state.kind],
  );

  const copySelection = (event: ClipboardEvent<HTMLDivElement>) => {
    if (state.kind !== "ready") return;
    const indexes = selectedLineIndexes(
      textScrollRef.current,
      window.getSelection(),
    );
    const offsets = collectLineOffsets(indexes, state.lines);
    if (offsets.length === 0) return;
    event.preventDefault();
    void invoke<string>("fs_read_full_text_lines", {
      path,
      offsets,
      workspace: currentWorkspaceEnv(),
    })
      .then((text) => writeText(text))
      .catch(() => undefined);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {state.kind === "loading" && (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          正在读取预览…
        </div>
      )}
      {state.kind === "error" && (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
          预览失败：{state.message}
        </div>
      )}
      {state.kind === "ready" && (
        <>
          <div className="flex h-8 shrink-0 items-center border-b border-border/60 px-2 text-[11px] text-muted-foreground">
            <span className="ml-auto tabular-nums">
              {formatPreviewBytes(totalBytes)}
            </span>
          </div>
          <div
            ref={textScrollRef}
            className="reader-scrollbar min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-5 text-foreground"
            onCopy={copySelection}
          >
            <div
              className="relative min-w-[120ch]"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualItems.map((item) => {
                const row = lines[item.index];
                const preview = row?.preview ?? "";
                return (
                  <div
                    key={item.key}
                    data-line-index={item.index}
                    className="absolute top-0 left-0 min-w-[120ch] overflow-hidden whitespace-nowrap px-3 select-text"
                    style={{
                      height: `${item.size}px`,
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    {renderWindowSearchText(
                      preview,
                      collectWindowSearchMatches(
                        preview,
                        row?.offset ?? 0,
                        queryRef.current,
                        optionsRef.current,
                      ),
                      matchesRef.current[currentMatchRef.current]?.offset,
                    )}
                    {row?.truncated ? (
                      <span className="text-muted-foreground">…</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
});

// 直接交给 WebView 解码媒体或 PDF；图片用视口滚轮缩放、拖动平移。
/** 渲染媒体并保留 PDF/媒体阅览器的滚动位置。 */
function AssetPreview({ path }: { path: string }) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const isImage = [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "ico",
    "bmp",
    "avif",
  ].includes(extension);
  const isVideo = ["mp4", "webm", "ogg", "mov"].includes(extension);
  const isAudio = ["mp3", "wav", "flac", "aac", "m4a"].includes(extension);
  const isPdf = extension === "pdf";
  const [source, setSource] = useState<string | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<HTMLIFrameElement>(null);

  useEffect(
    () => bindFileScroll(scrollRef.current, path),
    [path, source],
  );

  useEffect(() => {
    if (!isPdf || !pdfRef.current) return;
    const frame = pdfRef.current;
    const onLoad = () => {
      try {
        frame.contentWindow?.addEventListener("keydown", (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
            event.preventDefault();
            window.dispatchEvent(new CustomEvent("codev-search-focus"));
          }
        }, true);
      } catch { /* PDF viewer may be isolated by WebView. */ }
    };
    frame.addEventListener("load", onLoad);
    return () => frame.removeEventListener("load", onLoad);
  }, [isPdf, source]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setSource(null);
    setAssetError(null);
    const loadAsset = async () => {
      try {
        if (isImage) {
          const bytes = await invoke<number[]>("fs_read_asset_bytes", {
            path,
            workspace: currentWorkspaceEnv(),
          });
          const blob = new Blob([Uint8Array.from(bytes)], {
            type: imageMimeType(extension),
          });
          objectUrl = URL.createObjectURL(blob);
          if (cancelled) URL.revokeObjectURL(objectUrl);
          else setSource(objectUrl);
          return;
        }
        await invoke("fs_allow_asset", { path });
        if (!cancelled) setSource(convertFileSrc(path));
      } catch (error) {
        if (!cancelled) setAssetError(String(error));
      }
    };
    void loadAsset();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [extension, isImage, path]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        ref={scrollRef}
        className={
          isImage
            ? "min-h-0 flex-1"
            : "reader-scrollbar min-h-0 flex-1 overflow-auto p-4"
        }
      >
        {!source && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {assetError ? `媒体加载失败：${assetError}` : "正在加载媒体…"}
          </div>
        )}
        {source && isImage && (
          <ImageViewport src={source} alt={filenameFromPath(path)} />
        )}
        {source && isVideo && (
          // biome-ignore lint/a11y/useMediaCaption: local file preview has no predictable caption track
          <video
            controls
            preload="metadata"
            className="max-h-full max-w-full"
            src={source}
          />
        )}
        {source && isAudio && (
          // biome-ignore lint/a11y/useMediaCaption: local file preview has no predictable caption track
          <audio
            controls
            preload="metadata"
            className="w-full max-w-md"
            src={source}
          />
        )}
        {source && isPdf && (
          <iframe
            ref={pdfRef}
            src={source}
            className="h-full min-h-[32rem] w-full border-0"
            title={filenameFromPath(path)}
          />
        )}
      </div>
    </div>
  );
}

// 提供只读预览器的编辑器句柄，保持标签和刷新接口稳定。
export const FilePreviewPane = memo(
  forwardRef<EditorPaneHandle, Props>(function FilePreviewPane(
    { path, onDirtyChange, textOnly = false },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement>(null);
    const textSearchRef = useRef<TextSearchHandle | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const previewKind = textOnly ? "text" : getPreviewKind(path);

    useEffect(() => {
      onDirtyChange?.(false);
    }, [onDirtyChange]);

    // 让外部文件刷新事件重新请求当前有限预览页面。
    const reload = useCallback(() => {
      setReloadKey((key) => key + 1);
      return true;
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        setQuery: (query, options) =>
          textSearchRef.current?.setQuery(query, options),
        findNext: () => textSearchRef.current?.findNext(),
        findPrevious: () => textSearchRef.current?.findPrevious(),
        clearQuery: () => textSearchRef.current?.clearQuery(),
        getSearchStatus: () =>
          textSearchRef.current?.getSearchStatus() ?? { count: 0, index: 0 },
        subscribeSearchStatus: (listener) =>
          textSearchRef.current?.subscribeSearchStatus(listener) ?? (() => {}),
        replaceCurrent: (replacement) =>
          textSearchRef.current?.replaceCurrent(replacement) ??
          Promise.resolve(0),
        replaceAll: (replacement) =>
          textSearchRef.current?.replaceAll(replacement) ?? Promise.resolve(0),
        focus: () => rootRef.current?.focus(),
        getSelection: () => null,
        getPath: () => path,
        save: async () => true,
        reload,
        gotoLine: () => {},
        undo: () => {},
        redo: () => {},
      }),
      [path, reload],
    );

    return (
      <div ref={rootRef} className="h-full outline-none" tabIndex={-1}>
        {previewKind === "asset" && (
          <AssetPreview key={`${path}:${reloadKey}`} path={path} />
        )}
        {previewKind === "text" && (
          <TextWindowPreview
            ref={textSearchRef}
            path={path}
            reloadKey={reloadKey}
          />
        )}
      </div>
    );
  }),
);
