import type { MarkdownTab, Tab } from "@/modules/tabs";
import { MarkdownPreviewPane } from "./MarkdownPreviewPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSetMarkdownView: (id: number, mode: "rendered" | "raw") => void;
};

export function MarkdownStack({ tabs, activeId, onSetMarkdownView }: Props) {
  const markdowns = tabs.filter(
    (t): t is MarkdownTab => t.kind === "markdown" && !t.cold,
  );
  const activeMarkdown = markdowns.find((tab) => tab.id === activeId);
  if (!activeMarkdown) return null;
  return (
    <div className="relative h-full w-full">
      <MarkdownPreviewPane
        key={activeMarkdown.id}
        path={activeMarkdown.path}
        visible
        onSetView={(mode) => onSetMarkdownView(activeMarkdown.id, mode)}
      />
    </div>
  );
}
