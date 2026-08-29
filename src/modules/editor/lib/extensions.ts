import { detectMonoFontFamily } from "@/lib/fonts";
import { indentUnit } from "@codemirror/language";
import {
  Compartment,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
} from "@codemirror/view";
import { chromeTheme } from "./chromeTheme";
import { findLiteralMatches } from "./textSearch";

// Compartments allow runtime reconfiguration without rebuilding state.
export const languageCompartment = new Compartment();
export const wrapCompartment = new Compartment();
export const indentCompartment = new Compartment();

export function indentExtension(unit: string): Extension {
  return [
    indentUnit.of(unit),
    EditorState.tabSize.of(unit === "\t" ? 4 : unit.length),
  ];
}

export const DEFAULT_INDENT: Extension = indentExtension("  ");

const MAX_EDITOR_SEARCH_MATCHES = 5000;
const SEARCH_MATCH_MARK = Decoration.mark({ class: "codev-search-match" });
const SEARCH_ACTIVE_MARK = Decoration.mark({ class: "codev-search-active" });

export type EditorSearchSession = {
  query: string;
  caseSensitive: boolean;
  activeIndex: number;
};

type EditorSearchState = EditorSearchSession & {
  matches: number[];
  truncated: boolean;
};

export const setEditorSearchSession =
  StateEffect.define<EditorSearchSession>();

/** 根据文档和搜索会话计算命中与截断状态。 */
function createEditorSearchState(
  doc: Text,
  session: EditorSearchSession,
  cached?: Pick<EditorSearchState, "matches" | "truncated">,
): EditorSearchState {
  if (!session.query) {
    return {
      ...session,
      activeIndex: -1,
      matches: [],
      truncated: false,
    };
  }
  const collected = cached?.matches ??
    findLiteralMatches(
      doc.toString(),
      session.query,
      { caseSensitive: session.caseSensitive },
      MAX_EDITOR_SEARCH_MATCHES + 1,
    );
  const truncated = cached?.truncated ??
    collected.length > MAX_EDITOR_SEARCH_MATCHES;
  const matches = truncated
    ? collected.slice(0, MAX_EDITOR_SEARCH_MATCHES)
    : collected;
  const activeIndex =
    matches.length === 0
      ? -1
      : Math.max(0, Math.min(session.activeIndex, matches.length - 1));
  return {
    ...session,
    activeIndex,
    matches,
    truncated,
  };
}

const editorSearchField = StateField.define<EditorSearchState>({
  create: (state) =>
    createEditorSearchState(state.doc, {
      query: "",
      caseSensitive: false,
      activeIndex: -1,
    }),
  update: (value, transaction) => {
    let session: EditorSearchSession = value;
    let sessionChanged = false;
    for (const effect of transaction.effects) {
      if (!effect.is(setEditorSearchSession)) continue;
      session = effect.value;
      sessionChanged = true;
    }
    if (!sessionChanged && !transaction.docChanged) return value;
    const canReuseMatches =
      !transaction.docChanged &&
      session.query === value.query &&
      session.caseSensitive === value.caseSensitive;
    return createEditorSearchState(
      transaction.state.doc,
      session,
      canReuseMatches
        ? { matches: value.matches, truncated: value.truncated }
        : undefined,
    );
  },
});

/** 返回有序命中数组中第一个可能进入当前可视范围的位置。 */
function findFirstSearchMatch(matches: number[], from: number): number {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (matches[middle] < from) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** 只为当前 CodeMirror 可视范围建立搜索装饰，限制输入时的布局成本。 */
function buildVisibleSearchDecorations(
  view: EditorView,
  value: EditorSearchState,
): DecorationSet {
  if (!value.query || value.matches.length === 0) return Decoration.none;
  const ranges: Array<{ from: number; to: number; value: Decoration }> = [];
  const queryLength = value.query.length;
  for (const visible of view.visibleRanges) {
    const first = findFirstSearchMatch(
      value.matches,
      Math.max(0, visible.from - queryLength + 1),
    );
    for (let index = first; index < value.matches.length; index += 1) {
      const from = value.matches[index];
      const to = from + queryLength;
      if (from >= visible.to) break;
      if (to <= visible.from) continue;
      ranges.push({
        from,
        to,
        value: index === value.activeIndex ? SEARCH_ACTIVE_MARK : SEARCH_MATCH_MARK,
      });
    }
  }
  return ranges.length > 0
    ? Decoration.set(ranges, true)
    : Decoration.none;
}

/** 维护当前可视区域的搜索装饰，不触碰编辑器真实选区。 */
class EditorSearchPluginValue {
  decorations: DecorationSet;

  /** 初始化当前编辑器的可视搜索装饰。 */
  constructor(view: EditorView) {
    this.decorations = buildVisibleSearchDecorations(
      view,
      view.state.field(editorSearchField),
    );
  }

  /** 在查询、文档或视口变化后刷新可视搜索装饰。 */
  update(update: import("@codemirror/view").ViewUpdate) {
    const before = update.startState.field(editorSearchField);
    const after = update.state.field(editorSearchField);
    if (before !== after || update.docChanged || update.viewportChanged) {
      this.decorations = buildVisibleSearchDecorations(
        update.view,
        after,
      );
    }
  }
}

const editorSearchPlugin = ViewPlugin.fromClass(EditorSearchPluginValue, {
  decorations: (value) => value.decorations,
});

/** 返回 CodeMirror 当前独立搜索会话的命中统计。 */
export function getEditorSearchStatus(state: EditorState): {
  count: number;
  index: number;
  truncated: boolean;
} {
  const value = state.field(editorSearchField, false);
  return {
    count: value?.matches.length ?? 0,
    index: value && value.activeIndex >= 0 ? value.activeIndex + 1 : 0,
    truncated: value?.truncated ?? false,
  };
}

/** 返回 CodeMirror 当前搜索命中的文本范围。 */
export function getEditorSearchActiveRange(
  state: EditorState,
): { from: number; to: number } | null {
  const value = state.field(editorSearchField, false);
  if (!value || value.activeIndex < 0) return null;
  const from = value.matches[value.activeIndex];
  if (from === undefined) return null;
  return { from, to: from + value.query.length };
}

const WORD_WRAP_COLUMN_VAR = "--codev-editor-wrap-column";
const WORD_WRAP_COLUMN_THEME = EditorView.theme({
  ".cm-content.cm-lineWrapping": {
    maxWidth: `var(${WORD_WRAP_COLUMN_VAR})`,
    marginLeft: "6px",
    marginRight: "2px",
  },
  ".cm-content.cm-lineWrapping .cm-line": {
    paddingLeft: "0",
    paddingRight: "0",
  },
});

export function wordWrapExtension(column: number | null): Extension {
  if (column === null) return [];
  return [
    EditorView.lineWrapping,
    WORD_WRAP_COLUMN_THEME,
    EditorView.contentAttributes.of({
      style: `${WORD_WRAP_COLUMN_VAR}: ${column}ch`,
    }),
  ];
}

// Only what basicSetup doesn't already cover, to avoid duplicate extensions.
// basicSetup gives us line numbers, fold gutter, history, indentOnInput,
// bracketMatching, closeBrackets, highlightActiveLine and the search keymap.
// EditorPane deliberately disables same-word selection matches so only the
// actual selected range receives the selection background.
// Singleton: per-pane instances would inject duplicate style modules.
const SHARED_EXTENSIONS: readonly Extension[] = Object.freeze([
  editorSearchField,
  editorSearchPlugin,
  chromeTheme(),
  EditorView.theme({
    "&, &.cm-editor, &.cm-editor.cm-focused": {
      backgroundColor: "transparent !important",
      color: "var(--foreground)",
      outline: "none",
      padding: "8px",
    },
    ".cm-scroller": {
      fontFamily: detectMonoFontFamily(),
      fontSize: "calc(var(--editor-font-size, 13px) * var(--app-zoom, 1))",
      lineHeight: "1.55",
      backgroundColor: "transparent !important",
    },
    ".cm-content": {
      caretColor: "var(--foreground)",
      backgroundColor: "transparent !important",
    },
    ".cm-gutters": {
      backgroundColor: "transparent !important",
      color: "var(--muted-foreground)",
    },
    ".cm-gutter": { backgroundColor: "transparent !important" },
    ".cm-lineNumbers .cm-gutterElement": {
      opacity: "0.55",
    },
    ".cm-foldGutter": { width: "10px" },
    ".cm-foldGutter .cm-gutterElement": {
      color: "var(--muted-foreground)",
      opacity: "0.5",
    },
    ".cm-activeLine": {
      borderTopRightRadius: "5px",
      borderBottomRightRadius: "5px",
      backgroundColor: "color-mix(in srgb, var(--foreground) 4%, transparent)",
    },
    ".cm-lineNumbers .cm-activeLineGutter": {
      borderTopLeftRadius: "5px",
      borderBottomLeftRadius: "5px",
      userSelect: "none",
    },
    "&[data-search-active] .cm-activeLine, &[data-search-active] .cm-activeLineGutter":
      {
        backgroundColor: "transparent !important",
      },
    ".codev-search-match": {
      backgroundColor: "#E8C75A !important",
      color: "#171A1F !important",
    },
    ".codev-search-active": {
      backgroundColor: "#F0A43B !important",
      color: "#111318 !important",
      boxShadow: "inset 0 0 0 1px #8A4F0B",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--foreground)",
    },
    ".cm-selectionMatch": {
      backgroundColor:
        "color-mix(in srgb, var(--primary) 24%, transparent) !important",
      outline: "1px solid color-mix(in srgb, var(--primary) 42%, transparent)",
    },
    ".cm-panels": {
      backgroundColor: "var(--popover)",
      color: "var(--popover-foreground)",
      borderColor: "var(--border)",
    },
  }),
]);

export function buildSharedExtensions(): readonly Extension[] {
  return SHARED_EXTENSIONS;
}
