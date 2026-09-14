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
