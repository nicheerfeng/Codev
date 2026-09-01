import { Input } from "@/components/ui/input";
import { useEditorThemeExt } from "@/modules/editor/lib/useEditorThemeExt";
import {
  buildSharedExtensions,
  setEditorSearchSession,
  wordWrapExtension,
} from "@/modules/editor/lib/extensions";
import { findLiteralMatches } from "@/modules/editor/lib/textSearch";
import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";

type Props = {
  onAdd?: () => void;
  onClose?: () => void;
};

/** 自动识别 JSON 或 JSONL，并返回可继续编辑的格式化文本。 */
export function formatJsonText(value: string): string {
  if (!value.trim()) return value;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value
    .split(/\r?\n/)
    .map((line, index) => {
      if (!line.trim()) return "";
      try {
        return JSON.stringify(JSON.parse(line), null, 2);
      } catch {
        throw new Error(`第 ${index + 1} 行不是有效 JSON`);
      }
    })
      .join("\n");
  }
}

/** 将 JSON/JSONL 格式化页的当前命中滚动到编辑视口中央。 */
function revealSearchMatch(view: EditorView, query: string, index: number) {
  const matches = findLiteralMatches(view.state.doc.toString(), query, {
    caseSensitive: false,
  });
  const from = matches[index];
  if (from === undefined) return;
  view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
}

/** 渲染一个独立的 JSON/JSONL 可编辑格式化页面。 */
export function JsonFormatterPane({ onAdd, onClose }: Props) {
  const [value, setValue] = useState("");
  const [query, setQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const revealRef = useRef(false);
  const theme = useEditorThemeExt();
  const matches = useMemo(
    () =>
      findLiteralMatches(value, query, {
        caseSensitive: false,
      }),
    [query, value],
  );
  const extensions = useMemo(
    () => [
      ...buildSharedExtensions(),
      wordWrapExtension("viewport"),
      json(),
      EditorView.domEventHandlers({
        /** 粘贴有效 JSON/JSONL 时自动格式化，非法内容保持原样可编辑。 */
        paste: (event, view) => {
          const pasted = event.clipboardData?.getData("text/plain");
          if (!pasted?.trim()) return false;
          let formatted: string;
          try {
            formatted = formatJsonText(pasted);
          } catch {
            return false;
          }
          event.preventDefault();
          view.dispatch(view.state.replaceSelection(formatted));
          return true;
        },
      }),
    ],
    [],
  );

  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    const nextIndex = matches.length === 0 ? -1 : Math.min(activeMatch, matches.length - 1);
    if (nextIndex !== activeMatch) setActiveMatch(Math.max(0, nextIndex));
    view.dom.toggleAttribute("data-search-active", Boolean(query));
    view.dispatch({
      effects: setEditorSearchSession.of({
        query,
        caseSensitive: false,
        activeIndex: nextIndex,
      }),
    });
    if (revealRef.current && nextIndex >= 0) {
      revealSearchMatch(view, query, nextIndex);
      revealRef.current = false;
    }
  }, [activeMatch, matches, query]);

  /** 切换搜索命中并保持搜索不占用编辑器真实选区。 */
  const moveMatch = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) return;
      revealRef.current = true;
      setActiveMatch(
        (current) => (current + direction + matches.length) % matches.length,
      );
    },
    [matches.length],
  );

  return (
    <section className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden bg-background">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <div className="relative min-w-0 w-1/2 max-w-[50%] shrink-0">
          <HugeiconsIcon
            icon={Search01Icon}
            size={12}
            strokeWidth={1.75}
            className="pointer-events-none absolute top-1/2 left-1.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            placeholder="搜索"
            className="h-7 w-full bg-muted/80 pr-24 pl-6 text-[11px]! focus-visible:ring-0"
            onChange={(event) => {
              revealRef.current = true;
              setActiveMatch(0);
              setQuery(event.target.value);
            }}
          />
          <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
            <span className="w-10 text-center text-[10px] tabular-nums text-muted-foreground">
              {query ? `${matches.length ? activeMatch + 1 : 0}/${matches.length}` : ""}
            </span>
            <button
              type="button"
              className="rounded-sm p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
              disabled={matches.length === 0}
              onClick={() => moveMatch(-1)}
              aria-label="上一个匹配项"
            >
              <HugeiconsIcon icon={ArrowUp01Icon} size={11} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="rounded-sm p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
              disabled={matches.length === 0}
              onClick={() => moveMatch(1)}
              aria-label="下一个匹配项"
            >
              <HugeiconsIcon icon={ArrowDown01Icon} size={11} strokeWidth={2} />
            </button>
          </div>
        </div>
        {onAdd && (
          <button
            type="button"
            className="flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onAdd}
            title="新建格式化页面"
            aria-label="新建格式化页面"
          >
            <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={2} />
          </button>
        )}
        {onClose && (
          <button
            type="button"
            className="flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label="关闭格式化页面"
            title="关闭格式化页面"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
          </button>
        )}
      </header>
      <CodeMirror
        ref={cmRef}
        value={value}
        onChange={setValue}
        theme={theme}
        extensions={extensions}
        height="100%"
        className="reader-scrollbar min-h-0 min-w-0 max-w-full flex-1 overflow-hidden"
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
          highlightActiveLine: true,
          highlightSelectionMatches: false,
          searchKeymap: false,
        }}
      />
    </section>
  );
}
