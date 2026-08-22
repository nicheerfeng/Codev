import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { EditorStack, type EditorPaneHandle } from "@/modules/editor";
import { MarkdownStack } from "@/modules/markdown";
import { TabBar } from "@/modules/tabs";
import type { Tab } from "@/modules/tabs";

type EditorGroupId = "primary" | "secondary";

type EditorGroupProps = {
  groupId: EditorGroupId;
  tabs: Tab[];
  activeId: number;
  workspaceRoots: string[];
  labelScopeTabs: Tab[];
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onCloseTabsToRight: (groupIds: number[], id: number) => void;
  onCloseOtherTabs: (groupIds: number[], id: number) => void;
  onPin: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onReorder: (fromId: number, toGapIndex: number) => void;
  onOverrideLanguage: (id: number, lang: string | null) => void;
  onMoveToGroup: (id: number, group: EditorGroupId) => void;
  registerEditorHandle: (id: number, handle: EditorPaneHandle | null) => void;
  onDirtyChange: (id: number, dirty: boolean) => void;
  onSetMarkdownView: (id: number, mode: "rendered" | "raw") => void;
  onFocusEditor: (id: number) => void;
};

/** 渲染一个拥有独立标签栏和阅览器堆栈的编辑器组。 */
function EditorGroup({
  groupId,
  tabs,
  activeId,
  workspaceRoots,
  labelScopeTabs,
  onSelect,
  onClose,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onPin,
  onRename,
  onReorder,
  onOverrideLanguage,
  onMoveToGroup,
  registerEditorHandle,
  onDirtyChange,
  onSetMarkdownView,
  onFocusEditor,
}: EditorGroupProps) {
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const showEditorStack =
    activeTab?.kind === "editor" ||
    (activeTab?.kind === "markdown" && activeTab.viewMode === "raw");
  const showMarkdownStack =
    activeTab?.kind === "markdown" && activeTab.viewMode === "rendered";

  return (
    <div
      data-editor-group={groupId}
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      {tabs.length > 0 && (
        <div className="flex h-8 min-w-0 shrink-0 items-center border-b border-border/60 px-2">
          <TabBar
            tabs={tabs}
            activeId={activeId}
            onSelect={onSelect}
            onClose={onClose}
            onCloseTabsToRight={(id) =>
              onCloseTabsToRight(
                tabs.map((tab) => tab.id),
                id,
              )
            }
            onCloseOtherTabs={(id) =>
              onCloseOtherTabs(
                tabs.map((tab) => tab.id),
                id,
              )
            }
            onPin={onPin}
            onRename={onRename}
            onReorder={onReorder}
            onOverrideLanguage={onOverrideLanguage}
            workspaceRoots={workspaceRoots}
            labelScopeTabs={labelScopeTabs}
            groupId={groupId}
            onMoveToGroup={onMoveToGroup}
          />
        </div>
      )}
      <div
        className="relative min-h-0 min-w-0 flex-1"
        onFocusCapture={() => {
          if (activeTab) onFocusEditor(activeTab.id);
        }}
      >
        <div
          className={cn(
            "absolute inset-0",
            showEditorStack ? "pointer-events-auto" : "pointer-events-none",
          )}
        >
          <EditorStack
            tabs={tabs}
            activeId={activeId}
            registerHandle={registerEditorHandle}
            onDirtyChange={onDirtyChange}
            onSetMarkdownView={onSetMarkdownView}
          />
        </div>
        <div
          className={cn(
            "absolute inset-0",
            showMarkdownStack ? "pointer-events-auto" : "pointer-events-none",
          )}
        >
          <MarkdownStack
            tabs={tabs}
            activeId={activeId}
            registerHandle={registerEditorHandle}
            onSetMarkdownView={onSetMarkdownView}
          />
        </div>
      </div>
    </div>
  );
}

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
  onCloseOtherTabs: (groupIds: number[], id: number) => void;
  onPin: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onReorderPrimary: (fromId: number, toGapIndex: number) => void;
  onReorderSecondary: (fromId: number, toGapIndex: number) => void;
  onOverrideLanguage: (id: number, lang: string | null) => void;
  onMoveToGroup: (id: number, group: EditorGroupId) => void;
  registerEditorHandle: (id: number, handle: EditorPaneHandle | null) => void;
  onDirtyChange: (id: number, dirty: boolean) => void;
  onSetMarkdownView: (id: number, mode: "rendered" | "raw") => void;
  onFocusEditor: (id: number) => void;
};

/** 在中央区域渲染单栏或固定双栏的编辑器布局。 */
export function EditorCompareView({
  primaryTabs,
  primaryActiveId,
  secondaryTabs,
  secondaryActiveId,
  workspaceRoots,
  onSelectPrimary,
  onSelectSecondary,
  onClose,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onPin,
  onRename,
  onReorderPrimary,
  onReorderSecondary,
  onOverrideLanguage,
  onMoveToGroup,
  registerEditorHandle,
  onDirtyChange,
  onSetMarkdownView,
  onFocusEditor,
}: Props) {
  const labelScopeTabs = [...primaryTabs, ...secondaryTabs];
  const primary = (
    <EditorGroup
      groupId="primary"
      tabs={primaryTabs}
      activeId={primaryActiveId}
      workspaceRoots={workspaceRoots}
      labelScopeTabs={labelScopeTabs}
      onSelect={onSelectPrimary}
      onClose={onClose}
      onCloseTabsToRight={onCloseTabsToRight}
      onCloseOtherTabs={onCloseOtherTabs}
      onPin={onPin}
      onRename={onRename}
      onReorder={onReorderPrimary}
      onOverrideLanguage={onOverrideLanguage}
      onMoveToGroup={onMoveToGroup}
      registerEditorHandle={registerEditorHandle}
      onDirtyChange={onDirtyChange}
      onSetMarkdownView={onSetMarkdownView}
      onFocusEditor={onFocusEditor}
    />
  );

  const secondary = (
    <EditorGroup
      groupId="secondary"
      tabs={secondaryTabs}
      activeId={secondaryActiveId}
      workspaceRoots={workspaceRoots}
      labelScopeTabs={labelScopeTabs}
      onSelect={onSelectSecondary}
      onClose={onClose}
      onCloseTabsToRight={onCloseTabsToRight}
      onCloseOtherTabs={onCloseOtherTabs}
      onPin={onPin}
      onRename={onRename}
      onReorder={onReorderSecondary}
      onOverrideLanguage={onOverrideLanguage}
      onMoveToGroup={onMoveToGroup}
      registerEditorHandle={registerEditorHandle}
      onDirtyChange={onDirtyChange}
      onSetMarkdownView={onSetMarkdownView}
      onFocusEditor={onFocusEditor}
    />
  );

  if (primaryTabs.length === 0) return secondary;
  if (secondaryTabs.length === 0) return primary;

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-full min-h-0 min-w-0 flex-1"
    >
      <ResizablePanel id="editor-left" minSize="30%">
        {primary}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="editor-right" defaultSize="50%" minSize="30%">
        {secondary}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
