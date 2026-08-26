import type { EditorPaneHandle } from "@/modules/editor";
import type { HtmlTab, Tab } from "@/modules/tabs";
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
};

/** 仅挂载当前活动的 HTML 渲染页，避免后台脚本继续运行。 */
export function HtmlStack({
  tabs,
  activeId,
  registerHandle,
  onSetHtmlView,
}: Props) {
  const activeHtml = tabs.find(
    (tab): tab is HtmlTab =>
      tab.id === activeId &&
      tab.kind === "html" &&
      tab.viewMode === "rendered" &&
      !tab.cold,
  );
  if (!activeHtml) return null;
  return (
    <div className="relative h-full w-full">
      <HtmlPreviewPane
        key={activeHtml.id}
        ref={(handle) => registerHandle(activeHtml.id, handle, "html")}
        path={activeHtml.path}
        onSetView={(mode) => onSetHtmlView(activeHtml.id, mode)}
      />
    </div>
  );
}
