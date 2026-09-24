import type { EditorPaneHandle } from "@/modules/editor";
import type { HtmlTab, Tab } from "@/modules/tabs";
import { useCallback, useEffect, useState } from "react";
import { HtmlPreviewPane } from "./HtmlPreviewPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  registerHandle: (
    id: number,
    handle: EditorPaneHandle | null,
    owner: "editor" | "markdown" | "html",
  ) => void;
  onSetHtmlView: (id: number, mode: "rendered" | "raw") => void;
  onFocusSearch: () => void;
};

/** 保留已打开 HTML 的文档实例，切换 Codev 标签时维持页面交互状态。 */
export function HtmlStack({
  tabs,
  activeId,
  registerHandle,
  onSetHtmlView,
  onFocusSearch,
}: Props) {
  const activeHtml = tabs.find(
    (tab): tab is HtmlTab =>
      tab.id === activeId &&
      tab.kind === "html" &&
      tab.viewMode === "rendered" &&
      !tab.cold,
  );
  const [mountedIds, setMountedIds] = useState<number[]>([]);
  const liveIds = new Set(
    tabs.filter((tab) => tab.kind === "html").map((tab) => tab.id),
  );
  const cachedIds = mountedIds.filter((id) => liveIds.has(id));
  const visibleIds = activeHtml
    ? [...new Set([...cachedIds, activeHtml.id])]
    : cachedIds;

  useEffect(() => {
    setMountedIds((current) => {
      const next = current.filter((id) => liveIds.has(id));
      if (activeHtml && !next.includes(activeHtml.id)) next.push(activeHtml.id);
      return next.length === current.length &&
        next.every((id, index) => id === current[index])
        ? current
        : next;
    });
  }, [activeHtml, tabs]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {visibleIds.map((id) => {
        const tab = tabs.find(
          (candidate): candidate is HtmlTab =>
            candidate.id === id && candidate.kind === "html",
        );
        if (!tab) return null;
        return (
          <CachedHtmlPreview
            key={tab.id}
            tab={tab}
            active={activeHtml?.id === tab.id}
            registerHandle={registerHandle}
            onSetHtmlView={onSetHtmlView}
            onFocusSearch={onFocusSearch}
          />
        );
      })}
    </div>
  );
}

/** 保持已访问页的 iframe 挂载，并只向当前页注册编辑器句柄。 */
function CachedHtmlPreview({
  tab,
  active,
  registerHandle,
  onSetHtmlView,
  onFocusSearch,
}: {
  tab: HtmlTab;
  active: boolean;
  registerHandle: Props["registerHandle"];
  onSetHtmlView: Props["onSetHtmlView"];
  onFocusSearch: Props["onFocusSearch"];
}) {
  const setHandle = useCallback(
    (handle: EditorPaneHandle | null) =>
      registerHandle(tab.id, active ? handle : null, "html"),
    [active, registerHandle, tab.id],
  );

  return (
    <div
      className="absolute inset-0"
      style={{
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
      }}
      aria-hidden={!active}
      inert={!active}
    >
      <HtmlPreviewPane
        ref={setHandle}
        path={tab.path}
        onSetView={(mode) => onSetHtmlView(tab.id, mode)}
        onFocusSearch={onFocusSearch}
      />
    </div>
  );
}
