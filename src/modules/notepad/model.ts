import type { NoteItem, NoteListId, NotePad, NoteProject } from "./types";

export const emptyNotePad = (): NotePad => ({ projects: [] });

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readItem(value: unknown): NoteItem | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || typeof row.text !== "string")
    return null;
  return { id: row.id, text: row.text, done: row.done === true };
}

function readProject(value: unknown): NoteProject | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || typeof row.name !== "string")
    return null;
  return {
    id: row.id,
    name: row.name,
    items: Array.isArray(row.items)
      ? row.items.flatMap((item) => {
          const next = readItem(item);
          return next ? [next] : [];
        })
      : [],
    locked: row.locked === true || row.id === "tmp",
  };
}

function tmpProject(items: NoteItem[] = []): NoteProject {
  return { id: "tmp", name: "tmp", items, locked: true };
}

/** 忽略损坏字段，保证记事本始终能打开。 */
export function normalizeNotePad(value: unknown): NotePad {
  const row = asRecord(value);
  const inbox = Array.isArray(row?.inbox)
    ? row.inbox.flatMap((item) => {
        const next = readItem(item);
        return next ? [next] : [];
      })
    : [];
  const projects = Array.isArray(row?.projects)
    ? row.projects.flatMap((item) => {
        const next = readProject(item);
        return next ? [next] : [];
      })
    : [];
  const existing = projects.find((project) => project.id === "tmp");
  const others = projects.filter((project) => project.id !== "tmp");
  return {
    projects: [
      existing
        ? {
            ...existing,
            name: "tmp",
            locked: true,
            items: [...existing.items, ...inbox],
          }
        : tmpProject(inbox),
      ...others,
    ],
  };
}

export function createId(): string {
  return crypto.randomUUID();
}

export function createItem(text = ""): NoteItem {
  return { id: createId(), text, done: false };
}

export function createProject(name: string): NoteProject {
  return { id: createId(), name, items: [] };
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= list.length ||
    to >= list.length
  )
    return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function listOf(pad: NotePad, listId: NoteListId): NoteItem[] {
  return pad.projects.find((project) => project.id === listId)?.items ?? [];
}

function withList(
  pad: NotePad,
  listId: NoteListId,
  items: NoteItem[],
): NotePad {
  return {
    projects: pad.projects.map((project) =>
      project.id === listId ? { ...project, items } : project,
    ),
  };
}

/** 待办可在一次性分组和项目之间移动，项目标题拖拽仍走组排序。 */
export function moveNote(
  pad: NotePad,
  fromList: NoteListId,
  from: number,
  toList: NoteListId,
  to: number,
): NotePad {
  const source = listOf(pad, fromList);
  const item = source[from];
  if (!item) return pad;
  if (fromList === toList)
    return withList(pad, fromList, moveItem(source, from, to));
  const removed = source.filter((_, index) => index !== from);
  const target = [...listOf(pad, toList)];
  const insert = Math.max(0, Math.min(to, target.length));
  target.splice(insert, 0, item);
  return withList(withList(pad, fromList, removed), toList, target);
}
