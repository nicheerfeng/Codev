import type { PiSessionSummary } from "./types";

export type PiOrganization = {
  groups: { id: string; name: string }[];
  projectGroups: Record<string, string>;
  archived: string[];
};
export const EMPTY_ORGANIZATION: PiOrganization = {
  groups: [],
  projectGroups: {},
  archived: [],
};

/** 标准化平台路径，去掉 Windows \\?\ 前缀后再比较。 */
export function pathKey(path: string): string {
  let normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^\/\/[?.]\//.test(normalized)) normalized = normalized.slice(4);
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

/** 归档比对用稳定键，避免重启后路径大小写或 \?\ 前缀对不上。 */
export function isArchivedPath(path: string, archived: string[]): boolean {
  if (!path) return false;
  const key = pathKey(path);
  return archived.some((item) => pathKey(item) === key);
}

/** 把归档列表收成 pathKey，写入或恢复时去重。 */
export function withArchivedPath(
  archived: string[],
  path: string,
  value: boolean,
): string[] {
  const next = [
    ...new Set(archived.map(pathKey).filter((item) => item.length > 0)),
  ];
  const key = pathKey(path);
  if (!key) return next;
  if (value) return next.includes(key) ? next : [...next, key];
  return next.filter((item) => item !== key);
}

/** 读取损坏或旧格式的组织信息时，组和归档都按稳定键收口。 */
export function normalizeOrganization(value: unknown): PiOrganization {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<PiOrganization>)
      : {};
  const groups = Array.isArray(raw.groups)
    ? raw.groups.flatMap((group) => {
        if (!group || typeof group !== "object") return [];
        const id = typeof group.id === "string" ? group.id.trim() : "";
        const name = typeof group.name === "string" ? group.name.trim() : "";
        return id ? [{ id, name: name || id }] : [];
      })
    : [];
  const projectGroups =
    raw.projectGroups &&
    typeof raw.projectGroups === "object" &&
    !Array.isArray(raw.projectGroups)
      ? Object.fromEntries(
          Object.entries(raw.projectGroups).flatMap(([cwd, groupId]) => {
            const key = pathKey(cwd);
            return key && typeof groupId === "string" ? [[key, groupId]] : [];
          }),
        )
      : {};
  const archived = Array.isArray(raw.archived)
    ? withArchivedPath(
        raw.archived.filter((item): item is string => typeof item === "string"),
        "",
        false,
      )
    : [];
  return { groups, projectGroups, archived };
}

/** 侧栏排序和高亮用的稳定 id：有会话文件用路径，空草稿用内存键。 */
export function sessionIdentity(path: string, key: string): string {
  return path ? pathKey(path) : key;
}

/** 每次新建线程使用独立草稿键，避免同一项目复用上一次对话。 */
export function nextDraftKey(path: string): string {
  return `draft:${pathKey(path)}:${crypto.randomUUID()}`;
}

/** 使用路径的最后一级作为默认项目标题。 */
export function projectName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}

export const TEMPORARY_GROUP_ID = "temporary";

/** 临时聊天固定使用 Pi 主目录，不进入普通项目列表。 */
export function isTemporaryCwd(
  cwd: string,
  home: string | null | undefined,
): boolean {
  return !!home && pathKey(cwd) === pathKey(home);
}

/** 普通项目列表排除 Pi 主目录。 */
export function visiblePiProjects(
  projects: string[],
  home: string | null | undefined,
): string[] {
  return projects.filter((path) => !isTemporaryCwd(path, home));
}

/** 首次进入时把组和项目都收起。 */
export function defaultPiCollapsedKeys(
  projects: string[],
  groups: { id: string }[],
  home: string | null | undefined,
): string[] {
  const keys = [`group:`, `group:${TEMPORARY_GROUP_ID}`];
  for (const group of groups) keys.push(`group:${group.id}`);
  for (const path of visiblePiProjects(projects, home))
    keys.push(`project:${pathKey(path)}`);
  return keys;
}

/** 合并自动发现和手动添加项目，空项目也可展示。 */
export function collectProjects(
  paths: string[],
  sessions: PiSessionSummary[],
  hidden: string[],
): string[] {
  const excluded = new Set(hidden.map(pathKey));
  const result = new Map<string, string>();
  for (const path of [...paths, ...sessions.map((item) => item.cwd)]) {
    if (path && !excluded.has(pathKey(path)))
      result.set(pathKey(path), path.replace(/\\/g, "/"));
  }
  return [...result.values()];
}
