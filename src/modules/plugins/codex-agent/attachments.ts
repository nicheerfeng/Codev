import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import type { CodexClient } from "./client";

/** 按原生支持的图片格式提供本地预览，其余保留路径。 */
export function isImagePath(path: string) {
  return /\.(png|jpe?g|gif|webp)$/i.test(path);
}
/** 固定目标线程后读取附件，完成时合并最新草稿。 */
export async function ingestPaths(
  client: CodexClient,
  id: string,
  items: Array<{ path: string; kind: "file" | "dir" }>,
) {
  const session = client.getSnapshot().sessions[id];
  if (!session) return;
  const paths = items.map((item) => ({
    ...item,
    path: item.path.replace(/\\/g, "/"),
  }));
  const images: string[] = [];
  const files: typeof paths = [];
  for (const item of paths) {
    if (item.kind === "file" && isImagePath(item.path)) {
      const bytes = await invoke<number[]>("fs_read_asset_bytes", {
        path: item.path,
        workspace: currentWorkspaceEnv(),
      });
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.slice(i, i + 8192));
      const extension = item.path
        .split(".")
        .pop()!
        .toLowerCase()
        .replace("jpg", "jpeg");
      images.push(`data:image/${extension};base64,${btoa(binary)}`);
    } else files.push(item);
  }
  const current = client.getSnapshot().sessions[id];
  if (!current) return;
  client.patch(id, {
    images: [...current.images, ...images],
    attachments: [
      ...new Set([...current.attachments, ...files.map((item) => item.path)]),
    ],
    directories: [
      ...new Set([
        ...current.directories,
        ...files.filter((item) => item.kind === "dir").map((item) => item.path),
      ]),
    ],
    focusRevision: current.focusRevision + 1,
  });
}
