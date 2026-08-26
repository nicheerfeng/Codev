import { MarkdownViewToggle } from "@/modules/markdown";
import type { EditorPaneHandle } from "@/modules/editor";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

type Props = {
  path: string;
  onSetView: (mode: "rendered" | "raw") => void;
};

/** 直接加载本地 HTML 文件，保留脚本、相对资源和页面交互。 */
export const HtmlPreviewPane = forwardRef<EditorPaneHandle, Props>(
  function HtmlPreviewPane({ path, onSetView }, ref) {
    const rootRef = useRef<HTMLDivElement>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [source, setSource] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    /** 重新挂载当前 HTML 页面并绕过根文档缓存。 */
    const reload = useCallback(() => {
      setReloadKey((value) => value + 1);
      return true;
    }, []);

    useEffect(() => {
      let cancelled = false;
      setSource(null);
      setError(null);
      void invoke("fs_allow_asset", { path, recursiveDirectory: true })
        .then(() => {
          if (cancelled) return;
          const assetUrl = convertFileSrc(path);
          const separator = assetUrl.includes("?") ? "&" : "?";
          setSource(`${assetUrl}${separator}codev-preview=${reloadKey}`);
        })
        .catch((reason) => {
          if (!cancelled) setError(String(reason));
        });
      return () => {
        cancelled = true;
      };
    }, [path, reloadKey]);

    useImperativeHandle(
      ref,
      () => ({
        setQuery: () => {},
        findNext: () => {},
        findPrevious: () => {},
        clearQuery: () => {},
        getSearchStatus: () => ({ count: 0, index: 0 }),
        subscribeSearchStatus: (listener) => {
          listener({ count: 0, index: 0 });
          return () => {};
        },
        replaceCurrent: async () => 0,
        replaceAll: async () => 0,
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
      <div
        ref={rootRef}
        className="relative h-full w-full overflow-hidden rounded-md border border-border/60 bg-background outline-none"
        tabIndex={-1}
      >
        <MarkdownViewToggle
          mode="rendered"
          onChange={onSetView}
          className="right-11"
        />
        <button
          type="button"
          onClick={reload}
          title="Refresh preview"
          aria-label="Refresh preview"
          className="absolute right-3 top-3 z-10 inline-flex size-6 items-center justify-center rounded-md border border-border/60 bg-card/85 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
        >
          <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={2} />
        </button>
        {!source && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {error ? `HTML preview failed: ${error}` : "Loading HTML..."}
          </div>
        )}
        {source && (
          <iframe
            key={source}
            src={source}
            title={path.split(/[\\/]/).pop() ?? path}
            className="h-full w-full border-0 bg-white"
          />
        )}
      </div>
    );
  },
);
