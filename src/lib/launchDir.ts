import { invoke } from "@tauri-apps/api/core";

let cached: string | undefined;
let explicitCached: string | undefined;

export type OpenTargetPayload = {
  dir: string | null;
  files: string[];
};

export async function initLaunchDir(): Promise<void> {
  const explicit = await invoke<string | null>("get_launch_dir").catch(
    () => null,
  );
  explicitCached = explicit ? explicit.replace(/\\/g, "/") : undefined;
  const dir =
    explicit ??
    (await invoke<string>("workspace_current_dir").catch(() => null));
  cached = dir ? dir.replace(/\\/g, "/") : undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}

/** 返回首次启动时由外部路径显式传入的目录，不包含默认工作目录。 */
export function getExplicitLaunchDir(): string | undefined {
  return explicitCached;
}

/** 读取单实例转发期间暂存的外部打开请求。 */
export async function consumePendingOpenTargets(): Promise<
  OpenTargetPayload[]
> {
  return invoke<OpenTargetPayload[]>("get_pending_open_targets").catch(
    () => [],
  );
}

/**
 * Drains the files passed via the OS "Open With" action (CLI args on
 * Linux/Windows, macOS open-files event). Drained once so HMR / re-mounts
 * can't replay them. Returns [] when the app wasn't launched with a file.
 */
export async function consumeLaunchFiles(): Promise<string[]> {
  const files = await invoke<string[]>("get_launch_files").catch(() => []);
  return files.map((f) => f.replace(/\\/g, "/"));
}
