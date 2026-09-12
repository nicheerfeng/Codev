import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  ArrowDown01Icon,
  PlusSignIcon,
  Folder01Icon,
  Search01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { pathKey, projectName, type PiOrganization } from "./organization";
import type { PiSessionSummary, PiViewStatus } from "./types";

export type SidebarThread = PiSessionSummary & {
  key: string;
  status?: PiViewStatus;
  waiting?: boolean;
};
type Props = {
  width: number;
  onWidthChange: (width: number) => void;
  projects: string[];
  threads: SidebarThread[];
  selectedKey: string | null;
  selectedProject: string | null;
  organization: PiOrganization;
  onOrganize: (next: PiOrganization) => void;
  onAddProject: () => void;
  onRemoveProject: (cwd: string) => void;
  onNew: (cwd: string) => void;
  onSelect: (thread: SidebarThread) => void;
  onRename: (thread: SidebarThread) => void;
  onFork: (thread: SidebarThread) => void;
  onExport: (thread: SidebarThread) => void;
  onClose: (thread: SidebarThread) => void;
  onCopyPath: (path: string) => void;
};

/** 复用 mcode 左栏的组→项目→线程与底部归档收纳，使用 Codev 菜单和控件。 */
export function PiSidebar(props: Props) {
  const { width, onWidthChange: setWidth } = props;
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [groupEdit, setGroupEdit] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const org = props.organization;
  const archived = new Set(org.archived);
  /** 切换单个收纳节点，互不影响其他项目。 */
  const toggle = (key: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  /** 更新归档标记，只改变收纳位置。 */
  const archive = (thread: SidebarThread, value: boolean) =>
    props.onOrganize({
      ...org,
      archived: value
        ? [...new Set([...org.archived, thread.path])]
        : org.archived.filter((path) => path !== thread.path),
    });
  /** 渲染带状态和右键菜单的线程行。 */
  const threadRow = (thread: SidebarThread, isArchived: boolean) => (
    <ContextMenu key={thread.key}>
      <ContextMenuTrigger asChild>
        <div
          className={`group/pi-thread flex min-w-0 items-center rounded-lg ${props.selectedKey === thread.key ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
            onClick={() => props.onSelect(thread)}
            title={thread.name || thread.preview || "新线程"}
          >
            <span
              role="img"
              aria-label={
                thread.waiting
                  ? "等待输入"
                  : thread.status === "running"
                    ? "运行中"
                    : "就绪"
              }
              title={
                thread.waiting
                  ? "等待输入"
                  : thread.status === "running"
                    ? "运行中"
                    : "就绪"
              }
              className={`size-2 shrink-0 rounded-full ${thread.waiting ? "bg-amber-600 ring-2 ring-amber-600/25 dark:bg-amber-300" : thread.status === "running" ? "bg-[#477faf] ring-2 ring-[#477faf]/25 dark:bg-[#a6cceb]" : "bg-muted-foreground/50"}`}
            />
            <span className="min-w-0 flex-1 truncate text-xs">
              {thread.name || thread.preview || "新线程"}
            </span>
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="rounded-xl">
        <ContextMenuItem onSelect={() => props.onRename(thread)}>
          重命名
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => props.onFork(thread)}>
          分叉线程
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!thread.path}
          onSelect={() => props.onCopyPath(thread.path)}
        >
          复制会话路径
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => props.onExport(thread)}>
          导出 HTML
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!thread.path}
          onSelect={() => archive(thread, !isArchived)}
        >
          {isArchived ? "恢复线程" : "归档线程"}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!thread.path}
          onSelect={() => props.onClose(thread)}
        >
          彻底删除线程
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
  /** 渲染项目及分页线程，空项目保留新建入口。 */
  const projectRow = (cwd: string, isArchived = false) => {
    const key = pathKey(cwd);
    const rows = props.threads.filter(
      (thread) =>
        pathKey(thread.cwd) === key &&
        archived.has(thread.path) === isArchived &&
        (!filter ||
          `${thread.name ?? ""} ${thread.preview ?? ""} ${projectName(cwd)}`
            .toLocaleLowerCase()
            .includes(filter.toLocaleLowerCase())),
    );
    if (isArchived && !rows.length) return null;
    const nodeKey = `${isArchived ? "archive:" : "project:"}${key}`;
    const closed = !filter && collapsed.has(nodeKey);
    const visible = filter ? rows : rows.slice(0, counts[nodeKey] ?? 5);
    return (
      <div key={nodeKey} className="mb-1 min-w-0">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="group/pi-project flex min-w-0 items-center rounded-lg hover:bg-muted/70">
              <button
                type="button"
                className={`flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-2 text-left text-xs ${pathKey(props.selectedProject ?? "") === key ? "text-foreground" : "text-muted-foreground"}`}
                onClick={() => toggle(nodeKey)}
                aria-expanded={!closed}
                title={cwd}
              >
                <HugeiconsIcon
                  icon={closed ? ArrowRight01Icon : ArrowDown01Icon}
                  size={12}
                />
                <HugeiconsIcon icon={Folder01Icon} size={14} />
                <span className="truncate font-medium">{projectName(cwd)}</span>
              </button>
              {!isArchived && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={`移除项目 ${projectName(cwd)}`}
                  aria-label={`移除项目 ${projectName(cwd)}`}
                  className="text-muted-foreground opacity-0 group-hover/pi-project:opacity-100 focus-visible:opacity-100"
                  onClick={() => setRemoveTarget(cwd)}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={13} />
                </Button>
              )}
              {!isArchived && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={`在 ${projectName(cwd)} 新建线程`}
                  aria-label={`在 ${projectName(cwd)} 新建线程`}
                  className="opacity-0 group-hover/pi-project:opacity-100 focus-visible:opacity-100"
                  onClick={() => props.onNew(cwd)}
                >
                  <HugeiconsIcon icon={PlusSignIcon} size={13} />
                </Button>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="rounded-xl">
            <ContextMenuItem onSelect={() => props.onNew(cwd)}>
              新建线程
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>移到组</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {[{ id: "", name: "项目" }, ...org.groups].map((group) => (
                  <ContextMenuItem
                    key={group.id}
                    onSelect={() =>
                      props.onOrganize({
                        ...org,
                        projectGroups: {
                          ...org.projectGroups,
                          [key]: group.id,
                        },
                      })
                    }
                  >
                    {group.name}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem onSelect={() => props.onCopyPath(cwd)}>
              复制项目路径
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => setRemoveTarget(cwd)}>
              移除项目（保留文件）
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {!closed && (
          <div className="ml-3 border-l border-border/50 pl-1.5">
            {visible.map((thread) => threadRow(thread, isArchived))}
            {!rows.length && !isArchived && (
              <button
                type="button"
                className="px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => props.onNew(cwd)}
              >
                新建第一个线程
              </button>
            )}
            {visible.length < rows.length && (
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() =>
                  setCounts((value) => ({
                    ...value,
                    [nodeKey]: (value[nodeKey] ?? 5) + 20,
                  }))
                }
              >
                显示更多（{rows.length - visible.length}）
              </Button>
            )}
          </div>
        )}
      </div>
    );
  };
  return (
    <aside
      data-testid="pi-sidebar"
      className="relative flex h-full min-h-0 min-w-0 max-w-[calc(100%-180px)] shrink-0 flex-col border-l border-border bg-card"
      style={{ width }}
    >
      <div
        role="separator"
        aria-label="调整 Pi 侧栏宽度"
        aria-orientation="vertical"
        aria-valuenow={width}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none hover:bg-ring/20 focus-visible:bg-ring/30 focus-visible:outline-none"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const sidebar = event.currentTarget.parentElement!;
          const area = sidebar.parentElement!.getBoundingClientRect();
          setWidth(
            Math.max(
              120,
              Math.min(area.width - 180, area.right - event.clientX),
            ),
          );
        }}
        onPointerUp={(event) =>
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const area = event.currentTarget.parentElement!.parentElement!;
          setWidth(
            Math.max(
              120,
              Math.min(
                area.clientWidth - 180,
                width + (event.key === "ArrowLeft" ? 16 : -16),
              ),
            ),
          );
        }}
        onDoubleClick={() => setWidth(236)}
      />
      <div className="flex shrink-0 items-center gap-1 px-2 pt-3 pb-2">
        <Button
          variant="secondary"
          size="sm"
          className="min-w-0 flex-1 justify-start rounded-lg text-xs"
          onClick={() =>
            props.selectedProject
              ? props.onNew(props.selectedProject)
              : props.onAddProject()
          }
        >
          <HugeiconsIcon icon={PlusSignIcon} size={14} />
          新建线程
        </Button>
      </div>
      <div className="relative mx-2 mb-2">
        <HugeiconsIcon
          icon={Search01Icon}
          size={13}
          className="absolute top-2 left-2 text-muted-foreground"
        />
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="筛选项目与线程"
          aria-label="筛选项目与线程"
          className="h-7 rounded-lg pl-7 text-xs!"
        />
      </div>
      <div className="reader-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {[{ id: "", name: "项目" }, ...org.groups].map((group) => (
          <section key={group.id} className="mb-3">
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className="flex items-center py-1">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left text-[11px] text-muted-foreground"
                    onClick={() => toggle(`group:${group.id}`)}
                  >
                    <HugeiconsIcon
                      icon={
                        collapsed.has(`group:${group.id}`)
                          ? ArrowRight01Icon
                          : ArrowDown01Icon
                      }
                      size={12}
                    />
                    <span className="truncate">{group.name}</span>
                  </button>
                  {!group.id && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        title="添加项目"
                        aria-label="添加项目"
                        onClick={props.onAddProject}
                      >
                        <HugeiconsIcon icon={Folder01Icon} size={13} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        title="新建组"
                        aria-label="新建组"
                        onClick={() =>
                          setGroupEdit({ id: crypto.randomUUID(), name: "" })
                        }
                      >
                        <HugeiconsIcon icon={PlusSignIcon} size={12} />
                      </Button>
                    </div>
                  )}
                </div>
              </ContextMenuTrigger>
              {group.id && (
                <ContextMenuContent className="rounded-xl">
                  <ContextMenuItem onSelect={() => setGroupEdit(group)}>
                    重命名组
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() =>
                      props.onOrganize({
                        ...org,
                        groups: org.groups.filter(
                          (item) => item.id !== group.id,
                        ),
                        projectGroups: Object.fromEntries(
                          Object.entries(org.projectGroups).filter(
                            ([, id]) => id !== group.id,
                          ),
                        ),
                      })
                    }
                  >
                    解散组（保留项目）
                  </ContextMenuItem>
                </ContextMenuContent>
              )}
            </ContextMenu>
            {(!collapsed.has(`group:${group.id}`) || filter) &&
              props.projects
                .filter(
                  (path) =>
                    (org.projectGroups[pathKey(path)] ?? "") === group.id,
                )
                .map((path) => projectRow(path))}
          </section>
        ))}
        <section className="border-t border-border pt-2">
          <button
            type="button"
            className="flex w-full items-center gap-1 py-2 text-xs text-muted-foreground"
            aria-expanded={archiveOpen}
            onClick={() => setArchiveOpen(!archiveOpen)}
          >
            <HugeiconsIcon
              icon={archiveOpen ? ArrowDown01Icon : ArrowRight01Icon}
              size={12}
            />
            已归档{" "}
            <span className="ml-auto">
              {props.threads.filter((item) => archived.has(item.path)).length}
            </span>
          </button>
          {(archiveOpen || filter) &&
            props.projects.map((path) => projectRow(path, true))}
        </section>
      </div>
      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <DialogContent className="rounded-2xl" showCloseButton={false}>
          <DialogTitle>
            移除项目“{projectName(removeTarget ?? "")}”？
          </DialogTitle>
          <DialogDescription>
            仅从 Pi 侧栏移除。磁盘文件、Pi 会话和正在运行的任务均保留。
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRemoveTarget(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (removeTarget) props.onRemoveProject(removeTarget);
                setRemoveTarget(null);
              }}
            >
              移除项目
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={groupEdit !== null}
        onOpenChange={(open) => {
          if (!open) setGroupEdit(null);
        }}
      >
        <DialogContent className="rounded-2xl" showCloseButton={false}>
          <DialogTitle>
            {org.groups.some((item) => item.id === groupEdit?.id)
              ? "重命名组"
              : "新建组"}
          </DialogTitle>
          <DialogDescription>
            将项目收纳到组中，原目录和会话不变。
          </DialogDescription>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!groupEdit?.name.trim()) return;
              props.onOrganize({
                ...org,
                groups: [
                  ...org.groups.filter((item) => item.id !== groupEdit.id),
                  { ...groupEdit, name: groupEdit.name.trim() },
                ],
              });
              setGroupEdit(null);
            }}
          >
            <Input
              aria-label="组名称"
              autoFocus
              value={groupEdit?.name ?? ""}
              onChange={(event) =>
                setGroupEdit((value) =>
                  value ? { ...value, name: event.target.value } : null,
                )
              }
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setGroupEdit(null)}
              >
                取消
              </Button>
              <Button type="submit" disabled={!groupEdit?.name.trim()}>
                保存
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
