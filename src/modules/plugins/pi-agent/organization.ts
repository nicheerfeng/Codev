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

/** 标准化平台路径，用于项目分组与原生会话匹配。 */
export function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
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
