import { isMarkdownPath } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { redo, undo } from "@codemirror/commands";
import { foldAll, unfoldAll } from "@codemirror/language";
import { gotoLine } from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  getEditorSearchActiveRange,
  getEditorSearchStatus,
  indentCompartment,
  indentExtension,
  languageCompartment,
  setEditorSearchSession,
  type WordWrapMode,
  wordWrapExtension,
  wrapCompartment,
} from "./lib/extensions";
import { detectIndentUnit } from "./lib/indent";
import { type LanguageResult, resolveLanguage } from "./lib/languageResolver";
import { FORCE_READ_LIMIT, useDocument } from "./lib/useDocument";
import {
  findLiteralMatches,
  type TextSearchHandle,
  type TextSearchOptions,
  type TextSearchStatus,
} from "./lib/textSearch";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";
import { FilePreviewPane } from "./FilePreviewPane";
import { shouldUseLargeStructuredTextPreview } from "./lib/largeStructuredText";

export type EditorPaneHandle = TextSearchHandle & {
  focus: () => void;
  getSelection: () => string | null;
  getPath: () => string;
  /** Re-read the file from disk. Skips silently if the buffer is dirty. */
  reload: () => boolean;
  /** Move the cursor to a 1-based line and center it, once content is ready. */
  gotoLine: (line: number, options?: { focus?: boolean }) => void;
  /** Apply CodeMirror's undo/redo commands. */
  undo: () => void;
  redo: () => void;
};

type Props = {
  path: string;
  overrideLanguage?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
};

// Above this, syntax highlighting is disabled to keep large-file reading responsive.
const SYNTAX_MAX_BYTES = 4 * 1024 * 1024;

/** 按文件类型决定编辑器的软换行策略，结构化数据保持单行。 */
function getWordWrapMode(
  path: string,
  enabled: boolean,
  column: number,
): WordWrapMode {
  if (isMarkdownPath(path)) return "viewport";
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "json" || extension === "jsonl") return null;
  return enabled ? column : null;
}

/** 写入独立搜索会话，并将当前命中滚动到编辑视口中央。 */
function applyEditorSearchSession(
  view: EditorView,
  query: string,
  options: TextSearchOptions,
  activeIndex: number,
  reveal: boolean,
) {
  view.dom.toggleAttribute("data-search-active", Boolean(query));
  view.dispatch({
    effects: setEditorSearchSession.of({
      query,
      caseSensitive: options.caseSensitive,
      activeIndex,
    }),
  });
  if (!reveal) return;
  const range = getEditorSearchActiveRange(view.state);
  if (range) {
    view.dispatch({
      effects: EditorView.scrollIntoView(range.from, { y: "center" }),
    });
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// memo: EditorStack passes identity-stable props, so background editors
// skip re-rendering entirely when App re-renders (terminal events, tab churn).
export const EditorPane = memo(
  forwardRef<EditorPaneHandle, Props>(function EditorPane(props, ref) {
    const { path, overrideLanguage, onDirtyChange } = props;

    const { doc, onChange, save, reload, openAnyway } = useDocument({
      path,
      onDirtyChange,
    });
    const reloadRef = useRef(reload);
    reloadRef.current = reload;
    const cmRef = useRef<ReactCodeMirrorRef>(null);
    const themeExt = useEditorThemeExt();
    const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap);
    const editorWordWrapColumn = usePreferencesStore(
      (s) => s.editorWordWrapColumn,
    );
    const wordWrapMode = getWordWrapMode(
      path,
      editorWordWrap,
      editorWordWrapColumn,
    );
    // Stabilize save so the extensions array keeps its identity across renders.
    const saveRef = useRef(save);
    saveRef.current = save;

    const performSave = useCallback(async () => {
      await saveRef.current();
    }, []);
    const performSaveRef = useRef(performSave);
    performSaveRef.current = performSave;

    const pathRef = useRef(path);
    pathRef.current = path;

    const pendingLineRef = useRef<{
      path: string;
      line: number;
      focus: boolean;
    } | null>(null);
    const pendingFocusRef = useRef<string | null>(null);
    const searchQueryRef = useRef("");
    const searchOptionsRef = useRef<TextSearchOptions>({
      caseSensitive: false,
    });
    const searchListenersRef = useRef<Set<(status: TextSearchStatus) => void>>(
      new Set(),
    );
    const searchStatusEmitterRef = useRef<() => void>(() => {});
    const statusRef = useRef(doc.status);
    useLayoutEffect(() => {
      statusRef.current = doc.status;
    }, [doc.status]);

    useEffect(() => {
      if (pendingLineRef.current?.path !== path) {
        pendingLineRef.current = null;
      }
      if (pendingFocusRef.current !== path) {
        pendingFocusRef.current = null;
      }
    }, [path]);

    const focusWhenRendered = useCallback(
      (view: EditorView, targetPath: string) => {
        requestAnimationFrame(() => {
          if (cmRef.current?.view === view && pathRef.current === targetPath) {
            view.focus();
          }
        });
      },
      [],
    );

    const applyPendingGoto = useCallback(() => {
      const view = cmRef.current?.view;
      const pending = pendingLineRef.current;
      if (!view || pending == null || statusRef.current !== "ready") return;
      if (pending.path !== path) {
        pendingLineRef.current = null;
        return;
      }
      const target = Math.max(1, Math.min(pending.line, view.state.doc.lines));
      const at = view.state.doc.line(target).from;
      view.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: "center" }),
      });
      if (pending.focus) focusWhenRendered(view, pending.path);
      pendingLineRef.current = null;
    }, [focusWhenRendered, path]);

    const applyPendingFocus = useCallback(() => {
      const view = cmRef.current?.view;
      const pendingPath = pendingFocusRef.current;
      if (!view || pendingPath === null || statusRef.current !== "ready")
        return;
      pendingFocusRef.current = null;
      if (pendingPath === path) focusWhenRendered(view, pendingPath);
    }, [focusWhenRendered, path]);

    useEffect(() => {
      if (doc.status !== "ready") return;
      applyPendingGoto();
      applyPendingFocus();
    }, [doc.status, applyPendingFocus, applyPendingGoto]);

    const extensions = useMemo(
      () => [
        wrapCompartment.of(
          wordWrapExtension(
            getWordWrapMode(
              path,
              usePreferencesStore.getState().editorWordWrap,
              usePreferencesStore.getState().editorWordWrapColumn,
            ),
          ),
        ),
        ...buildSharedExtensions(),
        indentCompartment.of(DEFAULT_INDENT),
        languageCompartment.of([]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || !searchQueryRef.current) return;
          requestAnimationFrame(() => searchStatusEmitterRef.current());
        }),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              void performSaveRef.current();
              return true;
            },
          },
          { key: "Ctrl-k", preventDefault: true, run: foldAll },
          { key: "Ctrl-l", preventDefault: true, run: unfoldAll },
          { key: "Ctrl-g", run: gotoLine },
        ]),
      ],
      [],
    );

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: wrapCompartment.reconfigure(wordWrapExtension(wordWrapMode)),
      });
    }, [wordWrapMode]);

    useEffect(() => {
      if (doc.status !== "ready") return;
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: indentCompartment.reconfigure(
          indentExtension(detectIndentUnit(doc.content)),
        ),
      });
    }, [doc]);

    // Warm the language chunk while the file is still being read; the
    // ready-gated effect below then resolves from cache.
    useEffect(() => {
      const resolvePath = overrideLanguage ? `dummy.${overrideLanguage}` : path;
      void resolveLanguage(resolvePath).catch(() => {});
    }, [path, overrideLanguage]);

    useEffect(() => {
      if (doc.status !== "ready") return;
      if (doc.size > SYNTAX_MAX_BYTES) {
        const view = cmRef.current?.view;
        view?.dispatch({ effects: languageCompartment.reconfigure([]) });
        return;
      }
      let cancelled = false;
      const resolve = async (): Promise<LanguageResult> => {
        const resolvePath = overrideLanguage
          ? `dummy.${overrideLanguage}`
          : path;
        return (
          (await resolveLanguage(resolvePath)) ?? { ext: [], name: "", id: "" }
        );
      };
      void resolve().then((result) => {
        if (cancelled) return;
        const view = cmRef.current?.view;
        if (!view) return;
        view.dispatch({
          effects: languageCompartment.reconfigure(result.ext),
        });
      });
      return () => {
        cancelled = true;
      };
    }, [path, doc.status, overrideLanguage]);

    /** 计算当前 CodeMirror 文档的字面量搜索状态。 */
    const getSearchStatus = useCallback((): TextSearchStatus => {
      const view = cmRef.current?.view;
      if (!view || !searchQueryRef.current) return { count: 0, index: 0 };
      const status = getEditorSearchStatus(view.state);
      return {
        count: status.count,
        index: status.index,
        truncated: status.truncated,
      };
    }, []);

    /** 通知 Header 当前文件的搜索命中状态已经变化。 */
    const emitSearchStatus = useCallback(() => {
      const status = getSearchStatus();
      for (const listener of searchListenersRef.current) listener(status);
    }, [getSearchStatus]);
    searchStatusEmitterRef.current = emitSearchStatus;

    useEffect(() => {
      if (doc.status !== "ready") return;
      const query = searchQueryRef.current;
      const view = cmRef.current?.view;
      if (!query || !view) return;
      applyEditorSearchSession(
        view,
        query,
        searchOptionsRef.current,
        0,
        true,
      );
      emitSearchStatus();
    }, [doc.status, emitSearchStatus]);

    useImperativeHandle(
      ref,
      () => ({
        setQuery: (query: string, options = { caseSensitive: false }) => {
          const changed =
            query !== searchQueryRef.current ||
            options.caseSensitive !== searchOptionsRef.current.caseSensitive;
          searchQueryRef.current = query;
          searchOptionsRef.current = options;
          const view = cmRef.current?.view;
          if (view && (changed || !query)) {
            applyEditorSearchSession(view, query, options, 0, Boolean(query));
          }
          emitSearchStatus();
        },
        findNext: () => {
          const view = cmRef.current?.view;
          if (view && searchQueryRef.current) {
            const status = getEditorSearchStatus(view.state);
            if (status.count > 0) {
              applyEditorSearchSession(
                view,
                searchQueryRef.current,
                searchOptionsRef.current,
                status.index % status.count,
                true,
              );
            }
          }
          emitSearchStatus();
        },
        findPrevious: () => {
          const view = cmRef.current?.view;
          if (view && searchQueryRef.current) {
            const status = getEditorSearchStatus(view.state);
            if (status.count > 0) {
              applyEditorSearchSession(
                view,
                searchQueryRef.current,
                searchOptionsRef.current,
                status.index <= 1 ? status.count - 1 : status.index - 2,
                true,
              );
            }
          }
          emitSearchStatus();
        },
        clearQuery: () => {
          searchQueryRef.current = "";
          const view = cmRef.current?.view;
          if (view)
            applyEditorSearchSession(
              view,
              "",
              searchOptionsRef.current,
              -1,
              false,
            );
          emitSearchStatus();
        },
        getSearchStatus,
        subscribeSearchStatus: (listener) => {
          searchListenersRef.current.add(listener);
          listener(getSearchStatus());
          return () => searchListenersRef.current.delete(listener);
        },
        replaceCurrent: async (replacement: string) => {
          const view = cmRef.current?.view;
          const query = searchQueryRef.current;
          if (!view || !query) return 0;
          const range = getEditorSearchActiveRange(view.state);
          if (!range) return 0;
          view.dispatch({
            changes: { from: range.from, to: range.to, insert: replacement },
          });
          emitSearchStatus();
          return 1;
        },
        replaceAll: async (replacement: string) => {
          const view = cmRef.current?.view;
          const query = searchQueryRef.current;
          if (!view || !query) return 0;
          const content = view.state.doc.toString();
          const matches = findLiteralMatches(
            content,
            query,
            searchOptionsRef.current,
          );
          if (matches.length === 0) return 0;
          view.dispatch({
            changes: matches.map((from) => ({
              from,
              to: from + query.length,
              insert: replacement,
            })),
          });
          emitSearchStatus();
          return matches.length;
        },
        focus: () => {
          pendingFocusRef.current = path;
          applyPendingFocus();
        },
        getSelection: () => {
          const view = cmRef.current?.view;
          if (!view) return null;
          const { from, to } = view.state.selection.main;
          if (from === to) return null;
          return view.state.sliceDoc(from, to);
        },
        getPath: () => path,
        reload: () => reloadRef.current(),
        gotoLine: (line: number, options) => {
          pendingLineRef.current = {
            path,
            line,
            focus: options?.focus ?? true,
          };
          applyPendingGoto();
        },
        undo: () => {
          const view = cmRef.current?.view;
          if (view) undo(view);
        },
        redo: () => {
          const view = cmRef.current?.view;
          if (view) redo(view);
        },
      }),
      [
        path,
        applyPendingFocus,
        applyPendingGoto,
        emitSearchStatus,
        getSearchStatus,
      ],
    );

    if (doc.status === "loading") {
      return (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      );
    }
    if (doc.status === "error") {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
          {doc.message}
        </div>
      );
    }
    if (doc.status === "binary" || doc.status === "toolarge") {
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const isLargeStructuredText =
        doc.status === "toolarge" &&
        shouldUseLargeStructuredTextPreview(path, doc.size);
      if (isLargeStructuredText) {
        return (
          <FilePreviewPane
            ref={ref}
            path={path}
            textOnly
            onDirtyChange={onDirtyChange}
          />
        );
      }
      const isImage = [
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "svg",
        "ico",
      ].includes(ext);
      const isVideo = ["mp4", "webm", "ogg", "mov"].includes(ext);
      const isAudio = ["mp3", "wav", "flac", "aac", "m4a"].includes(ext);
      const isPdf = ext === "pdf";

      if (isImage || isVideo || isAudio || isPdf) {
        const assetUrl = convertFileSrc(path);
        return (
          <div className="reader-scrollbar flex h-full min-h-0 flex-col items-center justify-center overflow-auto bg-background p-4">
            {isImage && (
              <img
                src={assetUrl}
                loading="lazy"
                decoding="async"
                className="max-w-full max-h-full object-contain rounded-md border border-border shadow-sm"
                style={{
                  backgroundImage:
                    "conic-gradient(var(--muted) 0.25turn, transparent 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, transparent 0.75turn)",
                  backgroundSize: "20px 20px",
                }}
                alt={path.split("/").pop()}
              />
            )}
            {isVideo && (
              // biome-ignore lint/a11y/useMediaCaption: local media preview opens arbitrary files with no caption track
              <video
                controls
                preload="metadata"
                className="max-w-full max-h-full"
                src={assetUrl}
              />
            )}
            {isAudio && (
              // biome-ignore lint/a11y/useMediaCaption: local media preview opens arbitrary files with no caption track
              <audio
                controls
                preload="metadata"
                className="w-full max-w-md"
                src={assetUrl}
              />
            )}
            {isPdf && (
              <iframe
                src={assetUrl}
                className="w-full h-full border-none"
                title={path.split("/").pop()}
              />
            )}
          </div>
        );
      }

      const canForce =
        doc.status === "toolarge" && doc.size <= FORCE_READ_LIMIT;
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">
            {doc.status === "binary" ? "Binary file" : "File too large"}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} ·{" "}
            {canForce ? "syntax features disabled" : "preview not supported"}
          </div>
          {canForce && (
            <button
              type="button"
              onClick={openAnyway}
              className="mt-2 rounded-md border border-border bg-muted/60 px-3 py-1 text-xs text-foreground hover:bg-accent"
            >
              Open anyway
            </button>
          )}
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col zoom-exempt">
        <CodeMirror
          ref={cmRef}
          value={doc.content}
          onChange={onChange}
          theme={themeExt}
          extensions={extensions}
          height="100%"
          className="reader-scrollbar flex-1 min-h-0 overflow-hidden"
          basicSetup={{
            drawSelection: false,
            lineNumbers: true,
            highlightActiveLineGutter: true,
            foldGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: false,
            highlightActiveLine: true,
            highlightSelectionMatches: false,
            searchKeymap: false,
          }}
        />
      </div>
    );
  }),
);
