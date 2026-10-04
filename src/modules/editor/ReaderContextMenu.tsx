import { useRef, useState, type ReactNode } from "react";
import { EditorView } from "@codemirror/view";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuShortcut } from "@/components/ui/context-menu";

type SelectionTarget = { text: string; replace?: (text: string) => void };

/** 保存阅读区选区，提供 Codev 风格的剪贴板操作。 */
export function ReaderContextMenu({ children }: { children: ReactNode }) {
  const target = useRef<SelectionTarget>({ text: "" });
  const [selection, setSelection] = useState({ selected: false, editable: false });
  const [error, setError] = useState("");

  /** 菜单抢占焦点前保存编辑器或渲染文档选区。 */
  function capture(element: HTMLElement, frameText?: string) {
    const editor = element.closest(".cm-editor");
    const view = editor ? EditorView.findFromDOM(editor as HTMLElement) : null;
    if (frameText !== undefined) target.current = { text: frameText };
    else if (view) {
      const range = view.state.selection.main;
      target.current = {
        text: view.state.sliceDoc(range.from, range.to),
        replace: view.state.readOnly ? undefined : (text) => {
          view.dispatch({ changes: { from: range.from, to: range.to, insert: text }, selection: { anchor: range.from + text.length }, userEvent: "input.paste" });
          view.focus();
        },
      };
    } else target.current = { text: window.getSelection()?.toString() ?? "" };
    setSelection({ selected: !!target.current.text, editable: !!target.current.replace });
    setError("");
  }

  /** 剪贴板写入成功后才删除原文，错误就地提示。 */
  async function execute(action: "cut" | "copy" | "paste") {
    const saved = target.current;
    try {
      if (action === "paste") saved.replace?.(await readText() ?? "");
      else {
        await writeText(saved.text);
        if (action === "cut") saved.replace?.("");
      }
    } catch (reason) { setError(`剪贴板操作失败：${String(reason)}`); }
  }

  return <ContextMenu>
    <ContextMenuTrigger asChild>
      <div className="relative min-h-0 min-w-0 flex-1 select-text" onContextMenuCapture={(event) => capture(event.target as HTMLElement, (event.nativeEvent as MouseEvent & { readerText?: string }).readerText)}>
        {children}
        {error && <div role="alert" className="absolute bottom-2 left-2 z-20 rounded bg-popover p-2 text-xs text-destructive shadow"><button type="button" onClick={() => setError("")}>{error}</button></div>}
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
      <ContextMenuItem disabled={!selection.editable || !selection.selected} onSelect={() => void execute("cut")}>剪切<ContextMenuShortcut>Ctrl+X</ContextMenuShortcut></ContextMenuItem>
      <ContextMenuItem disabled={!selection.selected} onSelect={() => void execute("copy")}>复制<ContextMenuShortcut>Ctrl+C</ContextMenuShortcut></ContextMenuItem>
      <ContextMenuItem disabled={!selection.editable} onSelect={() => void execute("paste")}>粘贴<ContextMenuShortcut>Ctrl+V</ContextMenuShortcut></ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>;
}
