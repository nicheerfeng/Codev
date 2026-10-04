import type { EditorPaneHandle } from "@/modules/editor";
import type { Tab } from "@/modules/tabs";
import { EditorCompareView } from "./EditorCompareView";

type Props = {
  primaryTabs: Tab[];
  primaryActiveId: number;
  secondaryTabs: Tab[];
  secondaryActiveId: number;
  workspaceRoots: string[];
  onSelectPrimary: (id: number) => void;
  onSelectSecondary: (id: number) => void;
  onClose: (id: number) => void;
  onCloseTabsToRight: (groupIds: number[], id: number) => void;
  onPin: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onReorderPrimary: (fromId: number, toGapIndex: number) => void;
  onReorderSecondary: (fromId: number, toGapIndex: number) => void;
  onOverrideLanguage: (id: number, lang: string | null) => void;
  onMoveToGroup: (id: number, group: "primary" | "secondary") => void;
  registerEditorHandle: (
    id: number,
    handle: EditorPaneHandle | null,
    owner: "editor" | "markdown" | "html",
  ) => void;
  onEditorDirtyChange: (id: number, dirty: boolean) => void;
  onSetMarkdownView: (id: number, mode: "rendered" | "raw") => void;
  onSetHtmlView: (id: number, mode: "rendered" | "raw") => void;
  onFocusSearch: () => void;
  onFocusEditor: (id: number) => void;
};

/** 渲染中央双编辑器组，并保持两个阅览器的标签与活动状态独立。 */
export function WorkspaceSurface({
  primaryTabs,
  primaryActiveId,
  secondaryTabs,
  secondaryActiveId,
  workspaceRoots,
  onSelectPrimary,
  onSelectSecondary,
  onClose,
  onCloseTabsToRight,
  onPin,
  onRename,
  onReorderPrimary,
  onReorderSecondary,
  onOverrideLanguage,
  onMoveToGroup,
  registerEditorHandle,
  onEditorDirtyChange,
  onSetMarkdownView,
  onSetHtmlView,
  onFocusSearch,
  onFocusEditor,
}: Props) {
  return (
    <div className="relative h-full min-h-0">
      <EditorCompareView
        primaryTabs={primaryTabs}
        primaryActiveId={primaryActiveId}
        secondaryTabs={secondaryTabs}
        secondaryActiveId={secondaryActiveId}
        workspaceRoots={workspaceRoots}
        onSelectPrimary={onSelectPrimary}
        onSelectSecondary={onSelectSecondary}
        onClose={onClose}
        onCloseTabsToRight={onCloseTabsToRight}
        onPin={onPin}
        onRename={onRename}
        onReorderPrimary={onReorderPrimary}
        onReorderSecondary={onReorderSecondary}
        onOverrideLanguage={onOverrideLanguage}
        onMoveToGroup={onMoveToGroup}
        registerEditorHandle={registerEditorHandle}
        onDirtyChange={onEditorDirtyChange}
        onSetMarkdownView={onSetMarkdownView}
        onSetHtmlView={onSetHtmlView}
        onFocusSearch={onFocusSearch}
        onFocusEditor={onFocusEditor}
      />
    </div>
  );
}
