import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import type { PiImage } from "./types";

export type PiPathAttachment = {
  kind: "file" | "dir";
  path: string;
  name: string;
};

export type PiDraft = {
  text: string;
  images: PiImage[];
  files: PiPathAttachment[];
};

export const EMPTY_DRAFT: PiDraft = { text: "", images: [], files: [] };

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
  "avif",
]);

/** 用路径最后一段做芯片标题。 */
export function attachmentName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || normalized;
}

/** 图片仍走 Pi 原生 images，其余扩展名一律当路径芯片。 */
export function isImagePath(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(extension);
}

/** 把本地图片读成 Pi 原生 image part。 */
export async function readPathImage(path: string): Promise<PiImage> {
  const bytes = await invoke<number[]>("fs_read_asset_bytes", {
    path,
    workspace: currentWorkspaceEnv(),
  });
  const data = new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < data.length; index += 8192) {
    binary += String.fromCharCode(...data.subarray(index, index + 8192));
  }
  const extension = path.split(".").pop()?.toLowerCase() ?? "png";
  const mime =
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
      svg: "image/svg+xml",
      ico: "image/x-icon",
      avif: "image/avif",
    }[extension] ?? "image/png";
  return { type: "image", data: btoa(binary), mimeType: mime };
}

/** 把绝对路径收成草稿芯片，同路径去重。 */
export function addPathAttachments(
  files: PiPathAttachment[],
  paths: Array<{ path: string; kind: "file" | "dir" }>,
): PiPathAttachment[] {
  const next = [...files];
  const seen = new Set(
    next.map((item) => item.path.replace(/\\/g, "/").toLowerCase()),
  );
  for (const item of paths) {
    const path = item.path.replace(/\\/g, "/");
    const key = path.toLowerCase();
    if (!path || seen.has(key)) continue;
    seen.add(key);
    next.push({ kind: item.kind, path, name: attachmentName(path) });
  }
  return next;
}

/** 草稿是否还能发送：有正文、图片或路径芯片即可。 */
export function draftHasPayload(draft: {
  text: string;
  images: PiImage[];
  files?: PiPathAttachment[];
}): boolean {
  return Boolean(
    draft.text.trim() || draft.images.length || (draft.files?.length ?? 0),
  );
}

const ATTACHMENT_LINE = /^- 关联(文件|目录)[ \t]+(.+?)\s*$/;

/** 发送前只追加短关联行，界面再收成路径标签。 */
export function withAttachmentPrompt(
  text: string,
  files: PiPathAttachment[] | undefined,
): string {
  const items = files ?? [];
  const trimmed = text.replace(/\s+$/u, "");
  if (!items.length) return trimmed;
  const lines = items.map((item) =>
    item.kind === "dir" ? `- 关联目录 ${item.path}` : `- 关联文件 ${item.path}`,
  );
  return trimmed ? `${trimmed}\n\n${lines.join("\n")}` : lines.join("\n");
}

/** 把用户消息拆成正文和关联路径，供气泡标签渲染。 */
export function splitUserAttachmentText(text: string): {
  body: string;
  attachments: PiPathAttachment[];
} {
  const lines = text.replace(/\s+$/u, "").split(/\r?\n/);
  const attachments: PiPathAttachment[] = [];
  while (lines.length) {
    const line = lines[lines.length - 1] ?? "";
    const match = line.match(ATTACHMENT_LINE);
    if (!match) break;
    lines.pop();
    const path = (match[2] ?? "").trim();
    if (!path) continue;
    attachments.unshift({
      kind: match[1] === "目录" ? "dir" : "file",
      path,
      name: attachmentName(path),
    });
  }
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
  return { body: lines.join("\n"), attachments };
}
