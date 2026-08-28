import type {
  EditorPaneHandle,
  TextSearchOptions,
  TextSearchStatus,
} from "@/modules/editor";
import { MarkdownViewToggle } from "@/modules/markdown";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

const HTML_SEARCH_CHANNEL = "codev-html-search";

type SearchCommand = "query" | "next" | "previous" | "clear";

type HtmlFrameMessage = {
  type: SearchCommand | "scrollbar" | "hello";
  query?: string;
  caseSensitive?: boolean;
  background?: string;
  mutedForeground?: string;
};

type HtmlSearchMessage = {
  channel?: string;
  type?: string;
  count?: unknown;
  index?: unknown;
  truncated?: unknown;
};

type Props = {
  path: string;
  onSetView: (mode: "rendered" | "raw") => void;
  onFocusSearch: () => void;
};

/** 直接加载本地 HTML 文件，保留脚本、相对资源和页面交互。 */
export const HtmlPreviewPane = forwardRef<EditorPaneHandle, Props>(
  function HtmlPreviewPane({ path, onSetView, onFocusSearch }, ref) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const bridgeReadyRef = useRef(false);
    const bridgeReadyTimerRef = useRef<number | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [source, setSource] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const searchQueryRef = useRef("");
    const searchOptionsRef = useRef<TextSearchOptions>({
      caseSensitive: false,
    });
    const searchStatusRef = useRef<TextSearchStatus>({ count: 0, index: 0 });
    const searchListenersRef = useRef<Set<(status: TextSearchStatus) => void>>(
      new Set(),
    );

    /** 通知顶部搜索框 HTML iframe 的最新命中状态。 */
    const setSearchStatus = useCallback((status: TextSearchStatus) => {
      searchStatusRef.current = status;
      for (const listener of searchListenersRef.current) listener(status);
    }, []);

    /** 向当前 HTML iframe 发送一条 bridge 消息。 */
    const postFrameMessage = useCallback((message: HtmlFrameMessage) => {
      iframeRef.current?.contentWindow?.postMessage(
        { channel: HTML_SEARCH_CHANNEL, ...message },
        "*",
      );
    }, []);

    /** 清理当前 HTML bridge 握手超时计时器。 */
    const clearBridgeReadyTimer = useCallback(() => {
      if (bridgeReadyTimerRef.current === null) return;
      window.clearTimeout(bridgeReadyTimerRef.current);
      bridgeReadyTimerRef.current = null;
    }, []);

    /** 在 bridge 未响应时结束顶部搜索的等待状态。 */
    const armBridgeReadyTimeout = useCallback(() => {
      clearBridgeReadyTimer();
      bridgeReadyTimerRef.current = window.setTimeout(() => {
        bridgeReadyTimerRef.current = null;
        if (!bridgeReadyRef.current && searchQueryRef.current) {
          setSearchStatus({ count: 0, index: 0 });
        }
      }, 2000);
    }, [clearBridgeReadyTimer, setSearchStatus]);

    /** 向当前 HTML iframe 发送统一文本搜索命令。 */
    const sendSearchCommand = useCallback(
      (type: SearchCommand) => {
        if (!bridgeReadyRef.current) return;
        postFrameMessage({
          type,
          query: searchQueryRef.current,
          caseSensitive: searchOptionsRef.current.caseSensitive,
        });
      },
      [postFrameMessage],
    );

    /** 将 Codev 阅读器的主题滚动条颜色同步给 HTML iframe。 */
    const syncScrollbarTheme = useCallback(() => {
      const styles = getComputedStyle(document.documentElement);
      postFrameMessage({
        type: "scrollbar",
        background: styles.getPropertyValue("--background").trim(),
        mutedForeground: styles.getPropertyValue("--muted-foreground").trim(),
      });
    }, [postFrameMessage]);

    /** 供磁盘变更同步重新挂载当前 HTML 页面。 */
    const reload = useCallback(() => {
      setReloadKey((value) => value + 1);
      return true;
    }, []);

    /** 清除渲染 HTML 中由顶部搜索产生的命中范围。 */
    const clearQuery = useCallback(() => {
      searchQueryRef.current = "";
      setSearchStatus({ count: 0, index: 0 });
      sendSearchCommand("clear");
    }, [sendSearchCommand, setSearchStatus]);

    /** 更新渲染 HTML 的普通字面量搜索条件。 */
    const setQuery = useCallback(
      (
        query: string,
        options: TextSearchOptions = { caseSensitive: false },
      ) => {
        const changed =
          query !== searchQueryRef.current ||
          options.caseSensitive !== searchOptionsRef.current.caseSensitive;
        searchQueryRef.current = query;
        searchOptionsRef.current = options;
        if (!query) {
          clearQuery();
          return;
        }
        if (!changed) return;
        setSearchStatus({ count: 0, index: 0, busy: true });
        if (!bridgeReadyRef.current) armBridgeReadyTimeout();
        sendSearchCommand("query");
      },
      [armBridgeReadyTimeout, clearQuery, sendSearchCommand, setSearchStatus],
    );

    /** 跳转到渲染 HTML 的下一处命中。 */
    const findNext = useCallback(() => {
      if (searchQueryRef.current) sendSearchCommand("next");
    }, [sendSearchCommand]);

    /** 跳转到渲染 HTML 的上一处命中。 */
    const findPrevious = useCallback(() => {
      if (searchQueryRef.current) sendSearchCommand("previous");
    }, [sendSearchCommand]);

    /** 返回当前渲染 HTML 的搜索统计。 */
    const getSearchStatus = useCallback(() => searchStatusRef.current, []);

    /** 订阅渲染 HTML 的异步搜索统计变化。 */
    const subscribeSearchStatus = useCallback(
      (listener: (status: TextSearchStatus) => void) => {
        searchListenersRef.current.add(listener);
        listener(searchStatusRef.current);
        return () => searchListenersRef.current.delete(listener);
      },
      [],
    );

    /** 在 iframe 重载完成后恢复顶部已有的搜索词。 */
    const restoreSearch = useCallback(() => {
      if (!bridgeReadyRef.current || !searchQueryRef.current) return;
      setSearchStatus({ count: 0, index: 0, busy: true });
      sendSearchCommand("query");
    }, [sendSearchCommand, setSearchStatus]);

    /** 在 iframe 完成加载后请求 bridge 握手。 */
    const handleIframeLoad = useCallback(() => {
      armBridgeReadyTimeout();
      postFrameMessage({ type: "hello" });
    }, [armBridgeReadyTimeout, postFrameMessage]);

    useEffect(() => {
      /** 接收 HTML iframe 的命中统计和 Ctrl+F 聚焦请求。 */
      const receiveSearchMessage = (event: MessageEvent) => {
        if (event.source !== iframeRef.current?.contentWindow) return;
        const data = event.data as HtmlSearchMessage | null;
        if (!data || data.channel !== HTML_SEARCH_CHANNEL) return;
        if (data.type === "focus") {
          onFocusSearch();
          return;
        }
        if (data.type === "ready") {
          const firstReady = !bridgeReadyRef.current;
          bridgeReadyRef.current = true;
          clearBridgeReadyTimer();
          if (firstReady) {
            syncScrollbarTheme();
            restoreSearch();
          }
          return;
        }
        if (
          data.type !== "status" ||
          typeof data.count !== "number" ||
          typeof data.index !== "number"
        ) {
          return;
        }
        setSearchStatus({
          count: Math.max(0, data.count),
          index: Math.max(0, data.index),
          truncated: data.truncated === true,
        });
      };
      window.addEventListener("message", receiveSearchMessage);
      return () => window.removeEventListener("message", receiveSearchMessage);
    }, [
      clearBridgeReadyTimer,
      onFocusSearch,
      restoreSearch,
      setSearchStatus,
      syncScrollbarTheme,
    ]);

    useEffect(() => {
      /** 在 Codev 切换主题时更新已打开 HTML 页的滚动条颜色。 */
      const syncOnThemeChange = () => syncScrollbarTheme();
      const observer = new MutationObserver(syncOnThemeChange);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      return () => observer.disconnect();
    }, [syncScrollbarTheme]);

    useEffect(() => {
      let cancelled = false;
      bridgeReadyRef.current = false;
      clearBridgeReadyTimer();
      setSearchStatus({ count: 0, index: 0 });
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
        clearBridgeReadyTimer();
      };
    }, [clearBridgeReadyTimer, path, reloadKey, setSearchStatus]);

    useEffect(() => clearBridgeReadyTimer, [clearBridgeReadyTimer]);

    useImperativeHandle(
      ref,
      () => ({
        setQuery,
        findNext,
        findPrevious,
        clearQuery,
        getSearchStatus,
        subscribeSearchStatus,
        replaceCurrent: async () => 0,
        replaceAll: async () => 0,
        focus: () => iframeRef.current?.focus(),
        getSelection: () => null,
        getPath: () => path,
        reload,
        gotoLine: () => {},
        undo: () => {},
        redo: () => {},
      }),
      [
        clearQuery,
        findNext,
        findPrevious,
        getSearchStatus,
        path,
        reload,
        setQuery,
        subscribeSearchStatus,
      ],
    );

    return (
      <div className="relative h-full w-full overflow-hidden rounded-md border border-border/60 bg-background">
        <MarkdownViewToggle mode="rendered" onChange={onSetView} />
        {!source && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {error ? `HTML preview failed: ${error}` : "Loading HTML..."}
          </div>
        )}
        {source && (
          <iframe
            key={source}
            ref={iframeRef}
            src={source}
            onLoad={handleIframeLoad}
            title={path.split(/[\\/]/).pop() ?? path}
            className="h-full w-full border-0 bg-background"
          />
        )}
      </div>
    );
  },
);
