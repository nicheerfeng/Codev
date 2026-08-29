import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KEY_SEP } from "@/lib/platform";
import { useT } from "@/lib/i18n";
import type {
  EditorPaneHandle,
  TextSearchOptions,
  TextSearchStatus,
} from "@/modules/editor";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { getBindingTokens, SHORTCUTS } from "@/modules/shortcuts/shortcuts";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SearchAddon } from "@xterm/addon-search";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

const TERM_DECORATIONS = {
  matchBorder: "#E8C75A",
  activeMatchBorder: "#F0A43B",
  matchOverviewRuler: "#E8C75A",
  activeMatchColorOverviewRuler: "#F0A43B",
};

export type SearchTarget =
  | { kind: "terminal"; addon: SearchAddon; focus: () => void }
  | {
      kind: "editor";
      handle: EditorPaneHandle;
      focus: () => void;
      canReplace?: boolean;
    }
  | null;

export type SearchInlineHandle = { focus: () => void };

type SearchStatus = TextSearchStatus;

type Props = {
  target: SearchTarget;
  /** When true, collapse to an icon-only button until the user opens it. */
  compact?: boolean;
};

export const SearchInline = forwardRef<SearchInlineHandle, Props>(
  function SearchInline({ target, compact }, ref) {
    const t = useT();
    const [q, setQ] = useState("");
    const [replacement, setReplacement] = useState("");
    const [replaceOpen, setReplaceOpen] = useState(false);
    const [status, setStatus] = useState<SearchStatus | null>(null);
    // In compact mode the field is hidden behind an icon until activated.
    // In normal mode the field is always present.
    const [openInCompact, setOpenInCompact] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const pendingFocusRef = useRef(false);
    const setInputRef = useCallback((el: HTMLInputElement | null) => {
      inputRef.current = el;
      if (!el || !pendingFocusRef.current) return;
      pendingFocusRef.current = false;
      el.focus();
    }, []);

    const userShortcuts = usePreferencesStore((s) => s.shortcuts);

    const shortcutText = useMemo(() => {
      const s = SHORTCUTS.find((s) => s.id === "search.focus");
      if (!s) return "";
      const bindings = userShortcuts["search.focus"] || s.defaultBindings;
      if (!bindings || bindings.length === 0) return "";
      const tokens = getBindingTokens(bindings[0]);
      return tokens.join(KEY_SEP);
    }, [userShortcuts]);

    const placeholder = shortcutText
      ? `${t("Search")} (${shortcutText})`
      : t("Search");
    const tooltipTitle = placeholder;

    const expanded = !compact || openInCompact;

    const focus = useCallback(() => {
      pendingFocusRef.current = true;
      if (compact) setOpenInCompact(true);
      else inputRef.current?.focus();
      if (inputRef.current) pendingFocusRef.current = false;
    }, [compact]);

    useImperativeHandle(ref, () => ({ focus }), [focus]);

    const editorTarget = target?.kind === "editor" ? target.handle : null;
    const terminalTarget = target?.kind === "terminal" ? target.addon : null;

    const clearTarget = useCallback(() => {
      setStatus(null);
      if (terminalTarget) terminalTarget.clearDecorations();
      else editorTarget?.clearQuery();
    }, [editorTarget, terminalTarget]);

    const restoreTargetFocus = useCallback(() => {
      if (!target) return;
      target.focus();
    }, [target]);

    // Target switched (terminal ↔ editor) or removed → drop highlights.
    useEffect(() => clearTarget, [clearTarget]);

    const searchOptions = useMemo<TextSearchOptions>(
      () => ({ caseSensitive: false }),
      [],
    );

    useEffect(() => {
      if (!editorTarget && !terminalTarget) {
        setStatus(null);
        return;
      }
      if (terminalTarget) {
        if (q) {
          terminalTarget.findNext(q, { decorations: TERM_DECORATIONS });
        } else {
          terminalTarget.clearDecorations();
        }
        const unlisten = terminalTarget.onDidChangeResults((event) => {
          setStatus({
            count: event.resultCount,
            index: event.resultIndex >= 0 ? event.resultIndex + 1 : 0,
          });
        });
        return () => unlisten.dispose();
      }
      if (!editorTarget) return;
      editorTarget.setQuery(q, searchOptions);
      const unsubscribe = editorTarget.subscribeSearchStatus(setStatus);
      setStatus(editorTarget.getSearchStatus());
      return unsubscribe;
    }, [editorTarget, q, searchOptions, terminalTarget]);

    const targetCanReplace =
      target?.kind === "editor" && target.canReplace !== false;

    useEffect(() => {
      if (!targetCanReplace) setReplaceOpen(false);
    }, [targetCanReplace]);

    const findDirection = (forward: boolean) => {
      if (!target || !q) return;
      if (target.kind === "terminal") {
        const opts = { decorations: TERM_DECORATIONS };
        if (forward) target.addon.findNext(q, opts);
        else target.addon.findPrevious(q, opts);
      } else if (target.kind === "editor") {
        if (forward) target.handle.findNext();
        else target.handle.findPrevious();
        setStatus(target.handle.getSearchStatus());
      }
    };

    const runReplace = async (all: boolean) => {
      if (!target || target.kind !== "editor" || !targetCanReplace || !q)
        return;
      const count = all
        ? await target.handle.replaceAll(replacement)
        : await target.handle.replaceCurrent(replacement);
      setStatus(target.handle.getSearchStatus());
      if (count > 0) restoreTargetFocus();
    };

    const statusLabel = !q
      ? null
      : !target
        ? t("No active editor or terminal")
        : status?.busy
          ? t("Searching...")
          : status
            ? `${status.index}/${status.count}${status.truncated ? "+" : ""}`
            : null;
    const canNavigate = Boolean(q && status && status.count > 0);
    const canReplace = Boolean(
      q && status && status.count > 0 && targetCanReplace,
    );

    return (
      <div
        className="relative h-7 shrink-0 transition-[width] duration-200 ease-out"
        style={{ width: expanded ? (replaceOpen ? 474 : 242) : 28 }}
      >
        {expanded ? (
          <div className="absolute inset-0 flex gap-1 animate-in fade-in-0 duration-150">
            <div
              className={`relative min-w-0 ${replaceOpen ? "w-[190px] shrink-0" : "flex-1"}`}
            >
              <HugeiconsIcon
                icon={Search01Icon}
                size={13}
                strokeWidth={1.75}
                className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={setInputRef}
                value={q}
                placeholder={placeholder}
                className="h-7 w-full bg-muted/80 pr-20 pl-7 text-[13px]! placeholder:text-muted-foreground/70 focus-visible:ring-0"
                onChange={(e) => {
                  setQ(e.target.value);
                }}
                onBlur={() => {
                  if (compact && !q) setOpenInCompact(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    findDirection(!e.shiftKey);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    clearTarget();
                    setQ("");
                    setReplaceOpen(false);
                    if (compact) setOpenInCompact(false);
                    restoreTargetFocus();
                  }
                }}
              />
              {statusLabel ? (
                <span
                  className="pointer-events-none absolute top-1/2 right-14 max-w-14 -translate-y-1/2 truncate text-[10px] text-muted-foreground"
                  title={statusLabel}
                >
                  {statusLabel}
                </span>
              ) : null}
              {q ? (
                <div className="absolute top-1/2 right-5 flex -translate-y-1/2 items-center gap-0.5">
                  <button
                    type="button"
                    disabled={!canNavigate}
                    onClick={() => findDirection(false)}
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
                    aria-label={t("Previous match")}
                    title={t("Previous match")}
                  >
                    <HugeiconsIcon
                      icon={ArrowUp01Icon}
                      size={11}
                      strokeWidth={2}
                    />
                  </button>
                  <button
                    type="button"
                    disabled={!canNavigate}
                    onClick={() => findDirection(true)}
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
                    aria-label={t("Next match")}
                    title={t("Next match")}
                  >
                    <HugeiconsIcon
                      icon={ArrowDown01Icon}
                      size={11}
                      strokeWidth={2}
                    />
                  </button>
                </div>
              ) : null}
              {q && (
                <button
                  type="button"
                  onClick={() => {
                    setQ("");
                    clearTarget();
                    inputRef.current?.focus();
                  }}
                  className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={t("Clear search")}
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    size={11}
                    strokeWidth={2}
                  />
                </button>
              )}
            </div>
            {targetCanReplace && (
              <button
                type="button"
                onClick={() => setReplaceOpen((open) => !open)}
                className="size-7 shrink-0 rounded-md bg-muted/80 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={t("Replace")}
                title={t("Replace")}
              >
                ⇄
              </button>
            )}
            {targetCanReplace && replaceOpen && (
              <div className="flex h-7 min-w-0 flex-1 items-center gap-1">
                <Input
                  value={replacement}
                  placeholder={t("Replace")}
                  className="h-7 min-w-0 flex-1 bg-muted/80 text-xs focus-visible:ring-0"
                  onChange={(event) => setReplacement(event.target.value)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 px-2 text-[11px]"
                  disabled={!canReplace}
                  onClick={() => void runReplace(false)}
                >
                  {t("Replace Current")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 px-2 text-[11px]"
                  disabled={!canReplace}
                  onClick={() => void runReplace(true)}
                >
                  {t("Replace All")}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-end animate-in fade-in-0 duration-150">
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={focus}
              title={tooltipTitle}
            >
              <HugeiconsIcon icon={Search01Icon} size={15} strokeWidth={1.75} />
            </Button>
          </div>
        )}
      </div>
    );
  },
);
