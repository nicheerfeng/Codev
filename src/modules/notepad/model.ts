import type { NoteItem, NoteListId, NotePad, NoteProject } from "./types";

export const emptyNotePad = (): NotePad => ({ projects: [] });

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function asOptionalTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function readItem(value: unknown): NoteItem | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || typeof row.text !== "string")
    return null;
  const now = Date.now();
  return {
    id: row.id,
    text: row.text,
    done: row.done === true,
    createdAt: asTimestamp(row.createdAt) ?? now,
    updatedAt: asTimestamp(row.updatedAt) ?? now,
    doneAt: asOptionalTimestamp(row.doneAt),
    deletedAt: asOptionalTimestamp(row.deletedAt),
  };
}

function readProject(value: unknown): NoteProject | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || typeof row.name !== "string")
    return null;
  const now = Date.now();
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
    collapsed: row.collapsed === true,
    doneCollapsed: row.doneCollapsed !== false,
    createdAt: asTimestamp(row.createdAt) ?? now,
    updatedAt: asTimestamp(row.updatedAt) ?? now,
    deletedAt: row.id === "tmp" ? null : asOptionalTimestamp(row.deletedAt),
  };
}

function tmpProject(items: NoteItem[] = []): NoteProject {
  const now = Date.now();
  return {
    id: "tmp",
    name: "tmp",
    items,
    locked: true,
    collapsed: false,
    doneCollapsed: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
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
            deletedAt: null,
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

export function createItem(text = "", done = false): NoteItem {
  const now = Date.now();
  return {
    id: createId(),
    text,
    done,
    createdAt: now,
    updatedAt: now,
    doneAt: done ? now : null,
    deletedAt: null,
  };
}

export function createProject(name: string): NoteProject {
  const now = Date.now();
  return {
    id: createId(),
    name,
    items: [],
    collapsed: false,
    doneCollapsed: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export function isActiveProject(project: NoteProject): boolean {
  return !project.deletedAt;
}

export function isActiveItem(item: NoteItem): boolean {
  return !item.deletedAt;
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
      project.id === listId
        ? { ...project, items, updatedAt: Date.now() }
        : project,
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
  if (from < 0 || from >= source.length) return pad;
  if (fromList === toList) {
    return withList(pad, fromList, moveItem(source, from, to));
  }
  const nextSource = [...source];
  const [item] = nextSource.splice(from, 1);
  const target = [...listOf(pad, toList)];
  const index = Math.max(0, Math.min(to, target.length));
  target.splice(index, 0, { ...item, updatedAt: Date.now() });
  return withList(withList(pad, fromList, nextSource), toList, target);
}

/** 在指定项目内按 itemId 移动（仅在未软删除待办中重排或跨项目迁移）。 */
export function moveNoteById(
  pad: NotePad,
  itemId: string,
  toProjectId: string,
  targetIndex: number,
): NotePad {
  let moving: NoteItem | null = null;
  let fromProjectId: string | null = null;
  for (const project of pad.projects) {
    const found = project.items.find((item) => item.id === itemId);
    if (found) {
      moving = found;
      fromProjectId = project.id;
      break;
    }
  }
  if (!moving || !fromProjectId) return pad;

  const stripped = pad.projects.map((project) =>
    project.id === fromProjectId
      ? {
          ...project,
          items: project.items.filter((item) => item.id !== itemId),
          updatedAt: Date.now(),
        }
      : project,
  );

  return {
    projects: stripped.map((project) => {
      if (project.id !== toProjectId) return project;
      const active = project.items.filter(isActiveItem);
      const deleted = project.items.filter((item) => !isActiveItem(item));
      const clamped = Math.max(0, Math.min(targetIndex, active.length));
      active.splice(clamped, 0, { ...moving!, updatedAt: Date.now() });
      return {
        ...project,
        items: [...active, ...deleted],
        updatedAt: Date.now(),
      };
    }),
  };
}

/** 将结构化待办导出为标准 Markdown 文档（仅导出未软删除内容）。 */
export function notepadToMarkdown(pad: NotePad): string {
  const sections: string[] = [];
  for (const project of pad.projects) {
    if (!isActiveProject(project)) continue;
    const lines: string[] = [`## ${project.name}`];
    for (const item of project.items) {
      if (!isActiveItem(item)) continue;
      const marker = item.done ? "- [x] " : "- [ ] ";
      const rawLines = item.text.replace(/\r\n/g, "\n").split("\n");
      lines.push(`${marker}${rawLines[0] ?? ""}`);
      for (const extra of rawLines.slice(1)) {
        lines.push(`  ${extra}`);
      }
    }
    sections.push(lines.join("\n"));
  }
  return `${sections.join("\n\n")}\n`;
}

/** 解析单个项目的粘贴多行文本为待办列表，自动识别 `- [ ]` / `- [x]` / `- ` / `* ` 前缀。 */
export function parsePastedTodoLines(
  raw: string,
): Array<{ text: string; done: boolean }> {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: Array<{ text: string; done: boolean }> = [];
  for (const line of lines) {
    const taskMatch = line.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/);
    if (taskMatch) {
      out.push({
        done: taskMatch[1].toLowerCase() === "x",
        text: taskMatch[2].trimEnd(),
      });
      continue;
    }
    const bulletMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bulletMatch) {
      out.push({ done: false, text: bulletMatch[1].trimEnd() });
      continue;
    }
    if (/^\s{2,}\S/.test(line) && out.length > 0) {
      out[out.length - 1] = {
        ...out[out.length - 1],
        text: `${out[out.length - 1].text}\n${line.trim()}`,
      };
      continue;
    }
    const trimmed = line.trim();
    if (trimmed) {
      out.push({ done: false, text: trimmed });
    }
  }
  return out;
}

/** 将标准 Markdown 源码解析并合并回当前 NotePad（保留已有项目/待办 ID 与软删除记录）。 */
export function markdownToNotePad(markdown: string, current: NotePad): NotePad {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const parsed: Array<{
    name: string;
    items: Array<{ text: string; done: boolean }>;
  }> = [];

  let activeSection: {
    name: string;
    items: Array<{ text: string; done: boolean }>;
  } | null = null;

  const ensureSection = () => {
    if (!activeSection) {
      activeSection = { name: "tmp", items: [] };
      parsed.push(activeSection);
    }
    return activeSection;
  };

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (heading) {
      activeSection = { name: heading[1].trim(), items: [] };
      parsed.push(activeSection);
      continue;
    }
    const taskMatch = line.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/);
    if (taskMatch) {
      ensureSection().items.push({
        done: taskMatch[1].toLowerCase() === "x",
        text: taskMatch[2].trimEnd(),
      });
      continue;
    }
    const bulletMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bulletMatch) {
      ensureSection().items.push({
        done: false,
        text: bulletMatch[1].trimEnd(),
      });
      continue;
    }
    if (
      /^\s{2,}/.test(line) &&
      activeSection &&
      activeSection.items.length > 0
    ) {
      const last = activeSection.items[activeSection.items.length - 1];
      last.text = `${last.text}\n${line.slice(2)}`;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed) {
      ensureSection().items.push({ done: false, text: trimmed });
    }
  }

  const now = Date.now();
  const deletedProjects = current.projects.filter((p) => !isActiveProject(p));
  const usedProjectIds = new Set<string>();
  const nextActiveProjects: NoteProject[] = [];

  for (const section of parsed) {
    const isTmp = section.name.toLowerCase() === "tmp";
    const matchedProject = current.projects.find(
      (p) =>
        isActiveProject(p) &&
        !usedProjectIds.has(p.id) &&
        (isTmp
          ? p.id === "tmp"
          : p.name.trim().toLowerCase() === section.name.toLowerCase()),
    );
    if (matchedProject) usedProjectIds.add(matchedProject.id);

    const existingActiveItems = matchedProject
      ? matchedProject.items.filter(isActiveItem)
      : [];
    const existingDeletedItems = matchedProject
      ? matchedProject.items.filter((i) => !isActiveItem(i))
      : [];
    const usedItemIds = new Set<string>();

    const nextItems: NoteItem[] = section.items.map((entry) => {
      const matchedItem = existingActiveItems.find(
        (item) => !usedItemIds.has(item.id) && item.text === entry.text,
      );
      if (matchedItem) {
        usedItemIds.add(matchedItem.id);
        return {
          ...matchedItem,
          done: entry.done,
          doneAt: entry.done ? (matchedItem.doneAt ?? now) : null,
          updatedAt:
            matchedItem.done !== entry.done
              ? now
              : (matchedItem.updatedAt ?? now),
        };
      }
      return createItem(entry.text, entry.done);
    });

    // Any previously active item removed in Markdown view becomes soft-deleted.
    const removedInMd = existingActiveItems
      .filter((item) => !usedItemIds.has(item.id))
      .map((item) => ({ ...item, deletedAt: now, updatedAt: now }));

    if (matchedProject) {
      nextActiveProjects.push({
        ...matchedProject,
        name: isTmp ? "tmp" : section.name,
        locked: isTmp || matchedProject.locked,
        updatedAt: now,
        items: [...nextItems, ...existingDeletedItems, ...removedInMd],
      });
    } else {
      const created = isTmp ? tmpProject([]) : createProject(section.name);
      nextActiveProjects.push({
        ...created,
        items: nextItems,
      });
    }
  }

  // Projects deleted in Markdown view are also soft-deleted (except locked tmp).
  const removedProjects = current.projects
    .filter((p) => isActiveProject(p) && !usedProjectIds.has(p.id) && !p.locked)
    .map((p) => ({ ...p, deletedAt: now, updatedAt: now }));

  const hasTmp = nextActiveProjects.some((p) => p.id === "tmp");
  const normalizedProjects = hasTmp
    ? [
        ...nextActiveProjects.filter((p) => p.id === "tmp"),
        ...nextActiveProjects.filter((p) => p.id !== "tmp"),
      ]
    : [tmpProject([]), ...nextActiveProjects];

  return {
    projects: [...normalizedProjects, ...removedProjects, ...deletedProjects],
  };
}
