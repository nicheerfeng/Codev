import { detectMonoFontFamily } from "@/lib/fonts";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const TOOLTIP_ENTER = {
  animation:
    "cm-tooltip-enter var(--dur-fast, 120ms) var(--ease-premium, ease-out)",
};

const chrome = EditorView.theme({
  "@keyframes cm-tooltip-enter": {
    from: { opacity: 0, transform: "scale(0.98) translateY(2px)" },
    to: { opacity: 1, transform: "scale(1) translateY(0)" },
  },

  ".cm-tooltip": {
    backgroundColor: "color-mix(in srgb, var(--popover) 94%, transparent)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow:
      "0 8px 24px color-mix(in srgb, black 18%, transparent), 0 2px 6px color-mix(in srgb, black 10%, transparent)",
    backdropFilter: "blur(12px)",
    overflow: "hidden",
    ...TOOLTIP_ENTER,
  },

  ".cm-panel.cm-search, .cm-panel.cm-gotoLine": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    padding: "6px 8px",
    fontSize: "12px",
    fontFamily: "inherit",
    backgroundColor: "var(--popover)",
    borderBottom: "1px solid var(--border)",
  },
  ".cm-panel.cm-search br": { display: "none" },
  ".cm-panel .cm-textfield": {
    fontFamily: detectMonoFontFamily(),
    fontSize: "12px",
    backgroundColor: "color-mix(in srgb, var(--muted) 50%, transparent)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    padding: "3px 8px",
    outline: "none",
    "&:focus": {
      borderColor: "color-mix(in srgb, var(--ring) 60%, var(--border))",
    },
  },
  ".cm-panel.cm-search .cm-textfield": { minWidth: "180px" },
  ".cm-panel .cm-button": {
    backgroundImage: "none",
    backgroundColor: "color-mix(in srgb, var(--muted) 60%, transparent)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    padding: "3px 10px",
    fontSize: "11.5px",
    cursor: "pointer",
    textTransform: "capitalize",
    "&:hover": { backgroundColor: "var(--accent)" },
    "&:active": { backgroundImage: "none" },
  },
  ".cm-panel.cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "11px",
    color: "var(--muted-foreground)",
    textTransform: "capitalize",
  },
  ".cm-panel.cm-search input[type=checkbox]": {
    accentColor: "var(--primary)",
  },
  ".cm-panel.cm-search button[name=close]": {
    position: "absolute",
    top: "4px",
    right: "6px",
    width: "20px",
    height: "20px",
    lineHeight: "1",
    borderRadius: "5px",
    border: "none",
    background: "transparent",
    color: "var(--muted-foreground)",
    fontSize: "14px",
    cursor: "pointer",
    "&:hover": {
      backgroundColor: "var(--accent)",
      color: "var(--foreground)",
    },
  },

  ".cm-tooltip ::-webkit-scrollbar": { width: "8px", height: "8px" },
  ".cm-tooltip ::-webkit-scrollbar-thumb": {
    backgroundColor:
      "color-mix(in srgb, var(--muted-foreground) 30%, transparent)",
    borderRadius: "4px",
    backgroundClip: "padding-box",
    border: "2px solid transparent",
  },
  ".cm-tooltip ::-webkit-scrollbar-track": { background: "transparent" },
});

const THEME: Extension = Object.freeze([
  chrome,
]);

// 提供编辑器搜索面板与提示框的统一外观。
export function chromeTheme(): Extension {
  return THEME;
}
