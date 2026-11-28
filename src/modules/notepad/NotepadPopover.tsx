import {
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CheckListIcon,
  Delete02Icon,
  DragDropVerticalIcon,
  File01Icon,
  HelpCircleIcon,
  PlusSignIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { uiState } from "@/lib/uiState";
import { copyToClipboard } from "@/modules/explorer/lib/contextActions";
import {
  isActiveItem,
  isActiveProject,
  notepadToMarkdown,
  parsePastedTodoLines,
} from "./model";
import { NoteInlineMarkdown } from "./NoteInlineMarkdown";
import { NoteTrashView } from "./NoteTrashView";
import { useNotePad } from "./store";
import { useNoteItemReorder, useNoteReorder } from "./useNoteReorder";
import {
  TMP_PROJECT_ID,
  type NoteItem,
  type NoteListId,
  type NoteProject,
} from "./types";

const BUBBLE = 28;
const POSITION_KEY = "codev.notepad.bubble";
const PANEL_KEY = "codev.notepad.panel";
const MIN_PANEL_WIDTH = 300;
const MIN_PANEL_HEIGHT = 240;
const NOTE_LINE = 22;
const NOTE_MAX_INPUT = 180;

type PanelBox = { x: number; y: number; w: number; h: number };
type Edge = "n" | "s" | "e" | "w";
type ViewMode = "todo" | "markdown" | "trash";

function growTextarea(
  node: HTMLTextAreaElement,
  min = NOTE_LINE,
  max = NOTE_MAX_INPUT,
) {
  node.style.height = `${min}px`;
  node.style.overflowY = "hidden";
  const next = node.value ? node.scrollHeight : min;
  node.style.height = `${Math.min(max, Math.max(min, next))}px`;
  node.style.overflowY = next > max ? "auto" : "hidden";
}

function insertLineBreak(node: HTMLTextAreaElement) {
  const start = node.selectionStart;
  const end = node.selectionEnd;
  const next = `${node.value.slice(0, start)}\n${node.value.slice(end)}`;
  const caret = start + 1;
  node.value = next;
  node.setSelectionRange(caret, caret);
  growTextarea(node);
  return next;
}

function NoteInput({
  value,
  onChange,
  onSubmit,
  onEmptyBackspace,
  onNavigate,
  onMultiPaste,
  placeholder,
  inputRef,
  singleLine = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onEmptyBackspace?: () => void;
  onNavigate?: (direction: -1 | 1) => void;
  onMultiPaste?: (entries: Array<{ text: string; done: boolean }>) => void;
  placeholder?: string;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  singleLine?: boolean;
}) {
  const local = useRef<HTMLTextAreaElement>(null);
  const setRef = (node: HTMLTextAreaElement | null) => {
    local.current = node;
    if (inputRef) inputRef.current = node;
  };
  useLayoutEffect(() => {
    if (local.current) {
      growTextarea(
        local.current,
        NOTE_LINE,
        singleLine ? NOTE_LINE : NOTE_MAX_INPUT,
      );
    }
  }, [value, singleLine]);
  useLayoutEffect(() => {
    const node = local.current;
    if (!node) return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      growTextarea(node, NOTE_LINE, singleLine ? NOTE_LINE : NOTE_MAX_INPUT);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [singleLine]);

  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (!onMultiPaste) return;
    const raw = event.clipboardData.getData("text");
    if (!raw.includes("\n")) return;
    const parsed = parsePastedTodoLines(raw);
    if (parsed.length <= 1) return;
    event.preventDefault();
    onMultiPaste(parsed);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }
    if (
      event.key === "Backspace" &&
      !value &&
      onEmptyBackspace &&
      event.currentTarget.selectionStart === 0 &&
      event.currentTarget.selectionEnd === 0
    ) {
      event.preventDefault();
      onEmptyBackspace();
      return;
    }
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      onNavigate &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const node = event.currentTarget;
      const before = node.value.slice(0, node.selectionStart);
      const after = node.value.slice(node.selectionEnd);
      if (event.key === "ArrowUp" && !before.includes("\n")) {
        event.preventDefault();
        onNavigate(-1);
        return;
      }
      if (event.key === "ArrowDown" && !after.includes("\n")) {
        event.preventDefault();
        onNavigate(1);
        return;
      }
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      onChange(insertLineBreak(event.currentTarget));
      return;
    }
    onSubmit();
  };

  return (
    <textarea
      ref={setRef}
      value={value}
      rows={1}
      aria-label={placeholder ?? "待办内容"}
      placeholder={placeholder}
      className="block h-[22px] min-h-[22px] w-full resize-none overflow-hidden bg-transparent p-0 text-[11.5px] leading-[22px] outline-none [overflow-wrap:anywhere] placeholder:text-muted-foreground/70"
      onChange={(event) => onChange(event.target.value)}
      onPaste={onPaste}
      onKeyDown={onKeyDown}
    />
  );
}

function NoteRow({
  item,
  listId,
  editing,
  onEdit,
  onNavigate,
}: {
  item: NoteItem;
  listId: NoteListId;
  editing: boolean;
  onEdit: (id: string | null) => void;
  onNavigate: (itemId: string, direction: -1 | 1) => void;
}) {
  const moveNoteItemById = useNotePad((state) => state.moveNoteItemById);
  const handle = useNoteItemReorder(listId, moveNoteItemById);
  const setItemText = useNotePad((state) => state.setItemText);
  const toggleItem = useNotePad((state) => state.toggleItem);
  const removeItem = useNotePad((state) => state.removeItem);
  const restoreItem = useNotePad((state) => state.restoreItem);
  const insertAfter = useNotePad((state) => state.insertAfter);
  const insertManyAfter = useNotePad((state) => state.insertManyAfter);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && input.current) {
      const node = input.current;
      node.focus({ preventScroll: true });
      const end = node.value.length;
      node.setSelectionRange(end, end);
    }
  }, [editing]);

  const softDelete = () => {
    const label = item.text.split("\n")[0]?.trim();
    removeItem(item.id);
    if (editing) onEdit(null);
    if (label) {
      toast.info(`已移入回收站：${label.slice(0, 24)}`, {
        action: {
          label: "撤销",
          onClick: () => restoreItem(item.id),
        },
      });
    }
  };

  return (
    <div
      data-note-item=""
      data-note-item-id={item.id}
      className={`group flex min-w-0 items-start gap-1 rounded-sm px-1 py-1 hover:bg-muted/45 ${
        editing ? "bg-muted/35" : ""
      }`}
    >
      <button
        type="button"
        aria-label="拖拽排序"
        title="拖拽排序（支持跨组）"
        className="mt-0.5 flex size-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground/55 opacity-0 hover:text-foreground group-hover:opacity-100"
        {...handle(item.id)}
      >
        <HugeiconsIcon icon={DragDropVerticalIcon} size={11} />
      </button>
      <button
        type="button"
        aria-label={item.done ? "标记未完成" : "标记完成"}
        className={`mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors ${
          item.done
            ? "border-sky-500/70 bg-sky-500/20"
            : "border-muted-foreground/45 hover:border-foreground/70"
        }`}
        onClick={() => toggleItem(item.id)}
      >
        {item.done && (
          <span className="block size-1.5 rounded-[1px] bg-sky-400" />
        )}
      </button>
      {editing ? (
        <div className="min-w-0 flex-1 rounded border border-border/80 bg-background/50 px-1.5 py-0.5">
          <NoteInput
            value={item.text}
            inputRef={input}
            placeholder="支持 **粗体** `代码` #标签，Shift+Enter 换行"
            onChange={(text) => setItemText(item.id, text)}
            onSubmit={() => {
              if (!item.text.trim()) {
                removeItem(item.id);
                onEdit(null);
                return;
              }
              onEdit(insertAfter(item.id));
            }}
            onEmptyBackspace={() => {
              onNavigate(item.id, -1);
              removeItem(item.id);
            }}
            onNavigate={(dir) => onNavigate(item.id, dir)}
            onMultiPaste={(entries) => {
              const [first, ...rest] = entries;
              if (!first) return;
              if (!item.text.trim()) {
                setItemText(item.id, first.text);
                if (first.done && !item.done) toggleItem(item.id);
                const lastId =
                  rest.length > 0 ? insertManyAfter(item.id, rest) : item.id;
                onEdit(lastId);
              } else {
                const lastId = insertManyAfter(item.id, entries);
                onEdit(lastId);
              }
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          aria-label="编辑待办内容"
          className="min-w-0 flex-1 cursor-text text-left"
          onClick={() => onEdit(item.id)}
        >
          <NoteInlineMarkdown text={item.text} done={item.done} />
        </button>
      )}
      <button
        type="button"
        aria-label="软删除待办"
        title="移入回收站"
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
        onClick={softDelete}
      >
        <HugeiconsIcon icon={Cancel01Icon} size={11} />
      </button>
    </div>
  );
}

function ProjectBlock({
  project,
  index,
  searchQuery,
  editingId,
  onEdit,
  onNavigate,
}: {
  project: NoteProject;
  index: number;
  searchQuery: string;
  editingId: string | null;
  onEdit: (id: string | null) => void;
  onNavigate: (itemId: string, direction: -1 | 1) => void;
}) {
  const reorderProject = useNotePad((state) => state.reorderProject);
  const handle = useNoteReorder(reorderProject);
  const addProjectItem = useNotePad((state) => state.addProjectItem);
  const renameProject = useNotePad((state) => state.renameProject);
  const removeProject = useNotePad((state) => state.removeProject);
  const restoreProject = useNotePad((state) => state.restoreProject);
  const toggleProjectCollapsed = useNotePad(
    (state) => state.toggleProjectCollapsed,
  );
  const toggleDoneCollapsed = useNotePad((state) => state.toggleDoneCollapsed);

  const [draft, setDraft] = useState(project.name);
  useEffect(() => setDraft(project.name), [project.name]);

  const activeItems = useMemo(
    () => project.items.filter(isActiveItem),
    [project.items],
  );
  const query = searchQuery.trim().toLowerCase();
  const filteredItems = useMemo(() => {
    if (!query) return activeItems;
    if (project.name.toLowerCase().includes(query)) return activeItems;
    return activeItems.filter((item) =>
      item.text.toLowerCase().includes(query),
    );
  }, [activeItems, project.name, query]);

  const pendingItems = useMemo(
    () => filteredItems.filter((item) => !item.done),
    [filteredItems],
  );
  const doneItems = useMemo(
    () => filteredItems.filter((item) => item.done),
    [filteredItems],
  );

  const totalCount = activeItems.length;
  const pendingCount = activeItems.filter((i) => !i.done).length;
  const doneCount = totalCount - pendingCount;
  const ratio = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  if (query && filteredItems.length === 0 && !project.name.toLowerCase().includes(query)) {
    return null;
  }

  const isCollapsed = !query && project.collapsed === true;
  const isDoneCollapsed = !query && project.doneCollapsed !== false;

  const commit = () => {
    const title = draft.trim();
    if (title) renameProject(project.id, title);
    else setDraft(project.name);
  };

  return (
    <section
      data-note-project=""
      className="border-b border-border/40 py-1 last:border-b-0"
    >
      <div className="group flex h-7 items-center gap-1 px-0.5">
        <button
          type="button"
          aria-label="拖拽项目"
          title="拖拽排序分组"
          className="flex size-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground/60 hover:text-foreground"
          {...handle(index)}
        >
          <HugeiconsIcon icon={DragDropVerticalIcon} size={11} />
        </button>
        <button
          type="button"
          aria-label={isCollapsed ? "展开分组" : "折叠分组"}
          className="flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={() => toggleProjectCollapsed(project.id)}
        >
          <HugeiconsIcon
            icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
            size={11}
          />
        </button>
        {project.locked ? (
          <button
            type="button"
            className="h-6 min-w-0 flex-1 truncate text-left text-[11.5px] font-semibold leading-6 text-foreground/90"
            onClick={() => toggleProjectCollapsed(project.id)}
          >
            {project.name}
          </button>
        ) : (
          <input
            value={draft}
            aria-label="项目名"
            className="h-6 min-w-0 flex-1 bg-transparent text-[11.5px] font-semibold text-foreground/90 outline-none"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                setDraft(project.name);
                event.currentTarget.blur();
              }
            }}
          />
        )}
        <div
          className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground"
          title={`未完成 ${pendingCount} · 已完成 ${doneCount} · 共 ${totalCount}`}
        >
          {totalCount > 0 ? (
            <>
              <span className="tabular-nums">
                {pendingCount}/{totalCount}
              </span>
              <span className="h-1 w-8 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-sky-500/75 transition-all"
                  style={{ width: `${ratio}%` }}
                />
              </span>
            </>
          ) : (
            <span className="opacity-50">0</span>
          )}
        </div>
        <button
          type="button"
          aria-label="新增项目待办"
          title="在此分组新增待办"
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          onClick={() => onEdit(addProjectItem(project.id))}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={11} />
        </button>
        {!project.locked && (
          <button
            type="button"
            aria-label="软删除项目"
            title="移入回收站"
            className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted/60 hover:text-destructive group-hover:opacity-100"
            onClick={() => {
              removeProject(project.id);
              toast.info(`已将分组「${project.name}」移入回收站`, {
                action: {
                  label: "撤销",
                  onClick: () => restoreProject(project.id),
                },
              });
            }}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={11} />
          </button>
        )}
      </div>

      {!isCollapsed ? (
        <div data-note-list={project.id} className="pl-3.5">
          {pendingItems.map((item) => (
            <NoteRow
              key={item.id}
              item={item}
              listId={project.id}
              editing={editingId === item.id}
              onEdit={onEdit}
              onNavigate={onNavigate}
            />
          ))}
          {doneItems.length > 0 ? (
            <div className="mt-0.5">
              <button
                type="button"
                className="flex h-6 w-full items-center gap-1 rounded px-1 text-[10.5px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                onClick={() => toggleDoneCollapsed(project.id)}
              >
                <HugeiconsIcon
                  icon={isDoneCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                  size={10}
                />
                <span>已完成（{doneItems.length}）</span>
              </button>
              {!isDoneCollapsed ? (
                <div className="pl-1 opacity-85">
                  {doneItems.map((item) => (
                    <NoteRow
                      key={item.id}
                      item={item}
                      listId={project.id}
                      editing={editingId === item.id}
                      onEdit={onEdit}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function readBubble() {
  try {
    const saved = JSON.parse(uiState.getItem(POSITION_KEY) ?? "null") as {
      x?: number;
      y?: number;
    } | null;
    if (typeof saved?.x === "number" && typeof saved?.y === "number") {
      return { x: saved.x, y: saved.y };
    }
  } catch {
    /* 首次使用放在右下角附近。 */
  }
  return {
    x: Math.max(16, window.innerWidth - 72),
    y: Math.max(72, window.innerHeight - 96),
  };
}

function clampBubble(x: number, y: number) {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - BUBBLE - 8)),
    y: Math.max(40, Math.min(y, window.innerHeight - BUBBLE - 8)),
  };
}

function defaultPanel(bubble: { x: number; y: number }): PanelBox {
  const w = 360;
  const h = 420;
  return {
    x: Math.max(8, bubble.x + BUBBLE - w),
    y: Math.max(48, bubble.y - h - 8),
    w,
    h,
  };
}

function readPanel(bubble: { x: number; y: number }): PanelBox {
  try {
    const saved = JSON.parse(
      uiState.getItem(PANEL_KEY) ?? "null",
    ) as Partial<PanelBox> | null;
    if (
      typeof saved?.x === "number" &&
      typeof saved?.y === "number" &&
      typeof saved?.w === "number" &&
      typeof saved?.h === "number"
    ) {
      return clampPanel({ x: saved.x, y: saved.y, w: saved.w, h: saved.h });
    }
  } catch {
    /* 首次打开用默认尺寸。 */
  }
  return clampPanel(defaultPanel(bubble));
}

function clampPanel(box: PanelBox): PanelBox {
  const w = Math.min(
    window.innerWidth - 16,
    Math.max(MIN_PANEL_WIDTH, Math.round(box.w)),
  );
  const h = Math.min(
    window.innerHeight - 24,
    Math.max(MIN_PANEL_HEIGHT, Math.round(box.h)),
  );
  return {
    w,
    h,
    x: Math.max(8, Math.min(box.x, window.innerWidth - w - 8)),
    y: Math.max(8, Math.min(box.y, window.innerHeight - h - 8)),
  };
}

function resizePanel(origin: PanelBox, edge: Edge, dx: number, dy: number) {
  const next = { ...origin };
  if (edge === "e") next.w = origin.w + dx;
  if (edge === "w") {
    next.x = origin.x + dx;
    next.w = origin.w - dx;
  }
  if (edge === "s") next.h = origin.h + dy;
  if (edge === "n") {
    next.y = origin.y + dy;
    next.h = origin.h - dy;
  }
  return clampPanel(next);
}

export function NotepadPopover() {
  const [open, setOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("todo");
  const [draft, setDraft] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [markdownDraft, setMarkdownDraft] = useState("");
  const [markdownDirty, setMarkdownDirty] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [position, setPosition] = useState(readBubble);
  const [panel, setPanel] = useState(() => readPanel(readBubble()));
  const root = useRef<HTMLDivElement>(null);
  const panelElement = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const panelDrag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: PanelBox;
    moved: boolean;
  } | null>(null);
  const edgeDrag = useRef<{
    pointerId: number;
    edge: Edge;
    origin: PanelBox;
    startX: number;
    startY: number;
  } | null>(null);

  const load = useNotePad((state) => state.load);
  const projects = useNotePad((state) => state.projects);
  const addInbox = useNotePad((state) => state.addInbox);
  const addManyToProject = useNotePad((state) => state.addManyToProject);
  const addProject = useNotePad((state) => state.addProject);
  const setAllCollapsed = useNotePad((state) => state.setAllCollapsed);
  const replaceFromMarkdown = useNotePad((state) => state.replaceFromMarkdown);

  const activeProjects = useMemo(
    () => projects.filter(isActiveProject),
    [projects],
  );
  const stats = useMemo(() => {
    let pending = 0;
    let done = 0;
    let trash = projects.filter((p) => !isActiveProject(p)).length;
    for (const p of activeProjects) {
      for (const item of p.items) {
        if (!isActiveItem(item)) {
          trash += 1;
        } else if (item.done) {
          done += 1;
        } else {
          pending += 1;
        }
      }
    }
    return { pending, done, total: pending + done, trash };
  }, [activeProjects, projects]);

  const allCollapsed = useMemo(
    () =>
      activeProjects.length > 0 &&
      activeProjects.every((p) => p.collapsed === true),
    [activeProjects],
  );

  const visibleOrder = useMemo(() => {
    const ids: string[] = [];
    const q = searchQuery.trim().toLowerCase();
    for (const p of activeProjects) {
      if (!q && p.collapsed) continue;
      const items = p.items.filter(isActiveItem).filter((item) => {
        if (!q) return true;
        return (
          p.name.toLowerCase().includes(q) ||
          item.text.toLowerCase().includes(q)
        );
      });
      for (const item of items.filter((i) => !i.done)) ids.push(item.id);
      if (q || p.doneCollapsed === false) {
        for (const item of items.filter((i) => i.done)) ids.push(item.id);
      }
    }
    return ids;
  }, [activeProjects, searchQuery]);

  const navigateItem = (itemId: string, direction: -1 | 1) => {
    const idx = visibleOrder.indexOf(itemId);
    if (idx < 0) return;
    const nextId = visibleOrder[idx + direction];
    if (nextId) setEditingId(nextId);
  };

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus({ preventScroll: true });
    }
  }, [searchOpen]);

  useEffect(() => {
    const onFocus = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (id) setEditingId(id);
    };
    window.addEventListener("codev-note-focus", onFocus);
    return () => window.removeEventListener("codev-note-focus", onFocus);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest?.("[data-note-preview], [data-note-panel]")) return;
      if (!root.current?.contains(target)) {
        if (viewMode === "markdown" && markdownDirty) {
          replaceFromMarkdown(markdownDraft);
          setMarkdownDirty(false);
        }
        setOpen(false);
      }
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        if (editingId) {
          setEditingId(null);
          return;
        }
        if (viewMode === "markdown" && markdownDirty) {
          replaceFromMarkdown(markdownDraft);
          setMarkdownDirty(false);
        }
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, editingId, viewMode, markdownDirty, markdownDraft, replaceFromMarkdown]);

  useEffect(() => {
    const onResize = () => {
      setPosition((current) => clampBubble(current.x, current.y));
      setPanel((current) => clampPanel(current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const switchMode = (nextMode: ViewMode) => {
    if (viewMode === "markdown" && markdownDirty && nextMode !== "markdown") {
      replaceFromMarkdown(markdownDraft);
      setMarkdownDirty(false);
    }
    if (nextMode === "markdown") {
      setMarkdownDraft(notepadToMarkdown({ projects }));
      setMarkdownDirty(false);
    }
    setEditingId(null);
    setViewMode(nextMode);
  };

  const persistPanel = (next: PanelBox) => {
    const box = clampPanel(next);
    setPanel(box);
    uiState.setItem(PANEL_KEY, JSON.stringify(box));
  };

  const startEdgeDrag = (
    edge: Edge,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = panelElement.current?.getBoundingClientRect();
    edgeDrag.current = {
      pointerId: event.pointerId,
      edge,
      origin: bounds
        ? { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height }
        : { ...panel },
      startX: event.clientX,
      startY: event.clientY,
    };
  };
  const onEdgeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = edgeDrag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    persistPanel(
      resizePanel(
        current.origin,
        current.edge,
        event.clientX - current.startX,
        event.clientY - current.startY,
      ),
    );
  };
  const stopEdge = () => {
    edgeDrag.current = null;
  };

  const startPanelDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest("button, input")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = panelElement.current?.getBoundingClientRect();
    panelDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: bounds
        ? { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height }
        : { ...panel },
      moved: false,
    };
  };
  const onPanelMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = panelDrag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    current.moved = true;
    persistPanel({
      ...current.origin,
      x: current.origin.x + dx,
      y: current.origin.y + dy,
    });
  };
  const stopPanelDrag = () => {
    panelDrag.current = null;
  };

  const submitInbox = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const parsed = parsePastedTodoLines(text);
    if (parsed.length > 1) {
      addManyToProject(TMP_PROJECT_ID, parsed);
    } else if (parsed.length === 1) {
      addManyToProject(TMP_PROJECT_ID, parsed);
    } else {
      addInbox(text);
    }
    setDraft("");
  };

  const edgeClass = (cursor: string, extra: string) =>
    `pointer-events-auto absolute z-10 border-0 bg-transparent p-0 ${cursor} ${extra}`;

  return (
    <>
      <div
        ref={root}
        className="pointer-events-none fixed z-[80]"
        style={{ left: position.x, top: position.y }}
      >
        <button
          type="button"
          aria-label="记事本"
          title="记事本"
          aria-expanded={open}
          className="pointer-events-auto relative flex size-7 cursor-grab items-center justify-center rounded-full border border-border/70 bg-popover text-[#7aa8c4] shadow-md hover:text-[#93bbd4] active:cursor-grabbing dark:text-[#8eb6d4] dark:hover:text-[#a6cceb]"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            drag.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              originX: position.x,
              originY: position.y,
              moved: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.pointerId !== event.pointerId) return;
            const dx = event.clientX - current.startX;
            const dy = event.clientY - current.startY;
            if (!current.moved && Math.hypot(dx, dy) < 4) return;
            current.moved = true;
            setPosition(
              clampBubble(current.originX + dx, current.originY + dy),
            );
          }}
          onPointerUp={(event) => {
            const current = drag.current;
            if (!current || current.pointerId !== event.pointerId) return;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            if (current.moved) {
              const next = clampBubble(position.x, position.y);
              setPosition(next);
              uiState.setItem(POSITION_KEY, JSON.stringify(next));
            } else {
              setOpen((value) => !value);
            }
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <HugeiconsIcon icon={CheckListIcon} size={14} />
          {stats.pending > 0 && (
            <span className="absolute -top-1 -right-1 min-w-3 rounded-sm bg-muted px-0.5 text-center text-[9px] leading-3 text-muted-foreground">
              {stats.pending > 99 ? "99+" : stats.pending}
            </span>
          )}
        </button>
      </div>
      {open && (
        <div
          ref={panelElement}
          data-note-panel=""
          className="pointer-events-auto fixed z-[80] flex flex-col rounded-md border border-border bg-popover p-2 shadow-lg"
          style={{
            left: panel.x,
            top: panel.y,
            width: panel.w,
            height: viewMode === "markdown" ? panel.h : undefined,
            maxHeight: panel.h,
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            const target = event.target as Element;
            if (!target.closest("[data-note-item], textarea, input, button"))
              setEditingId(null);
          }}
        >
          <button
            type="button"
            aria-label="向上拉伸"
            className={edgeClass(
              "cursor-ns-resize",
              "top-0 right-2 left-2 h-1.5",
            )}
            onPointerDown={(event) => startEdgeDrag("n", event)}
            onPointerMove={onEdgeMove}
            onPointerUp={stopEdge}
            onPointerCancel={stopEdge}
          />
          <button
            type="button"
            aria-label="向下拉伸"
            className={edgeClass(
              "cursor-ns-resize",
              "right-2 bottom-0 left-2 h-1.5",
            )}
            onPointerDown={(event) => startEdgeDrag("s", event)}
            onPointerMove={onEdgeMove}
            onPointerUp={stopEdge}
            onPointerCancel={stopEdge}
          />
          <button
            type="button"
            aria-label="向左拉伸"
            className={edgeClass(
              "cursor-ew-resize",
              "top-2 bottom-2 left-0 w-1.5",
            )}
            onPointerDown={(event) => startEdgeDrag("w", event)}
            onPointerMove={onEdgeMove}
            onPointerUp={stopEdge}
            onPointerCancel={stopEdge}
          />
          <button
            type="button"
            aria-label="向右拉伸"
            className={edgeClass(
              "cursor-ew-resize",
              "top-2 right-0 bottom-2 w-1.5",
            )}
            onPointerDown={(event) => startEdgeDrag("e", event)}
            onPointerMove={onEdgeMove}
            onPointerUp={stopEdge}
            onPointerCancel={stopEdge}
          />

          <div
            className="flex shrink-0 cursor-grab items-center gap-1 border-b border-border/50 pb-1.5 active:cursor-grabbing"
            onPointerDown={startPanelDrag}
            onPointerMove={onPanelMove}
            onPointerUp={stopPanelDrag}
            onPointerCancel={stopPanelDrag}
          >
            <span className="truncate px-1 text-[11.5px] font-semibold">
              记事本
            </span>
            <span
              className="rounded bg-muted/80 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground"
              title={`待办 ${stats.pending} · 已完成 ${stats.done} · 总计 ${stats.total}`}
            >
              待办 {stats.pending} / {stats.total}
            </span>
            <div className="min-w-0 flex-1" />

            <Button
              type="button"
              variant={viewMode === "todo" ? "secondary" : "ghost"}
              size="xs"
              className="h-5 px-1.5 text-[10px]"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => switchMode("todo")}
            >
              清单
            </Button>
            <Button
              type="button"
              variant={viewMode === "markdown" ? "secondary" : "ghost"}
              size="xs"
              className="h-5 gap-0.5 px-1.5 text-[10px]"
              title="切换 Markdown 源码模式"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => switchMode("markdown")}
            >
              <HugeiconsIcon icon={File01Icon} size={10} />
              MD
            </Button>
            <Button
              type="button"
              variant={viewMode === "trash" ? "secondary" : "ghost"}
              size="icon-xs"
              className="relative size-5"
              aria-label="回收站与导入导出"
              title="回收站与导入导出"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => switchMode("trash")}
            >
              <HugeiconsIcon icon={Delete02Icon} size={11} />
              {stats.trash > 0 ? (
                <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-amber-400" />
              ) : null}
            </Button>

            {viewMode === "todo" ? (
              <>
                <Button
                  type="button"
                  variant={searchOpen ? "secondary" : "ghost"}
                  size="icon-xs"
                  className="size-5"
                  aria-label="搜索待办"
                  title="搜索待办"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    setSearchOpen((v) => {
                      if (v) setSearchQuery("");
                      return !v;
                    });
                  }}
                >
                  <HugeiconsIcon icon={Search01Icon} size={11} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-5"
                  aria-label={allCollapsed ? "全部展开" : "全部折叠"}
                  title={allCollapsed ? "全部展开" : "全部折叠"}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setAllCollapsed(!allCollapsed)}
                >
                  <HugeiconsIcon
                    icon={allCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                    size={11}
                  />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-5"
                  aria-label="新增分组"
                  title="新增分组"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => addProject("新分组")}
                >
                  <HugeiconsIcon icon={PlusSignIcon} size={11} />
                </Button>
              </>
            ) : null}

            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-5"
                  aria-label="使用说明"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <HugeiconsIcon icon={HelpCircleIcon} size={11} />
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                align="end"
                className="z-[100] max-w-64 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] leading-relaxed text-popover-foreground shadow-md"
              >
                Enter 新建下一条 · Shift+Enter 换行补充 · 空行 Backspace 删除 ·
                ↑↓ 切换上下条 · 粘贴多行自动拆分 · 删除进入回收站可撤销
              </TooltipContent>
            </Tooltip>
          </div>

          {viewMode === "todo" ? (
            <>
              {searchOpen ? (
                <div className="mt-1.5 flex shrink-0 items-center gap-1 rounded border border-border/70 bg-background/40 px-1.5 py-0.5">
                  <HugeiconsIcon
                    icon={Search01Icon}
                    size={11}
                    className="shrink-0 text-muted-foreground"
                  />
                  <input
                    ref={searchInputRef}
                    value={searchQuery}
                    placeholder="筛选分组、待办或 #标签…"
                    className="h-5 min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/70"
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery ? (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setSearchQuery("")}
                    >
                      <HugeiconsIcon icon={Cancel01Icon} size={10} />
                    </button>
                  ) : null}
                </div>
              ) : null}

              <div
                className="reader-scrollbar mt-1 min-h-0 flex-1 overflow-auto pr-0.5"
                data-note-projects=""
              >
                {activeProjects.map((project, index) => (
                  <ProjectBlock
                    key={project.id}
                    project={project}
                    index={index}
                    searchQuery={searchQuery}
                    editingId={editingId}
                    onEdit={setEditingId}
                    onNavigate={navigateItem}
                  />
                ))}
              </div>

              <form
                className="mt-1.5 shrink-0 border-t border-border/60 pt-1.5"
                onSubmit={submitInbox}
              >
                <div className="flex min-h-[24px] items-center rounded bg-background/35 px-1.5">
                  <NoteInput
                    singleLine
                    value={draft}
                    placeholder="速记到 tmp（Enter 提交，支持粘贴多行 - [ ] 清单）"
                    onChange={setDraft}
                    onSubmit={() => submitInbox()}
                    onMultiPaste={(entries) => {
                      addManyToProject(TMP_PROJECT_ID, entries);
                      setDraft("");
                      toast.success(`已添加 ${entries.length} 条待办到 tmp`);
                    }}
                  />
                </div>
              </form>
            </>
          ) : viewMode === "markdown" ? (
            <div className="mt-1.5 flex min-h-0 flex-1 flex-col gap-1.5">
              <textarea
                value={markdownDraft}
                spellCheck={false}
                placeholder={"## 分组名\n- [ ] 待办事项\n- [x] 已完成事项"}
                className="reader-scrollbar min-h-0 flex-1 resize-none rounded border border-border/70 bg-background/50 p-2 font-mono text-[11.5px] leading-relaxed outline-none"
                onChange={(e) => {
                  setMarkdownDraft(e.target.value);
                  setMarkdownDirty(true);
                }}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                    e.preventDefault();
                    replaceFromMarkdown(markdownDraft);
                    setMarkdownDirty(false);
                    toast.success("已同步 Markdown 变更到数据库");
                  }
                }}
              />
              <div className="flex shrink-0 items-center justify-between gap-1.5">
                <span className="text-[10px] text-muted-foreground">
                  {markdownDirty ? "有未同步修改（切回清单自动保存）" : "已同步 SQLite"}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="h-6 px-2 text-[10.5px]"
                    onClick={() => {
                      void copyToClipboard(markdownDraft);
                      toast.success("已复制 Markdown");
                    }}
                  >
                    复制 MD
                  </Button>
                  <Button
                    type="button"
                    variant="default"
                    size="xs"
                    className="h-6 px-2 text-[10.5px]"
                    onClick={() => {
                      replaceFromMarkdown(markdownDraft);
                      setMarkdownDirty(false);
                      setViewMode("todo");
                      toast.success("已应用 Markdown 更新");
                    }}
                  >
                    应用并切回
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-1.5 flex min-h-0 flex-1 flex-col">
              <NoteTrashView />
            </div>
          )}
        </div>
      )}
    </>
  );
}
