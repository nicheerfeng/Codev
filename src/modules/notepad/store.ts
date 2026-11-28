import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import {
  createItem,
  createProject,
  emptyNotePad,
  isActiveItem,
  isActiveProject,
  markdownToNotePad,
  moveItem,
  moveNote,
  moveNoteById,
  normalizeNotePad,
} from "./model";
import {
  TMP_PROJECT_ID,
  type NoteItem,
  type NoteListId,
  type NotePad,
} from "./types";

const STORE_PATH = "codev-notepad.json";
const DATA_KEY = "notepad";
const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: false });
let writes = Promise.resolve();

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(
      (window as unknown as { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__,
    )
  );
}

function persist(pad: NotePad) {
  writes = writes
    .then(async () => {
      if (isTauriRuntime()) {
        try {
          await invoke("app_db_notepad_save", { pad });
          return;
        } catch (error) {
          console.warn("SQLite 保存记事本失败，回落到文件存储", error);
        }
      }
      await store.set(DATA_KEY, pad);
      await store.save();
    })
    .catch((error) => console.error("保存记事本失败", error));
}

type NotePadState = NotePad & {
  ready: boolean;
  load: () => Promise<void>;
  addInbox: (text?: string) => string | null;
  addProject: (name: string) => string | null;
  addProjectItem: (
    projectId: string,
    text?: string,
    done?: boolean,
  ) => string | null;
  insertAfter: (itemId: string, text?: string) => string | null;
  insertManyAfter: (
    itemId: string,
    entries: Array<{ text: string; done: boolean }>,
  ) => string | null;
  addManyToProject: (
    projectId: string,
    entries: Array<{ text: string; done: boolean }>,
  ) => string | null;
  setItemText: (itemId: string, text: string) => void;
  toggleItem: (itemId: string) => void;
  removeItem: (itemId: string) => void;
  restoreItem: (itemId: string) => void;
  purgeItem: (itemId: string) => void;
  renameProject: (projectId: string, name: string) => void;
  removeProject: (projectId: string) => void;
  restoreProject: (projectId: string) => void;
  purgeProject: (projectId: string) => void;
  emptyTrash: () => void;
  toggleProjectCollapsed: (projectId: string) => void;
  toggleDoneCollapsed: (projectId: string) => void;
  setAllCollapsed: (collapsed: boolean) => void;
  replaceFromMarkdown: (markdown: string) => void;
  importJsonPad: (raw: unknown) => { projectsAdded: number; itemsAdded: number };
  moveNoteItem: (
    fromList: NoteListId,
    from: number,
    toList: NoteListId,
    to: number,
  ) => void;
  moveNoteItemById: (
    itemId: string,
    toProjectId: string,
    targetIndex: number,
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
  update: (item: NoteItem) => NoteItem | null,
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
    if (isTauriRuntime()) {
      try {
        const fromDb = await invoke<{ projects?: unknown[] }>(
          "app_db_notepad_load",
        );
        if (Array.isArray(fromDb?.projects) && fromDb.projects.length > 0) {
          set({ ...normalizeNotePad(fromDb), ready: true });
          return;
        }
        const legacy = await store.get<unknown>(DATA_KEY).catch(() => null);
        if (legacy) {
          const normalized = normalizeNotePad(legacy);
          await invoke("app_db_notepad_save", { pad: normalized });
          set({ ...normalized, ready: true });
          return;
        }
        set({ ...normalizeNotePad(fromDb), ready: true });
        return;
      } catch (error) {
        console.warn("SQLite 读取记事本失败，回落到文件存储", error);
      }
    }
    const saved = await store.get<unknown>(DATA_KEY);
    set({ ...normalizeNotePad(saved), ready: true });
  },

  addInbox: (text = "") => {
    const item = createItem(text);
    patch(set, get, (pad) => ({
      projects: pad.projects.map((project) =>
        project.id === TMP_PROJECT_ID
          ? {
              ...project,
              collapsed: false,
              items: [...project.items, item],
              updatedAt: Date.now(),
            }
          : project,
      ),
    }));
    return item.id;
  },

  addProject: (name) => {
    const title = name.trim();
    if (!title) return null;
    const project = createProject(title);
    patch(set, get, (pad) => ({
      projects: [...pad.projects, project],
    }));
    return project.id;
  },

  addProjectItem: (projectId, text = "", done = false) => {
    const item = createItem(text, done);
    let placed = false;
    patch(set, get, (pad) => ({
      projects: pad.projects.map((project) => {
        if (project.id !== projectId) return project;
        placed = true;
        return {
          ...project,
          collapsed: false,
          items: [...project.items, item],
          updatedAt: Date.now(),
        };
      }),
    }));
    return placed ? item.id : null;
  },

  insertAfter: (itemId, text = "") => {
    const item = createItem(text);
    let placed = false;
    patch(set, get, (pad) => ({
      projects: pad.projects.map((project) => {
        const index = project.items.findIndex((row) => row.id === itemId);
        if (index < 0) return project;
        placed = true;
        const items = [...project.items];
        items.splice(index + 1, 0, item);
        return { ...project, items, updatedAt: Date.now() };
      }),
    }));
    return placed ? item.id : null;
  },

  insertManyAfter: (itemId, entries) => {
    if (entries.length === 0) return null;
    const created = entries.map((entry) => createItem(entry.text, entry.done));
    let placed = false;
    patch(set, get, (pad) => ({
      projects: pad.projects.map((project) => {
        const index = project.items.findIndex((row) => row.id === itemId);
        if (index < 0) return project;
        placed = true;
        const items = [...project.items];
        items.splice(index + 1, 0, ...created);
        return { ...project, items, updatedAt: Date.now() };
      }),
    }));
    return placed ? created[created.length - 1].id : null;
  },

  addManyToProject: (projectId, entries) => {
    if (entries.length === 0) return null;
    const created = entries.map((entry) => createItem(entry.text, entry.done));
    let placed = false;
    patch(set, get, (pad) => ({
      projects: pad.projects.map((project) => {
        if (project.id !== projectId) return project;
        placed = true;
        return {
          ...project,
          collapsed: false,
          items: [...project.items, ...created],
          updatedAt: Date.now(),
        };
      }),
    }));
    return placed ? created[created.length - 1].id : null;
  },

  setItemText: (itemId, text) =>
    patch(set, get, (pad) =>
      mapItems(pad, itemId, (item) => ({
        ...item,
        text,
        updatedAt: Date.now(),
      })),
    ),

  toggleItem: (itemId) =>
    patch(set, get, (pad) =>
      mapItems(pad, itemId, (item) => {
        const nextDone = !item.done;
        const now = Date.now();
        return {
          ...item,
          done: nextDone,
          doneAt: nextDone ? now : null,
          updatedAt: now,
        };
      }),
    ),

  /** 软删除待办（写入 deletedAt，可在回收站中恢复）。 */
  removeItem: (itemId) =>
    patch(set, get, (pad) =>
      mapItems(pad, itemId, (item) => {
        const now = Date.now();
        return { ...item, deletedAt: now, updatedAt: now };
      }),
    ),

  restoreItem: (itemId) =>
    patch(set, get, (pad) => ({
      projects: pad.projects.map((project) => {
        const hasItem = project.items.some((item) => item.id === itemId);
        if (!hasItem) return project;
        const now = Date.now();
        return {
          ...project,
          deletedAt: null,
          collapsed: false,
          updatedAt: now,
          items: project.items.map((item) =>
            item.id === itemId
              ? { ...item, deletedAt: null, updatedAt: now }
              : item,
          ),
        };
      }),
    })),

  purgeItem: (itemId) =>
    patch(set, get, (pad) => mapItems(pad, itemId, () => null)),

  renameProject: (projectId, name) => {
    const title = name.trim();
    if (!title || projectId === TMP_PROJECT_ID) return;
    patch(set, get, (pad) => ({
      projects: pad.projects.map((project) =>
        project.id === projectId
          ? { ...project, name: title, updatedAt: Date.now() }
          : project,
      ),
    }));
  },

  /** 软删除项目（写入 deletedAt，可在回收站中整组恢复）。 */
  removeProject: (projectId) =>
    patch(set, get, (pad) => {
      const target = pad.projects.find((project) => project.id === projectId);
      if (!target || target.locked) return pad;
      const now = Date.now();
      return {
        projects: pad.projects.map((project) =>
          project.id === projectId
            ? { ...project, deletedAt: now, updatedAt: now }
            : project,
        ),
      };
    }),

  restoreProject: (projectId) =>
    patch(set, get, (pad) => {
      const now = Date.now();
      return {
        projects: pad.projects.map((project) =>
          project.id === projectId
            ? {
                ...project,
                deletedAt: null,
                collapsed: false,
                updatedAt: now,
              }
            : project,
        ),
      };
    }),

  purgeProject: (projectId) =>
    patch(set, get, (pad) => ({
      projects: pad.projects.filter((project) => project.id !== projectId),
    })),

  emptyTrash: () =>
    patch(set, get, (pad) => ({
      projects: pad.projects
        .filter(isActiveProject)
        .map((project) => ({
          ...project,
          items: project.items.filter(isActiveItem),
        })),
    })),

  toggleProjectCollapsed: (projectId) =>
    patch(set, get, (pad) => ({
      projects: pad.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              collapsed: !project.collapsed,
              updatedAt: Date.now(),
            }
          : project,
      ),
    })),

  toggleDoneCollapsed: (projectId) =>
    patch(set, get, (pad) => ({
      projects: pad.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              doneCollapsed: !(project.doneCollapsed !== false),
              updatedAt: Date.now(),
            }
          : project,
      ),
    })),

  setAllCollapsed: (collapsed) =>
    patch(set, get, (pad) => ({
      projects: pad.projects.map((project) =>
        isActiveProject(project)
          ? { ...project, collapsed, updatedAt: Date.now() }
          : project,
      ),
    })),

  replaceFromMarkdown: (markdown) =>
    patch(set, get, (pad) => markdownToNotePad(markdown, pad)),

  importJsonPad: (raw) => {
    const candidate =
      raw && typeof raw === "object" && "notepad" in raw
        ? (raw as { notepad: unknown }).notepad
        : raw;
    const incoming = normalizeNotePad(candidate);
    let projectsAdded = 0;
    let itemsAdded = 0;

    patch(set, get, (pad) => {
      const nextProjects = [...pad.projects];
      for (const inProj of incoming.projects) {
        const existingIdx = nextProjects.findIndex(
          (p) =>
            isActiveProject(p) &&
            (p.id === inProj.id ||
              p.name.trim().toLowerCase() === inProj.name.trim().toLowerCase()),
        );
        if (existingIdx >= 0) {
          const target = nextProjects[existingIdx];
          const existingKeys = new Set(
            target.items
              .filter(isActiveItem)
              .map((i) => i.text.trim().toLowerCase()),
          );
          const toAdd: NoteItem[] = [];
          for (const item of inProj.items) {
            if (!isActiveItem(item)) continue;
            const key = item.text.trim().toLowerCase();
            if (!key || existingKeys.has(key)) continue;
            existingKeys.add(key);
            toAdd.push(createItem(item.text, item.done));
            itemsAdded += 1;
          }
          if (toAdd.length > 0) {
            nextProjects[existingIdx] = {
              ...target,
              items: [...target.items, ...toAdd],
              updatedAt: Date.now(),
            };
          }
        } else {
          const freshItems = inProj.items
            .filter(isActiveItem)
            .map((i) => createItem(i.text, i.done));
          itemsAdded += freshItems.length;
          projectsAdded += 1;
          nextProjects.push({
            ...createProject(inProj.name),
            items: freshItems,
          });
        }
      }
      return { projects: nextProjects };
    });

    return { projectsAdded, itemsAdded };
  },

  moveNoteItem: (fromList, from, toList, to) =>
    patch(set, get, (pad) => moveNote(pad, fromList, from, toList, to)),

  moveNoteItemById: (itemId, toProjectId, targetIndex) =>
    patch(set, get, (pad) =>
      moveNoteById(pad, itemId, toProjectId, targetIndex),
    ),

  reorderProject: (from, to) =>
    patch(set, get, (pad) => {
      const active = pad.projects.filter(isActiveProject);
      const deleted = pad.projects.filter((project) => !isActiveProject(project));
      return {
        projects: [...moveItem(active, from, to), ...deleted],
      };
    }),
}));
