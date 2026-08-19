import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import { createTheme } from "@uiw/codemirror-themes";

type Palette = {
  mode: "light" | "dark";
  bg: string;
  fg: string;
  caret: string;
  selection: string;
  lineHighlight: string;
  gutterFg: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  constant: string;
  func: string;
  variable: string;
  property: string;
  type: string;
  operator: string;
  tag: string;
  tagBracket?: string;
  attr: string;
  attrValue?: string;
  heading: string;
  link: string;
  invalid: string;
};

/** 将精简后的语法色板转换为 CodeMirror 扩展。 */
function build(p: Palette): Extension {
  return createTheme({
    theme: p.mode,
    settings: {
      background: p.bg,
      foreground: p.fg,
      caret: p.caret,
      selection: p.selection,
      selectionMatch: p.selection,
      lineHighlight: p.lineHighlight,
      gutterBackground: p.bg,
      gutterForeground: p.gutterFg,
    },
    styles: [
      {
        tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
        color: p.comment,
        fontStyle: "italic",
      },
      {
        tag: [
          t.keyword,
          t.modifier,
          t.controlKeyword,
          t.operatorKeyword,
          t.moduleKeyword,
          t.self,
        ],
        color: p.keyword,
      },
      {
        tag: [t.string, t.special(t.string), t.regexp, t.character],
        color: p.string,
      },
      { tag: [t.number], color: p.number },
      { tag: [t.bool, t.null, t.atom, t.constant(t.name)], color: p.constant },
      {
        tag: [
          t.function(t.variableName),
          t.function(t.propertyName),
          t.labelName,
          t.macroName,
        ],
        color: p.func,
      },
      {
        tag: [
          t.definition(t.variableName),
          t.variableName,
          t.local(t.variableName),
        ],
        color: p.variable,
      },
      { tag: [t.propertyName, t.special(t.propertyName)], color: p.property },
      {
        tag: [t.typeName, t.className, t.namespace, t.changed, t.annotation],
        color: p.type,
      },
      {
        tag: [
          t.operator,
          t.punctuation,
          t.separator,
          t.bracket,
          t.derefOperator,
        ],
        color: p.operator,
      },
      { tag: [t.tagName], color: p.tag },
      { tag: [t.angleBracket], color: p.tagBracket ?? p.tag },
      { tag: [t.attributeName], color: p.attr },
      { tag: [t.attributeValue], color: p.attrValue ?? p.attr },
      { tag: [t.heading], color: p.heading, fontWeight: "bold" },
      { tag: [t.link, t.url], color: p.link, textDecoration: "underline" },
      { tag: [t.emphasis], fontStyle: "italic" },
      { tag: [t.strong], fontWeight: "bold" },
      { tag: [t.invalid], color: p.invalid },
      { tag: [t.meta, t.processingInstruction], color: p.comment },
    ],
  });
}

export const codiumDark = build({
  mode: "dark",
  bg: "#1e1e1e",
  fg: "#d4d4d4",
  caret: "#aeafad",
  selection: "#264f78",
  lineHighlight: "#252526",
  gutterFg: "#858585",
  comment: "#6a9955",
  keyword: "#569cd6",
  string: "#ce9178",
  number: "#b5cea8",
  constant: "#4fc1ff",
  func: "#dcdcaa",
  variable: "#9cdcfe",
  property: "#9cdcfe",
  type: "#4ec9b0",
  operator: "#d4d4d4",
  tag: "#569cd6",
  tagBracket: "#808080",
  attr: "#9cdcfe",
  attrValue: "#ce9178",
  heading: "#569cd6",
  link: "#3794ff",
  invalid: "#f44747",
});

export const codiumLight = build({
  mode: "light",
  bg: "#ffffff",
  fg: "#1e1e1e",
  caret: "#000000",
  selection: "#add6ff",
  lineHighlight: "#f3f3f3",
  gutterFg: "#237893",
  comment: "#008000",
  keyword: "#0000ff",
  string: "#a31515",
  number: "#098658",
  constant: "#0070c1",
  func: "#795e26",
  variable: "#001080",
  property: "#001080",
  type: "#267f99",
  operator: "#000000",
  tag: "#800000",
  tagBracket: "#800000",
  attr: "#ff0000",
  attrValue: "#a31515",
  heading: "#0451a5",
  link: "#0000ff",
  invalid: "#cd3131",
});

export const catppuccinMocha = build({
  mode: "dark",
  bg: "#1e1e2e",
  fg: "#cdd6f4",
  caret: "#f5e0dc",
  selection: "#45475a",
  lineHighlight: "#313244",
  gutterFg: "#6c7086",
  comment: "#6c7086",
  keyword: "#cba6f7",
  string: "#a6e3a1",
  number: "#fab387",
  constant: "#fab387",
  func: "#89b4fa",
  variable: "#cdd6f4",
  property: "#89b4fa",
  type: "#f9e2af",
  operator: "#89dceb",
  tag: "#f38ba8",
  attr: "#fab387",
  heading: "#f38ba8",
  link: "#89b4fa",
  invalid: "#f38ba8",
});

export const catppuccinLatte = build({
  mode: "light",
  bg: "#eff1f5",
  fg: "#4c4f69",
  caret: "#dc8a78",
  selection: "#ccced7",
  lineHighlight: "#e6e9ef",
  gutterFg: "#8c8fa1",
  comment: "#8c8fa1",
  keyword: "#8839ef",
  string: "#40a02b",
  number: "#fe640b",
  constant: "#fe640b",
  func: "#1e66f5",
  variable: "#4c4f69",
  property: "#1e66f5",
  type: "#df8e1d",
  operator: "#04a5e5",
  tag: "#d20f39",
  attr: "#fe640b",
  heading: "#d20f39",
  link: "#1e66f5",
  invalid: "#d20f39",
});
