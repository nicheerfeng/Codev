import { currentWorkspaceEnv } from "@/modules/workspace";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
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
import type {
  TextSearchHandle,
  TextSearchOptions,
  TextSearchStatus,
} from "./lib/textSearch";

type Props = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
};

type PreviewKind = "asset" | "text";

type TextWindow = {
  content: string;
  offset: number;
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

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; value: TextWindow }
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
  "jsonl",
  "ndjson",
  "csv",
  "tsv",
  "log",
  "out",
  "err",
  "trace",
]);

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

// 将字节数转为紧凑文本，供分页状态展示。
function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

// 渲染纯文本预览共用的前后翻页栏。
function PageControls({
  offset,
  totalBytes,
  hasMore,
  canGoBack,
  onBack,
  onForward,
}: {
  offset: number;
  totalBytes: number;
  hasMore: boolean;
  canGoBack: boolean;
  onBack: () => void;
  onForward: () => void;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-2 text-[11px] text-muted-foreground">
      <button
        type="button"
        className="rounded px-1.5 py-0.5 hover:bg-accent disabled:opacity-35"
        disabled={!canGoBack}
        onClick={onBack}
      >
        上一页
      </button>
      <button
        type="button"
        className="rounded px-1.5 py-0.5 hover:bg-accent disabled:opacity-35"
        disabled={!hasMore}
        onClick={onForward}
      >
        下一页
      </button>
      <span className="ml-auto tabular-nums">
        {formatBytes(offset)} / {formatBytes(totalBytes)}
      </span>
    </div>
  );
}

// 以单页纯文本预览 JSONL、CSV、TSV 和日志，保持原文可选中复制。
const TextWindowPreview = forwardRef<
  TextSearchHandle,
  { path: string; reloadKey: number }
>(function TextWindowPreview({ path, reloadKey }, ref) {
    const [offset, setOffset] = useState(0);
    const [history, setHistory] = useState<number[]>([]);
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
      for (const listener of searchListenersRef.current) listener(status);
    }, [getSearchStatus]);

    useEffect(() => {
      let cancelled = false;
      setState({ kind: "loading" });
      invoke<TextWindow>("fs_read_text_window", {
        path,
        offset,
        maxBytes: 512 * 1024,
        maxLines: 300,
        workspace: currentWorkspaceEnv(),
      })
        .then((value) => {
          if (!cancelled) setState({ kind: "ready", value });
        })
        .catch((error) => {
          if (!cancelled) setState({ kind: "error", message: String(error) });
        });
      return () => {
        cancelled = true;
      };
    }, [path, offset, reloadKey]);

    /** 根据当前命中位置切换到对应文本页。 */
    const moveToMatch = useCallback(
      (index: number) => {
        const match = matchesRef.current[index];
        if (!match) return;
        currentMatchRef.current = index;
        setHistory([]);
        setOffset(match.lineStart);
        emitSearchStatus();
      },
      [emitSearchStatus],
    );

    /** 发起大文本字面量搜索，并把首个命中页定位到阅读器。 */
    const setSearchQuery = useCallback(
      (
        query: string,
        options: TextSearchOptions = { caseSensitive: false },
      ) => {
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
          setOffset(0);
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
          .then((result) => {
            if (generation !== searchGenerationRef.current) return;
            matchesRef.current = result.matches;
            totalMatchesRef.current = result.total;
            truncatedRef.current = result.truncated;
            currentMatchRef.current = result.matches.length > 0 ? 0 : -1;
            searchBusyRef.current = false;
            setHistory([]);
            setOffset(result.matches[0]?.lineStart ?? 0);
            emitSearchStatus();
          })
          .catch(() => {
            if (generation !== searchGenerationRef.current) return;
            searchBusyRef.current = false;
            emitSearchStatus();
          });
      },
      [emitSearchStatus, path],
    );

    useImperativeHandle(
      ref,
      () => ({
        setQuery: setSearchQuery,
        findNext: () => {
          if (matchesRef.current.length === 0) return;
          moveToMatch(
            (currentMatchRef.current + 1) % matchesRef.current.length,
          );
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
          setOffset(0);
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
            setOffset(0);
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
            setOffset(0);
            setSearchQuery(query, optionsRef.current);
          }
          return replaced;
        },
      }),
      [emitSearchStatus, getSearchStatus, moveToMatch, path, setSearchQuery],
    );

    // 返回已访问的文本窗口，只保存偏移量而不保存额外文件内容。
    const goBack = useCallback(() => {
      const previous = history[history.length - 1];
      if (previous === undefined) return;
      setHistory((entries) => entries.slice(0, -1));
      setOffset(previous);
    }, [history]);

    // 请求下一页原始文本，避免前端构造表格或 JSON 对象。
    const goForward = useCallback(() => {
      if (state.kind !== "ready" || !state.value.hasMore) return;
      setHistory((entries) => [...entries, offset]);
      setOffset(state.value.nextOffset);
    }, [offset, state]);

    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        {state.kind === "loading" && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            正在读取当前页面…
          </div>
        )}
        {state.kind === "error" && (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
            预览失败：{state.message}
          </div>
        )}
        {state.kind === "ready" && (
          <>
            <PageControls
              offset={state.value.offset}
              totalBytes={state.value.totalBytes}
              hasMore={state.value.hasMore}
              canGoBack={history.length > 0}
              onBack={goBack}
              onForward={goForward}
            />
            <pre className="min-h-0 flex-1 select-text overflow-auto p-3 font-mono text-[12px] leading-5 whitespace-pre text-foreground">
              {state.value.content}
            </pre>
          </>
        )}
      </div>
    );
  },
);

// 直接交给 WebView 解码媒体或 PDF，并为超宽图片提供原始尺寸滚动阅读。
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
  const [fit, setFit] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [naturalWidth, setNaturalWidth] = useState<number | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setAssetError(null);
    void invoke("fs_allow_asset", { path })
      .then(() => {
        if (!cancelled) setSource(convertFileSrc(path));
      })
      .catch((error) => {
        if (!cancelled) setAssetError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // 限制图片缩放范围，避免误操作创建过大的布局。
  const changeZoom = useCallback((delta: number) => {
    setFit(false);
    setZoom((value) => Math.min(400, Math.max(25, value + delta)));
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {isImage && (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2 text-[11px] text-muted-foreground">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 hover:bg-accent"
            onClick={() => setFit(true)}
          >
            适合窗口
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 hover:bg-accent"
            onClick={() => {
              setFit(false);
              setZoom(100);
            }}
          >
            原始 100%
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 hover:bg-accent"
            onClick={() => changeZoom(-25)}
            disabled={fit}
          >
            −
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 hover:bg-accent"
            onClick={() => changeZoom(25)}
            disabled={fit}
          >
            ＋
          </button>
          <span className="ml-auto">{fit ? "适合窗口" : `${zoom}%`}</span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {!source && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {assetError ? `媒体加载失败：${assetError}` : "正在加载媒体…"}
          </div>
        )}
        {source && isImage && (
          <img
            src={source}
            loading="lazy"
            decoding="async"
            onLoad={(event) =>
              setNaturalWidth(event.currentTarget.naturalWidth)
            }
            className={
              fit
                ? "mx-auto max-h-full max-w-full rounded-md border border-border object-contain shadow-sm"
                : "rounded-md border border-border object-contain shadow-sm"
            }
            style={
              fit || naturalWidth === null
                ? undefined
                : { width: `${Math.max(1, (naturalWidth * zoom) / 100)}px` }
            }
            alt={filenameFromPath(path)}
          />
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
    { path, onDirtyChange },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement>(null);
    const textSearchRef = useRef<TextSearchHandle | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const previewKind = getPreviewKind(path);

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
