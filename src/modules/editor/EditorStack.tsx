import { cn, isMarkdownPath } from "@/lib/utils";
import { MarkdownViewToggle } from "@/modules/markdown";
import type { EditorTab, MarkdownTab, Tab } from "@/modules/tabs";
import { useEffect, useRef } from "react";
import type { EditorPaneHandle } from "./EditorPane";
import { FileViewer } from "./FileViewer";

type Props = {
  tabs: Tab[];
  activeId: number;
  onDirtyChange: (id: number, dirty: boolean) => void;
  registerHandle: (id: number, handle: EditorPaneHandle | null) => void;
  onSetMarkdownView: (id: number, mode: "rendered" | "raw") => void;
};

export function EditorStack({
  tabs,
  activeId,
  onDirtyChange,
  registerHandle,
  onSetMarkdownView,
}: Props) {
  const editors = tabs.filter(
    (t): t is EditorTab | MarkdownTab =>
      !t.cold &&
      (t.kind === "editor" || (t.kind === "markdown" && t.viewMode === "raw")),
  );
  // 仅保留当前文件和未保存文件的编辑器实例，干净后台标签重新激活时再加载。
  const mountedEditors = editors.filter((t) => t.id === activeId || t.dirty);

  // Stable per-tab callbacks. Inline arrows in `ref` and `onDirtyChange`
  // change identity every render, which makes React detach+reattach the ref
  // callback and re-invoke `onDirtyChange`, triggering setState loops in
  // the parent. Memoizing per id keeps each callback's identity stable.
  const registerRef = useRef(registerHandle);
  const dirtyRef = useRef(onDirtyChange);

  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    dirtyRef.current = onDirtyChange;
  }, [onDirtyChange]);

  const refCallbacks = useRef(
    new Map<number, (h: EditorPaneHandle | null) => void>(),
  );
  const dirtyCallbacks = useRef(new Map<number, (dirty: boolean) => void>());

  const getRefCallback = (id: number) => {
    let cb = refCallbacks.current.get(id);
    if (!cb) {
      cb = (h: EditorPaneHandle | null) => registerRef.current(id, h);
      refCallbacks.current.set(id, cb);
    }
    return cb;
  };
  const getDirtyCallback = (id: number) => {
    let cb = dirtyCallbacks.current.get(id);
    if (!cb) {
      cb = (dirty: boolean) => dirtyRef.current(id, dirty);
      dirtyCallbacks.current.set(id, cb);
    }
    return cb;
  };

  // Drop callback entries for closed tabs to avoid unbounded growth.
  useEffect(() => {
    const live = new Set(editors.map((t) => t.id));
    for (const id of refCallbacks.current.keys()) {
      if (!live.has(id)) refCallbacks.current.delete(id);
    }
    for (const id of dirtyCallbacks.current.keys()) {
      if (!live.has(id)) dirtyCallbacks.current.delete(id);
    }
  }, [editors]);

  if (editors.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {mountedEditors.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <div className="relative h-full overflow-hidden rounded-md border border-border/60 bg-background">
              {isMarkdownPath(t.path) && (
                <MarkdownViewToggle
                  mode={t.kind === "markdown" ? t.viewMode : "raw"}
                  onChange={(mode) => onSetMarkdownView(t.id, mode)}
                  renderedDisabled={t.dirty}
                  renderedHint="Save to preview"
                />
              )}
              <FileViewer
                ref={getRefCallback(t.id)}
                path={t.path}
                overrideLanguage={t.overrideLanguage}
                onDirtyChange={getDirtyCallback(t.id)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
