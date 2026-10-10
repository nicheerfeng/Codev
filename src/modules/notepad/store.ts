import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import {
  createItem,
  createProject,
  emptyNotePad,
  moveItem,
  moveNote,
  normalizeNotePad,
} from "./model";
import { TMP_PROJECT_ID, type NoteListId, type NotePad } from "./types";

const STORE_PATH = "codev-notepad.json";
const DATA_KEY = "notepad";
const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: false });
let writes = Promise.resolve();

function persist(pad: NotePad) {
  writes = writes
    .then(async () => {
      await store.set(DATA_KEY, pad);
      await store.save();
    })
    .catch((error) => console.error("保存记事本失败", error));
}

type NotePadState = NotePad & {
  ready: boolean;
  load: () => Promise<void>;
  addInbox: (text?: string) => void;
  addProject: (name: string) => void;
  addProjectItem: (projectId: string, text?: string) => string | null;
  insertAfter: (itemId: string) => string | null;
  setItemText: (itemId: string, text: string) => void;
  toggleItem: (itemId: string) => void;
  removeItem: (itemId: string) => void;
  renameProject: (projectId: string, name: string) => void;
  removeProject: (projectId: string) => void;
  moveNoteItem: (
    fromList: NoteListId,
    from: number,
    toList: NoteListId,
    to: number,
  ) => void;
  reorderProject: (from: number, to: number) => void;
};

function snapshot(state: NotePadState): NotePad {
  return { projects: state.projects };
}

function patch(
  set: (partial: Partial<NotePadState>) => void,
  get: () => NotePadState,
  updater: (pad: NotePad) => NotePad,
) {
  const next = updater(snapshot(get()));
  set(next);
  persist(next);
}

function mapItems(
  pad: NotePad,
  itemId: string,
  update: (
    item: import("./types").NoteItem,
  ) => import("./types").NoteItem | null,
): NotePad {
  return {
    projects: pad.projects.map((project) => ({
      ...project,
      items: project.items.flatMap((item) => {
        if (item.id !== itemId) return [item];
        const next = update(item);
        return next ? [next] : [];
      }),
    })),
  };
}

export const useNotePad = create<NotePadState>((set, get) => ({
  ...emptyNotePad(),
  ready: false,
  load: async () => {
    if (get().ready) return;
    const saved = await store.get<unknown>(DATA_KEY);
    set({ ...normalizeNotePad(saved), ready: true });
  },
  addInbox: (text = "") =>
    patch(set, get, (pad) => ({
      projects: pad.projects.map((project) =>
        project.id === TMP_PROJECT_ID
          ? { ...project, items: [...project.items, createItem(text)] }
          : project,
      ),
    })),
  addProject: (name) => {
    const title = name.trim();
    if (!title) return;
    patch(set, get, (pad) => ({
      projects: [...pad.projects, createProject(title)],
    }));
  },
  addProjectItem: (projectId, text = "") => {
    const item = createItem(text);
    let placed = false;
    patch(set, get, (pad) => ({
      projects: pad.projects.map((project) => {
        if (project.id !== projectId) return project;
        placed = true;
        return { ...project, items: [...project.items, item] };
      }),
    }));
    return placed ? item.id : null;
  },
  insertAfter: (itemId) => {
    const item = createItem();
    let placed = false;
    patch(set, get, (pad) => ({
      projects: pad.projects.map((project) => {
        const index = project.items.findIndex((row) => row.id === itemId);
        if (index < 0) return project;
        placed = true;
        const items = [...project.items];
        items.splice(index + 1, 0, item);
        return { ...project, items };
      }),
    }));
    return placed ? item.id : null;
  },
  setItemText: (itemId, text) =>
    patch(set, get, (pad) =>
      mapItems(pad, itemId, (item) => ({ ...item, text })),
    ),
  toggleItem: (itemId) =>
    patch(set, get, (pad) =>
      mapItems(pad, itemId, (item) => ({ ...item, done: !item.done })),
    ),
  removeItem: (itemId) =>
    patch(set, get, (pad) => mapItems(pad, itemId, () => null)),
  renameProject: (projectId, name) => {
    const title = name.trim();
    if (!title || projectId === TMP_PROJECT_ID) return;
    patch(set, get, (pad) => ({
      projects: pad.projects.map((project) =>
        project.id === projectId ? { ...project, name: title } : project,
      ),
    }));
  },
  removeProject: (projectId) =>
    patch(set, get, (pad) => {
      const target = pad.projects.find((project) => project.id === projectId);
      if (!target || target.locked) return pad;
      return {
        projects: pad.projects.filter((project) => project.id !== projectId),
      };
    }),
  moveNoteItem: (fromList, from, toList, to) =>
    patch(set, get, (pad) => moveNote(pad, fromList, from, toList, to)),
  reorderProject: (from, to) =>
    patch(set, get, (pad) => ({
      projects: moveItem(pad.projects, from, to),
    })),
}));
