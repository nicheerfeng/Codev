import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ExternalLinkIcon,
  FitToScreenIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import type { EditorPaneHandle } from "@/modules/editor/EditorPane";
import { bindFileScroll } from "../fileScroll";
import { createPdfSearchSession } from "./pdfSearch";
import { mountPdf, type PdfRuntime } from "./pdfRuntime";
import "./pdf.css";

type Props = { path: string; onDirtyChange?: (dirty: boolean) => void };

/** PDF 与普通编辑器共用搜索句柄，不嵌入浏览器原生 PDF 插件。 */
export const PdfPreview = memo(
  forwardRef<EditorPaneHandle, Props>(function PdfPreview(
    { path, onDirtyChange },
    ref,
  ) {
    const root = useRef<HTMLDivElement>(null);
    const scroll = useRef<HTMLDivElement>(null);
    const pagesElement = useRef<HTMLDivElement>(null);
    const runtime = useRef<PdfRuntime | null>(null);
    const [search] = useState(createPdfSearchSession);
    const [reloadKey, setReloadKey] = useState(0);
    const [page, setPage] = useState(1);
    const [pageInput, setPageInput] = useState("1");
    const [pages, setPages] = useState(0);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      onDirtyChange?.(false);
    }, [onDirtyChange]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey 是用户主动重新读取文档的生命周期触发器。
    useEffect(() => {
      const container = scroll.current;
      const viewer = pagesElement.current;
      if (!container || !viewer) return;
      setPages(0);
      setPage(1);
      setPageInput("1");
      setError(null);
      const reader = mountPdf({
        container,
        pages: viewer,
        search,
        source: async () => {
          await invoke("fs_allow_asset", { path });
          return convertFileSrc(path);
        },
        onReady: setPages,
        onPage: (value) => {
          setPage(value);
          setPageInput(String(value));
        },
        onError: setError,
      });
      runtime.current = reader;
      return () => {
        runtime.current = null;
        reader.dispose();
      };
    }, [path, reloadKey, search]);

    useEffect(
      () => bindFileScroll(scroll.current, path, { ready: pages > 0 }),
      [path, pages],
    );
    useImperativeHandle(
      ref,
      () => ({
        ...search.handle,
        focus: () => root.current?.focus(),
        getSelection: () => {
          const selection = window.getSelection();
          return selection?.anchorNode &&
            root.current?.contains(selection.anchorNode)
            ? selection.toString()
            : null;
        },
        getPath: () => path,
        save: async () => true,
        reload: () => {
          setReloadKey((value) => value + 1);
          return true;
        },
        gotoLine: () => {},
        undo: () => {},
        redo: () => {},
      }),
      [path, search],
    );

    const jump = () => {
      const value = Number(pageInput);
      if (Number.isInteger(value) && value >= 1 && value <= pages)
        runtime.current?.goToPage(value);
      else setPageInput(String(page));
    };
    return (
      <div
        ref={root}
        tabIndex={-1}
        className="codev-pdf flex h-full min-h-0 flex-col bg-background outline-none"
        data-pdf-path={path}
      >
        <div
          className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-muted/40 px-2 text-xs"
          role="toolbar"
          aria-label="PDF 阅读工具栏"
        >
          <button
            type="button"
            className="pdf-tool"
            title="缩小"
            aria-label="缩小 PDF"
            disabled={!pages}
            onClick={() => runtime.current?.zoom(-1)}
          >
            −
          </button>
          <button
            type="button"
            className="pdf-tool"
            title="放大"
            aria-label="放大 PDF"
            disabled={!pages}
            onClick={() => runtime.current?.zoom(1)}
          >
            +
          </button>
          <button
            type="button"
            className="pdf-tool"
            title="适合宽度"
            aria-label="适合宽度"
            disabled={!pages}
            onClick={() => runtime.current?.fit()}
          >
            <HugeiconsIcon icon={FitToScreenIcon} size={15} />
          </button>
          <input
            type="number"
            min={1}
            max={pages || 1}
            value={pageInput}
            disabled={!pages}
            aria-label="PDF 页码"
            className="h-6 w-12 shrink-0 rounded border border-border bg-background px-1 text-center"
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={jump}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                jump();
              }
            }}
          />
          <span className="shrink-0 tabular-nums">/ {pages || "…"}</span>
          <button
            type="button"
            className="pdf-tool"
            title="旋转"
            aria-label="旋转 PDF"
            disabled={!pages}
            onClick={() => runtime.current?.rotate()}
          >
            ↻
          </button>
          <button
            type="button"
            className="pdf-tool ml-auto"
            title="在顶部搜索框搜索 PDF"
            aria-label="搜索 PDF"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("codev-search-focus"))
            }
          >
            <HugeiconsIcon icon={Search01Icon} size={15} />
          </button>
          <button
            type="button"
            className="pdf-tool"
            title="使用系统 PDF 阅读器打开"
            aria-label="使用系统 PDF 阅读器打开"
            onClick={() => {
              void openPath(path).catch((reason) =>
                setError(`无法使用系统 PDF 阅读器打开：${String(reason)}`),
              );
            }}
          >
            <HugeiconsIcon icon={ExternalLinkIcon} size={15} />
          </button>
        </div>
        {error && (
          <div
            role="alert"
            className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs text-destructive"
          >
            <span className="min-w-0 flex-1 break-words">
              PDF 加载或操作失败：{error}
            </span>
            <button
              type="button"
              className="pdf-tool"
              onClick={() => setReloadKey((value) => value + 1)}
            >
              重试
            </button>
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {!pages && !error && (
            <div
              role="status"
              className="absolute inset-0 z-10 grid place-items-center text-xs text-muted-foreground"
            >
              正在加载 PDF…
            </div>
          )}
          <div
            ref={scroll}
            className="codev-pdf-scroll reader-scrollbar absolute inset-0 overflow-auto"
            onClickCapture={(event) => {
              const anchor = (event.target as Element).closest?.("a[href]");
              const href = anchor?.getAttribute("href");
              if (!href || href.startsWith("#")) return;
              event.preventDefault();
              event.stopPropagation();
              if (/^(https?:|mailto:)/i.test(href))
                void openUrl(href).catch((reason) => setError(String(reason)));
            }}
          >
            <div ref={pagesElement} className="pdfViewer" />
          </div>
        </div>
      </div>
    );
  }),
);
