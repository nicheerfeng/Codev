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

type Props = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
};

type PreviewKind = "asset" | "csv" | "jsonl" | "text";

type TextWindow = {
  content: string;
  offset: number;
  nextOffset: number;
  totalBytes: number;
  hasMore: boolean;
};

type CsvWindow = {
  headers: string[];
  rows: string[][];
  offset: number;
  nextOffset: number;
  totalBytes: number;
  hasMore: boolean;
};

type LoadState<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
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
const CSV_EXTENSIONS = new Set(["csv", "tsv"]);
const JSONL_EXTENSIONS = new Set(["jsonl", "ndjson"]);
const LOG_EXTENSIONS = new Set(["log", "out", "err", "trace"]);

// 根据扩展名选择不读取完整文件的专用预览器。
export function getPreviewKind(path: string): PreviewKind | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (ASSET_EXTENSIONS.has(extension)) return "asset";
  if (CSV_EXTENSIONS.has(extension)) return "csv";
  if (JSONL_EXTENSIONS.has(extension)) return "jsonl";
  if (LOG_EXTENSIONS.has(extension)) return "text";
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

// 渲染有界预览器共用的前后翻页栏。
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

// 以单页文本窗口预览日志，内存中仅保留当前 512 KB、300 行以内的内容。
function TextWindowPreview({ path, jsonl }: { path: string; jsonl: boolean }) {
  const [offset, setOffset] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [state, setState] = useState<LoadState<TextWindow>>({
    kind: "loading",
  });

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
  }, [path, offset]);

  // 回到已访问窗口，避免在前端保留任何额外文件内容。
  const goBack = useCallback(() => {
    const previous = history[history.length - 1];
    if (previous === undefined) return;
    setHistory((entries) => entries.slice(0, -1));
    setOffset(previous);
  }, [history]);

  // 只记录偏移量，下一页由后端重新按需读取。
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
          {jsonl ? (
            <JsonlContent content={state.value.content} />
          ) : (
            <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap text-foreground">
              {state.value.content}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

// 将当前 JSONL 页面逐行折叠展示，只解析已读取的有限文本窗口。
function JsonlContent({ content }: { content: string }) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2 text-[12px]">
      {lines.map((line) => {
        let valid = true;
        try {
          JSON.parse(line);
        } catch {
          valid = false;
        }
        return (
          <details key={line} className="border-b border-border/40 py-1">
            <summary className="cursor-pointer truncate font-mono text-muted-foreground hover:text-foreground">
              {valid ? "JSON" : "格式异常"} · {line.slice(0, 180)}
              {line.length > 180 ? "…" : ""}
            </summary>
            <pre className="max-h-72 overflow-auto pt-1 font-mono leading-5 whitespace-pre-wrap text-foreground">
              {line}
            </pre>
          </details>
        );
      })}
      {lines.length === 0 && (
        <p className="p-2 text-xs text-muted-foreground">
          当前页面没有 JSONL 记录。
        </p>
      )}
    </div>
  );
}

// 以有限行列的表格预览 CSV 或 TSV，翻页时仅请求下一批记录。
function CsvPreview({ path }: { path: string }) {
  const [offset, setOffset] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [state, setState] = useState<LoadState<CsvWindow>>({ kind: "loading" });
  const delimiter = path.toLowerCase().endsWith(".tsv") ? 9 : 44;

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    invoke<CsvWindow>("fs_read_csv_window", {
      path,
      offset,
      maxRows: 100,
      delimiter,
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
  }, [delimiter, offset, path]);

  // 回到上一批表格记录，仅复用已保存的字节偏移。
  const goBack = useCallback(() => {
    const previous = history[history.length - 1];
    if (previous === undefined) return;
    setHistory((entries) => entries.slice(0, -1));
    setOffset(previous);
  }, [history]);

  // 请求下一批 CSV 行，避免同时保留整张表和完整 DOM。
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
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="min-w-full border-collapse font-mono text-[12px]">
              <thead className="sticky top-0 bg-muted/95 text-left text-muted-foreground">
                <tr>
                  {(state.value.headers.length > 0
                    ? state.value.headers
                    : ["值"]
                  ).map((header) => (
                    <th
                      key={header || "未命名列"}
                      className="border-b border-r border-border/60 px-2 py-1.5 font-medium whitespace-nowrap"
                    >
                      {header || "未命名列"}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.value.rows.map((row) => (
                  <tr key={row.join("\u0000")} className="hover:bg-muted/50">
                    {row.map((cell) => (
                      <td
                        key={`${row.join("\u0000")}:${cell}`}
                        className="max-w-96 border-b border-r border-border/40 px-2 py-1 align-top whitespace-pre-wrap"
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {state.value.rows.length === 0 && (
              <p className="p-3 text-xs text-muted-foreground">
                当前页面没有表格记录。
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// 直接交给 WebView 解码本地媒体或 PDF，跳过通用全文读取路径。
function AssetPreview({ path }: { path: string }) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const source = convertFileSrc(path);
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

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center overflow-auto bg-background p-4">
      {isImage && (
        <img
          src={source}
          loading="lazy"
          decoding="async"
          className="max-h-full max-w-full rounded-md border border-border object-contain shadow-sm"
          style={{
            backgroundImage:
              "conic-gradient(var(--muted) 0.25turn, transparent 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, transparent 0.75turn)",
            backgroundSize: "20px 20px",
          }}
          alt={filenameFromPath(path)}
        />
      )}
      {isVideo && (
        // biome-ignore lint/a11y/useMediaCaption: local file preview has no predictable caption track
        <video
          controls
          preload="metadata"
          className="max-h-full max-w-full"
          src={source}
        />
      )}
      {isAudio && (
        // biome-ignore lint/a11y/useMediaCaption: local file preview has no predictable caption track
        <audio
          controls
          preload="metadata"
          className="w-full max-w-md"
          src={source}
        />
      )}
      {isPdf && (
        <iframe
          src={source}
          className="h-full w-full border-0"
          title={filenameFromPath(path)}
        />
      )}
    </div>
  );
}

// 提供只读预览器的编辑器句柄，保持标签、搜索和刷新接口稳定。
export const FilePreviewPane = memo(
  forwardRef<EditorPaneHandle, Props>(function FilePreviewPane(
    { path, onDirtyChange },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement>(null);
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
        setQuery: () => {},
        findNext: () => {},
        findPrevious: () => {},
        clearQuery: () => {},
        getSearchStatus: () => ({ count: 0, index: 0 }),
        openSearch: () => {},
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
        {previewKind === "csv" && (
          <CsvPreview key={`${path}:${reloadKey}`} path={path} />
        )}
        {previewKind === "jsonl" && (
          <TextWindowPreview key={`${path}:${reloadKey}`} path={path} jsonl />
        )}
        {previewKind === "text" && (
          <TextWindowPreview
            key={`${path}:${reloadKey}`}
            path={path}
            jsonl={false}
          />
        )}
      </div>
    );
  }),
);
