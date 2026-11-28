import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { isActiveItem, isActiveProject, notepadToMarkdown } from "./model";
import { useNotePad } from "./store";
import type { NoteItem, NoteProject } from "./types";

function formatShortTime(ts?: number | null): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

export function NoteTrashView() {
  const projects = useNotePad((s) => s.projects);
  const restoreProject = useNotePad((s) => s.restoreProject);
  const purgeProject = useNotePad((s) => s.purgeProject);
  const restoreItem = useNotePad((s) => s.restoreItem);
  const purgeItem = useNotePad((s) => s.purgeItem);
  const emptyTrash = useNotePad((s) => s.emptyTrash);
  const importJsonPad = useNotePad((s) => s.importJsonPad);
  const replaceFromMarkdown = useNotePad((s) => s.replaceFromMarkdown);

  const deletedProjects: NoteProject[] = projects.filter(
    (p) => !isActiveProject(p),
  );
  const deletedItems: Array<{ projectName: string; item: NoteItem }> = [];
  for (const project of projects) {
    if (!isActiveProject(project)) continue;
    for (const item of project.items) {
      if (!isActiveItem(item)) {
        deletedItems.push({ projectName: project.name, item });
      }
    }
  }
  const hasTrash = deletedProjects.length > 0 || deletedItems.length > 0;

  const handleImportFile = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "记事本文件", extensions: ["json", "md", "txt"] }],
      });
      if (!selected || typeof selected !== "string") return;
      const result = await invoke<{ kind: string; content?: string }>(
        "fs_read_file",
        { path: selected },
      );
      if (result.kind !== "text" || typeof result.content !== "string") {
        toast.error("所选文件不是可读文本");
        return;
      }
      if (selected.toLowerCase().endsWith(".json")) {
        const parsed = JSON.parse(result.content) as unknown;
        const { projectsAdded, itemsAdded } = importJsonPad(parsed);
        toast.success(
          `导入完成：新增 ${projectsAdded} 个分组，${itemsAdded} 条待办`,
        );
      } else {
        replaceFromMarkdown(result.content);
        toast.success("已从 Markdown 同步待办");
      }
    } catch (error) {
      toast.error("导入失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleExportMarkdown = async () => {
    try {
      const target = await saveDialog({
        defaultPath: "codev-notepad.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!target || typeof target !== "string") return;
      const md = notepadToMarkdown({ projects });
      await invoke("fs_write_file", { path: target, content: md });
      toast.success("已导出为 Markdown 文件");
    } catch (error) {
      toast.error("导出失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-1.5 border-b border-border/50 pb-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          回收站（{deletedProjects.length} 组 · {deletedItems.length} 条）
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-5 px-1.5 text-[10px]"
            onClick={() => void handleImportFile()}
          >
            导入 JSON/MD
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-5 px-1.5 text-[10px]"
            onClick={() => void handleExportMarkdown()}
          >
            导出 MD
          </Button>
          {hasTrash ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-5 px-1.5 text-[10px] text-destructive hover:text-destructive"
              onClick={() => {
                emptyTrash();
                toast.success("已清空记事本回收站");
              }}
            >
              清空
            </Button>
          ) : null}
        </div>
      </div>

      {!hasTrash ? (
        <div className="flex flex-1 items-center justify-center py-8 text-[11px] text-muted-foreground/70">
          回收站为空（软删除的分组和待办会保留在这里）
        </div>
      ) : (
        <div className="reader-scrollbar min-h-0 flex-1 space-y-2 overflow-auto pr-0.5">
          {deletedProjects.length > 0 ? (
            <div className="space-y-1">
              <div className="px-1 text-[10px] font-medium text-muted-foreground">
                已删除分组
              </div>
              {deletedProjects.map((project) => (
                <div
                  key={project.id}
                  className="flex items-center justify-between gap-2 rounded border border-border/50 bg-muted/20 px-2 py-1"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium text-foreground">
                      {project.name}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      含 {project.items.length} 条 · 删除于{" "}
                      {formatShortTime(project.deletedAt)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="h-5 px-1.5 text-[10px]"
                      onClick={() => {
                        restoreProject(project.id);
                        toast.success(`已恢复分组「${project.name}」`);
                      }}
                    >
                      恢复
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-5 px-1.5 text-[10px] text-destructive hover:text-destructive"
                      onClick={() => purgeProject(project.id)}
                    >
                      清除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {deletedItems.length > 0 ? (
            <div className="space-y-1">
              <div className="px-1 text-[10px] font-medium text-muted-foreground">
                已删除待办
              </div>
              {deletedItems.map(({ projectName, item }) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-2 rounded border border-border/40 bg-muted/15 px-2 py-1"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] text-foreground/90">
                      {item.text.split("\n")[0] || "未命名待办"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {projectName} · {formatShortTime(item.deletedAt)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="h-5 px-1.5 text-[10px]"
                      onClick={() => {
                        restoreItem(item.id);
                        toast.success("已恢复待办");
                      }}
                    >
                      恢复
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-5 px-1.5 text-[10px] text-destructive hover:text-destructive"
                      onClick={() => purgeItem(item.id)}
                    >
                      清除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
