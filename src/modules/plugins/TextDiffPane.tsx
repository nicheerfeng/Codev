import { diff } from "@codemirror/merge";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { Input } from "@/components/ui/input";
import { useEditorThemeExt } from "@/modules/editor/lib/useEditorThemeExt";
import {
  buildSharedExtensions,
  wordWrapExtension,
} from "@/modules/editor/lib/extensions";
import { findLiteralMatches } from "@/modules/editor/lib/textSearch";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type DiffSide = "a" | "b";
type DiffSearchSession = { query: string; activeFrom: number | null };
type DiffSearchState = DiffSearchSession & { matches: number[] };
type TextRange = { from: number; to: number };
type DiffRange = TextRange & { peerFrom: number; peerTo: number };

const changedTextA = Decoration.mark({
  class: "codev-diff-changed-text codev-diff-left-changed-text",
});
const changedTextB = Decoration.mark({
  class: "codev-diff-changed-text codev-diff-right-changed-text",
});
const searchMatch = Decoration.mark({ class: "codev-search-match" });
const searchActive = Decoration.mark({ class: "codev-search-active" });

const DIFF_BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: false,
  highlightActiveLine: true,
  highlightSelectionMatches: false,
  searchKeymap: false,
};

const setDiffSearchSession = StateEffect.define<DiffSearchSession>();

/** 从差异范围中提取非空白字符区间，避免空格和整行被高亮。 */
export function getNonWhitespaceRanges(
  text: string,
  from: number,
  to: number,
): TextRange[] {
  const ranges: TextRange[] = [];
  let rangeStart = -1;
  for (let index = from; index < to; index += 1) {
    const isWhitespace = /\s/u.test(text[index] ?? "");
    if (!isWhitespace && rangeStart < 0) rangeStart = index;
    if (isWhitespace && rangeStart >= 0) {
      ranges.push({ from: rangeStart, to: index });
      rangeStart = -1;
    }
  }
  if (rangeStart >= 0) ranges.push({ from: rangeStart, to });
  return ranges;
}

/** 从底层变更区间剥离两侧共同前后缀，只保留真实文本差异。 */
export function tightenDiffRange(
  text: string,
  from: number,
  to: number,
  peerText: string,
  peerFrom: number,
  peerTo: number,
): DiffRange {
  while (
    from < to &&
    peerFrom < peerTo &&
    text[from] === peerText[peerFrom]
  ) {
    from += 1;
    peerFrom += 1;
  }
  while (
    from < to &&
    peerFrom < peerTo &&
    text[to - 1] === peerText[peerTo - 1]
  ) {
    to -= 1;
    peerTo -= 1;
  }
  return { from, to, peerFrom, peerTo };
}

/** 根据搜索会话和当前文档计算文本对照页的全部命中位置。 */
function createDiffSearchState(
  doc: string,
  session: DiffSearchSession,
): DiffSearchState {
  const matches = findLiteralMatches(doc, session.query, {
    caseSensitive: false,
  });
  return {
    ...session,
    activeFrom:
      session.activeFrom !== null && matches.includes(session.activeFrom)
        ? session.activeFrom
        : null,
    matches,
  };
}

const diffSearchField = StateField.define<DiffSearchState>({
  create: () => ({ query: "", activeFrom: null, matches: [] }),
  update(value, transaction) {
    let session: DiffSearchSession = value;
    let sessionChanged = false;
    for (const effect of transaction.effects) {
      if (!effect.is(setDiffSearchSession)) continue;
      session = effect.value;
      sessionChanged = true;
    }
    if (!sessionChanged && !transaction.docChanged) return value;
    return createDiffSearchState(transaction.state.doc.toString(), session);
  },
});

/** 只为可视区域创建搜索标记，保持双窗口输入和滚动的轻量响应。 */
function buildDiffSearchDecorations(
  view: EditorView,
  value: DiffSearchState,
): DecorationSet {
  if (!value.query || value.matches.length === 0) return Decoration.none;
  const ranges: Array<{ from: number; to: number; value: Decoration }> = [];
  for (const from of value.matches) {
    const to = from + value.query.length;
    const visible = view.visibleRanges.some(
      (range) => from < range.to && to > range.from,
    );
    if (!visible) continue;
    ranges.push({
      from,
      to,
      value: from === value.activeFrom ? searchActive : searchMatch,
    });
  }
  return ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none;
}

/** 维护文本对照页的可视搜索装饰，并随编辑或滚动更新。 */
class DiffSearchPluginValue {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildDiffSearchDecorations(
      view,
      view.state.field(diffSearchField),
    );
  }

  update(update: ViewUpdate) {
    const before = update.startState.field(diffSearchField);
    const after = update.state.field(diffSearchField);
    if (before !== after || update.docChanged || update.viewportChanged) {
      this.decorations = buildDiffSearchDecorations(update.view, after);
    }
  }
}

const DIFF_SEARCH_EXTENSIONS = [
  diffSearchField,
  ViewPlugin.fromClass(DiffSearchPluginValue, {
    decorations: (value) => value.decorations,
  }),
];

/** 根据两侧文本计算当前编辑器的差异装饰。 */
function buildDiffDecorations(
  view: EditorView,
  peerText: string,
  side: DiffSide,
): DecorationSet {
  const currentText = view.state.doc.toString();
  const changes =
    side === "a"
      ? diff(currentText, peerText, { scanLimit: 500 })
      : diff(peerText, currentText, { scanLimit: 500 });
  const documentLength = view.state.doc.length;
  const textDecoration = side === "a" ? changedTextA : changedTextB;
  const ranges: Array<{
    from: number;
    to: number;
    value: Decoration;
  }> = [];

  for (const change of changes) {
    const rawFrom = side === "a" ? change.fromA : change.fromB;
    const rawTo = side === "a" ? change.toA : change.toB;
    const rawPeerFrom = side === "a" ? change.fromB : change.fromA;
    const rawPeerTo = side === "a" ? change.toB : change.toA;
    const from = Math.min(Math.max(rawFrom, 0), documentLength);
    const to = Math.min(Math.max(rawTo, from), documentLength);
    const tightened = tightenDiffRange(
      currentText,
      from,
      to,
      peerText,
      rawPeerFrom,
      rawPeerTo,
    );
    if (tightened.from >= tightened.to) continue;
    for (const range of getNonWhitespaceRanges(
      currentText,
      tightened.from,
      tightened.to,
    )) {
      ranges.push({ ...range, value: textDecoration });
    }
  }

  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  return ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none;
}

/** 创建仅负责渲染当前文本差异的 CodeMirror 插件。 */
function buildDiffExtension(peerText: string, side: DiffSide) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;

      constructor(view: EditorView) {
        this.decorations = buildDiffDecorations(view, peerText, side);
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.decorations = buildDiffDecorations(update.view, peerText, side);
        }
      }
    },
    { decorations: (value) => value.decorations },
  );
}

/** 将当前搜索命中定位到对应编辑器的视口中央。 */
function revealDiffSearchMatch(view: EditorView, from: number) {
  view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
}

type DiffSearchBoxProps = {
  label: string;
  query: string;
  matchCount: number;
  activeIndex: number;
  onQueryChange: (query: string) => void;
  onMove: (direction: 1 | -1) => void;
};

/** 渲染单侧搜索框，限制为对应栏宽度的一半并提供独立定位。 */
function DiffSearchBox({
  label,
  query,
  matchCount,
  activeIndex,
  onQueryChange,
  onMove,
}: DiffSearchBoxProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
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
          aria-label={`${label}搜索`}
          className="h-7 w-full bg-muted/80 pr-24 pl-6 text-[11px]! focus-visible:ring-0"
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
          <span className="w-10 text-center text-[10px] tabular-nums text-muted-foreground">
            {query ? `${matchCount ? activeIndex + 1 : 0}/${matchCount}` : ""}
          </span>
          <button
            type="button"
            className="rounded-sm p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
            disabled={matchCount === 0}
            onClick={() => onMove(-1)}
            aria-label={`${label}上一个匹配项`}
          >
            <HugeiconsIcon icon={ArrowUp01Icon} size={11} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="rounded-sm p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
            disabled={matchCount === 0}
            onClick={() => onMove(1)}
            aria-label={`${label}下一个匹配项`}
          >
            <HugeiconsIcon icon={ArrowDown01Icon} size={11} strokeWidth={2} />
          </button>
        </div>
      </div>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

/** 渲染双窗口可编辑文本对照，并提供统一搜索、定位和差异高亮。 */
export function TextDiffPane() {
  const [leftText, setLeftText] = useState("");
  const [rightText, setRightText] = useState("");
  const [leftQuery, setLeftQuery] = useState("");
  const [rightQuery, setRightQuery] = useState("");
  const [leftActiveMatch, setLeftActiveMatch] = useState(0);
  const [rightActiveMatch, setRightActiveMatch] = useState(0);
  const leftRef = useRef<ReactCodeMirrorRef>(null);
  const rightRef = useRef<ReactCodeMirrorRef>(null);
  const leftRevealRef = useRef(false);
  const rightRevealRef = useRef(false);
  const theme = useEditorThemeExt();
  const sharedExtensions = useMemo(
    () => [...buildSharedExtensions(), wordWrapExtension("viewport")],
    [],
  );
  const leftMatches = useMemo(
    () => findLiteralMatches(leftText, leftQuery, { caseSensitive: false }),
    [leftText, leftQuery],
  );
  const rightMatches = useMemo(
    () => findLiteralMatches(rightText, rightQuery, { caseSensitive: false }),
    [rightText, rightQuery],
  );
  const normalizedLeftActiveMatch =
    leftMatches.length === 0
      ? -1
      : Math.min(leftActiveMatch, leftMatches.length - 1);
  const normalizedRightActiveMatch =
    rightMatches.length === 0
      ? -1
      : Math.min(rightActiveMatch, rightMatches.length - 1);
  const leftExtensions = useMemo(
    () => [
      ...sharedExtensions,
      ...DIFF_SEARCH_EXTENSIONS,
      buildDiffExtension(rightText, "a"),
    ],
    [rightText, sharedExtensions],
  );
  const rightExtensions = useMemo(
    () => [
      ...sharedExtensions,
      ...DIFF_SEARCH_EXTENSIONS,
      buildDiffExtension(leftText, "b"),
    ],
    [leftText, sharedExtensions],
  );

  useEffect(() => {
    const leftView = leftRef.current?.view;
    const rightView = rightRef.current?.view;
    if (!leftView && !rightView) return;
    leftView?.dispatch({
      effects: setDiffSearchSession.of({
        query: leftQuery,
        activeFrom:
          normalizedLeftActiveMatch >= 0
            ? leftMatches[normalizedLeftActiveMatch]
            : null,
      }),
    });
    rightView?.dispatch({
      effects: setDiffSearchSession.of({
        query: rightQuery,
        activeFrom:
          normalizedRightActiveMatch >= 0
            ? rightMatches[normalizedRightActiveMatch]
            : null,
      }),
    });
    if (leftRevealRef.current && leftView && normalizedLeftActiveMatch >= 0) {
      revealDiffSearchMatch(leftView, leftMatches[normalizedLeftActiveMatch]);
      leftRevealRef.current = false;
    }
    if (rightRevealRef.current && rightView && normalizedRightActiveMatch >= 0) {
      revealDiffSearchMatch(
        rightView,
        rightMatches[normalizedRightActiveMatch],
      );
      rightRevealRef.current = false;
    }
  }, [
    leftMatches,
    leftQuery,
    normalizedLeftActiveMatch,
    normalizedRightActiveMatch,
    rightMatches,
    rightQuery,
  ]);

  /** 切换左侧搜索框的上一个或下一个命中。 */
  const moveLeftMatch = useCallback(
    (direction: 1 | -1) => {
      if (leftMatches.length === 0) return;
      leftRevealRef.current = true;
      setLeftActiveMatch(
        (current) =>
          (current + direction + leftMatches.length) % leftMatches.length,
      );
    },
    [leftMatches.length],
  );

  /** 切换右侧搜索框的上一个或下一个命中。 */
  const moveRightMatch = useCallback(
    (direction: 1 | -1) => {
      if (rightMatches.length === 0) return;
      rightRevealRef.current = true;
      setRightActiveMatch(
        (current) =>
          (current + direction + rightMatches.length) % rightMatches.length,
      );
    },
    [rightMatches.length],
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <DiffSearchBox
          label="原文"
          query={leftQuery}
          matchCount={leftMatches.length}
          activeIndex={normalizedLeftActiveMatch}
          onQueryChange={(nextQuery) => {
            leftRevealRef.current = true;
            setLeftActiveMatch(0);
            setLeftQuery(nextQuery);
          }}
          onMove={moveLeftMatch}
        />
        <DiffSearchBox
          label="对照文本"
          query={rightQuery}
          matchCount={rightMatches.length}
          activeIndex={normalizedRightActiveMatch}
          onQueryChange={(nextQuery) => {
            rightRevealRef.current = true;
            setRightActiveMatch(0);
            setRightQuery(nextQuery);
          }}
          onMove={moveRightMatch}
        />
      </header>
      <div className="codev-diff-view flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="codev-diff-editor min-h-0 min-w-0 flex-1 overflow-hidden">
          <CodeMirror
            ref={leftRef}
            value={leftText}
            onChange={setLeftText}
            theme={theme}
            extensions={leftExtensions}
            placeholder="在此输入或粘贴原文"
            height="100%"
            className="codev-diff-cm reader-scrollbar min-h-0 min-w-0 overflow-hidden"
            basicSetup={DIFF_BASIC_SETUP}
          />
        </div>
        <div className="codev-diff-editor min-h-0 min-w-0 flex-1 overflow-hidden border-l border-border/60">
          <CodeMirror
            ref={rightRef}
            value={rightText}
            onChange={setRightText}
            theme={theme}
            extensions={rightExtensions}
            placeholder="在此输入或粘贴对照文本"
            height="100%"
            className="codev-diff-cm reader-scrollbar min-h-0 min-w-0 overflow-hidden"
            basicSetup={DIFF_BASIC_SETUP}
          />
        </div>
      </div>
    </section>
  );
}
