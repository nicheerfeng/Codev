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
} from "@hugeicons/core-free-icons";
import { pathKey, projectName, type PiOrganization } from "./organization";
import type { PiSessionSummary, PiViewStatus } from "./types";

export type SidebarThread = PiSessionSummary & {
  key: string;
  status?: PiViewStatus;
  waiting?: boolean;
};
type Props = {
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
  onExport: (thread: SidebarThread) => void;
  onClose: (thread: SidebarThread) => void;
  onCopyPath: (path: string) => void;
};

/** 复用 mcode 左栏的组→项目→线程与底部归档收纳，使用 Codev 菜单和控件。 */
export function PiSidebar(props: Props) {
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
              aria-label={
                thread.waiting
                  ? "等待输入"
                  : thread.status === "running"
                    ? "运行中"
                    : "就绪"
              }
              className={`size-1.5 shrink-0 rounded-full ${thread.waiting ? "bg-amber-400" : thread.status === "running" ? "animate-pulse bg-[#8eacc9]" : "bg-muted-foreground/35"}`}
            />
            <span className="truncate text-xs">
              {thread.name || thread.preview || "新线程"}
            </span>
          </button>
          {thread.path && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="mr-1 opacity-0 group-hover/pi-thread:opacity-100 focus-visible:opacity-100"
              title={isArchived ? "恢复线程" : "归档线程"}
              aria-label={isArchived ? "恢复线程" : "归档线程"}
              onClick={() => archive(thread, !isArchived)}
            >
              <span aria-hidden="true">{isArchived ? "↶" : "−"}</span>
            </Button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="rounded-xl">
        <ContextMenuItem onSelect={() => props.onRename(thread)}>
          重命名
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
        <ContextMenuItem onSelect={() => props.onClose(thread)}>
          关闭运行会话
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
            <ContextMenuItem onSelect={() => props.onRemoveProject(cwd)}>
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
      className="flex h-full min-h-0 w-[clamp(160px,28cqw,236px)] max-w-[48%] shrink-0 flex-col border-r border-border bg-card"
    >
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
        <Button
          variant="ghost"
          size="icon-sm"
          title="添加项目"
          aria-label="添加项目"
          onClick={props.onAddProject}
        >
          <HugeiconsIcon icon={Folder01Icon} size={15} />
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
