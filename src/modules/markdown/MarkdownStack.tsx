import type { MarkdownTab, Tab } from "@/modules/tabs";
import type { EditorPaneHandle } from "@/modules/editor";
import { useCallback } from "react";
import { MarkdownPreviewPane } from "./MarkdownPreviewPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  registerHandle: (
    id: number,
    handle: EditorPaneHandle | null,
    owner: "editor" | "markdown" | "html",
  ) => void;
  onSetMarkdownView: (id: number, mode: "rendered" | "raw") => void;
};

/** 所有已打开的 Markdown 阅读页常驻，标签切换只改变显隐。 */
export function MarkdownStack({
  tabs,
  activeId,
  registerHandle,
  onSetMarkdownView,
}: Props) {
  const markdownTabs = tabs.filter(
    (tab): tab is MarkdownTab =>
      tab.kind === "markdown" && tab.viewMode === "rendered" && !tab.cold,
  );

  return (
    <div className="relative h-full w-full overflow-hidden">
      {markdownTabs.map((tab) => (
        <RetainedMarkdown
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          registerHandle={registerHandle}
          onSetMarkdownView={onSetMarkdownView}
        />
      ))}
    </div>
  );
}

function RetainedMarkdown({
  tab,
  active,
  registerHandle,
  onSetMarkdownView,
}: {
  tab: MarkdownTab;
  active: boolean;
  registerHandle: Props["registerHandle"];
  onSetMarkdownView: Props["onSetMarkdownView"];
}) {
  const setHandle = useCallback(
    (handle: EditorPaneHandle | null) =>
      registerHandle(tab.id, active ? handle : null, "markdown"),
    [active, registerHandle, tab.id],
  );
  const setView = useCallback(
    (mode: "rendered" | "raw") => onSetMarkdownView(tab.id, mode),
    [onSetMarkdownView, tab.id],
  );

  return (
    <div
      className="absolute inset-0"
      style={{
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
      }}
      aria-hidden={!active}
    >
      <MarkdownPreviewPane
        ref={setHandle}
        path={tab.path}
        visible={active}
        onSetView={setView}
      />
    </div>
  );
}
