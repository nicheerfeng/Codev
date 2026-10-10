import { useEffect, useRef, useState } from "react";
import {
  Cancel01Icon,
  CheckListIcon,
  DragDropVerticalIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { uiState } from "@/lib/uiState";
import { useNotePad } from "./store";
import { useNoteItemReorder, useNoteReorder } from "./useNoteReorder";
import type { NoteItem, NoteListId } from "./types";

function NoteRow({
  item,
  index,
  listId,
  focus,
}: {
  item: NoteItem;
  index: number;
  listId: NoteListId;
  focus?: boolean;
}) {
  const moveNoteItem = useNotePad((state) => state.moveNoteItem);
  const handle = useNoteItemReorder(listId, moveNoteItem);
  const setItemText = useNotePad((state) => state.setItemText);
  const toggleItem = useNotePad((state) => state.toggleItem);
  const removeItem = useNotePad((state) => state.removeItem);
  const insertAfter = useNotePad((state) => state.insertAfter);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);
  return (
    <div
      data-note-item=""
      className="group flex h-7 min-w-0 items-center gap-1 rounded-sm px-1 hover:bg-muted/50"
    >
      <button
        type="button"
        aria-label="拖拽排序"
        title="拖拽排序"
        className="flex size-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/70 hover:text-foreground"
        {...handle(index)}
      >
        <HugeiconsIcon icon={DragDropVerticalIcon} size={12} />
      </button>
      <button
        type="button"
        aria-label={item.done ? "标记未完成" : "标记完成"}
        className={`flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border ${item.done ? "border-muted-foreground/70" : "border-muted-foreground/40"}`}
        onClick={() => toggleItem(item.id)}
      >
        {item.done && (
          <span className="block size-1.5 rounded-[1px] bg-muted-foreground/80" />
        )}
      </button>
      <input
        ref={input}
        value={item.text}
        aria-label="待办内容"
        placeholder="待办"
        className={`h-6 min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/60 ${item.done ? "text-muted-foreground line-through" : "text-foreground"}`}
        onChange={(event) => setItemText(item.id, event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          const next = insertAfter(item.id);
          if (next)
            window.dispatchEvent(
              new CustomEvent("codev-note-focus", { detail: next }),
            );
        }}
      />
      <button
        type="button"
        aria-label="删除待办"
        className="flex size-5 shrink-0 items-center justify-center text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
        onClick={() => removeItem(item.id)}
      >
        <HugeiconsIcon icon={Cancel01Icon} size={11} />
      </button>
    </div>
  );
}

function ProjectBlock({
  id,
  name,
  items,
  index,
  focusId,
  locked,
}: {
  id: string;
  name: string;
  items: NoteItem[];
  index: number;
  focusId: string | null;
  locked?: boolean;
}) {
  const reorderProject = useNotePad((state) => state.reorderProject);
  const handle = useNoteReorder(reorderProject);
  const addProjectItem = useNotePad((state) => state.addProjectItem);
  const renameProject = useNotePad((state) => state.renameProject);
  const removeProject = useNotePad((state) => state.removeProject);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    const title = draft.trim();
    if (title) renameProject(id, title);
    else setDraft(name);
  };
  return (
    <section data-note-project="" className="pt-1">
      <div className="group flex h-7 items-center gap-1 px-1">
        <button
          type="button"
          aria-label="拖拽项目"
          title="拖拽项目"
          className="flex size-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/70 hover:text-foreground"
          {...handle(index)}
        >
          <HugeiconsIcon icon={DragDropVerticalIcon} size={12} />
        </button>
        {locked ? (
          <span className="h-6 min-w-0 flex-1 truncate text-[11px] font-medium leading-6">
            {name}
          </span>
        ) : (
          <input
            value={draft}
            aria-label="项目名"
            className="h-6 min-w-0 flex-1 bg-transparent text-[11px] font-medium outline-none"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                setDraft(name);
                event.currentTarget.blur();
              }
            }}
          />
        )}
        <button
          type="button"
          aria-label="新增项目待办"
          className="flex size-5 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={() => {
            const next = addProjectItem(id);
            if (next)
              window.dispatchEvent(
                new CustomEvent("codev-note-focus", { detail: next }),
              );
          }}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={11} />
        </button>
        {!locked && (
          <button
            type="button"
            aria-label="删除项目"
            className="flex size-5 items-center justify-center text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
            onClick={() => removeProject(id)}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={11} />
          </button>
        )}
      </div>
      <div data-note-list={id} className="pl-4">
        {items.map((item, itemIndex) => (
          <NoteRow
            key={item.id}
            item={item}
            index={itemIndex}
            listId={id}
            focus={focusId === item.id}
          />
        ))}
      </div>
    </section>
  );
}

const BUBBLE = 28;
const POSITION_KEY = "codev.notepad.bubble";

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

export function NotepadPopover() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [position, setPosition] = useState(readBubble);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const load = useNotePad((state) => state.load);
  const projects = useNotePad((state) => state.projects);
  const addInbox = useNotePad((state) => state.addInbox);
  const addProject = useNotePad((state) => state.addProject);
  const remaining = projects.reduce(
    (sum, project) => sum + project.items.filter((item) => !item.done).length,
    0,
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const onFocus = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (id) setFocusId(id);
    };
    window.addEventListener("codev-note-focus", onFocus);
    return () => window.removeEventListener("codev-note-focus", onFocus);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(() => {
    const onResize = () =>
      setPosition((current) => clampBubble(current.x, current.y));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
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
        className="pointer-events-auto relative flex size-7 cursor-grab items-center justify-center rounded-full border border-border/70 bg-popover text-muted-foreground shadow-md hover:text-foreground active:cursor-grabbing"
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
          setPosition(clampBubble(current.originX + dx, current.originY + dy));
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
        {remaining > 0 && (
          <span className="absolute -top-1 -right-1 min-w-3 rounded-sm bg-muted px-0.5 text-center text-[9px] leading-3 text-muted-foreground">
            {remaining > 99 ? "99+" : remaining}
          </span>
        )}
      </button>
      {open && (
        <div className="pointer-events-auto absolute top-9 right-0 z-40 w-72 rounded-md border border-border bg-popover p-2 shadow-md">
          <div className="flex items-center gap-1 pb-1.5">
            <span className="min-w-0 flex-1 truncate px-1 text-[11px] font-medium">
              记事本
            </span>
            <span className="text-[10px] text-muted-foreground">
              {remaining}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-6"
              aria-label="新增项目"
              title="新增项目"
              onClick={() => addProject("新项目")}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={12} />
            </Button>
          </div>
          <div
            className="reader-scrollbar max-h-80 overflow-auto"
            data-note-projects=""
          >
            {projects.map((project, index) => (
              <ProjectBlock
                key={project.id}
                id={project.id}
                name={project.name}
                items={project.items}
                index={index}
                focusId={focusId}
                locked={project.locked}
              />
            ))}
          </div>
          <form
            className="mt-1.5 flex items-center gap-1 border-t border-border/60 pt-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              const text = draft.trim();
              if (!text) return;
              addInbox(text);
              setDraft("");
            }}
          >
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="添加一次性待办"
              className="h-6 rounded-md px-2 text-[11px]! focus-visible:ring-0"
            />
          </form>
        </div>
      )}
    </div>
  );
}
