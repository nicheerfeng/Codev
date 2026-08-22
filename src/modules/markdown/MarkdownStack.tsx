import type { MarkdownTab, Tab } from "@/modules/tabs";
import type { EditorPaneHandle } from "@/modules/editor";
import { MarkdownPreviewPane } from "./MarkdownPreviewPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  registerHandle: (id: number, handle: EditorPaneHandle | null) => void;
  onSetMarkdownView: (id: number, mode: "rendered" | "raw") => void;
};

export function MarkdownStack({
  tabs,
  activeId,
  registerHandle,
  onSetMarkdownView,
}: Props) {
  const markdowns = tabs.filter(
    (t): t is MarkdownTab =>
      t.kind === "markdown" && t.viewMode === "rendered" && !t.cold,
  );
  const activeMarkdown = markdowns.find((tab) => tab.id === activeId);
  if (!activeMarkdown) return null;
  return (
    <div className="relative h-full w-full">
      <MarkdownPreviewPane
        key={activeMarkdown.id}
        ref={(handle) => registerHandle(activeMarkdown.id, handle)}
        path={activeMarkdown.path}
        visible
        onSetView={(mode) => onSetMarkdownView(activeMarkdown.id, mode)}
      />
    </div>
  );
}
