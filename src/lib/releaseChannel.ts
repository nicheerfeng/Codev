import { invoke } from "@tauri-apps/api/core";

export const CODEV_REPO_URL = "https://github.com/nicheerfeng/Codev";
export const CODEV_RELEASES_URL = `${CODEV_REPO_URL}/releases`;
export const PI_REPO_URL = "https://github.com/earendil-works/pi";
export const PI_RELEASES_URL = `${PI_REPO_URL}/releases`;

/** 从探测输出或 GitHub tag 抽出可比较的版本号。 */
export function parseDottedVersion(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const match = value.match(/(\d+(?:\.\d+)+)/);
  return match?.[1] ?? null;
}

/** 按点分段比较版本，缺段视为 0。 */
export function compareDottedVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function updateReleaseStatus(
  installed: string | null,
  latest: string | null,
): string {
  const current = parseDottedVersion(installed);
  if (!latest) return "已读取发行页，但未识别出版本号。";
  if (!current) return `GitHub 最新版本 ${latest}`;
  if (compareDottedVersions(latest, current) > 0)
    return `有更新：${current} → ${latest}`;
  return `已是最新版本 ${current}`;
}

export type LatestRelease = {
  latest: string | null;
  name: string | null;
  publishedAt: string | null;
  notes: string | null;
  releaseUrl: string | null;
};

/** 去掉注释和多余空行，保留发行说明原文。 */
export function formatReleaseNotes(body: string | null | undefined): string {
  if (!body) return "";
  return body
    .replace(/\r\n/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchLatestRelease(
  channel: "codev" | "pi",
): Promise<LatestRelease> {
  const payload = await invoke<{
    latest?: string | null;
    name?: string | null;
    publishedAt?: string | null;
    notes?: string | null;
    releaseUrl?: string | null;
  }>("github_latest_release", { channel });
  return {
    latest: parseDottedVersion(payload.latest) ?? payload.latest ?? null,
    name: payload.name?.trim() || null,
    publishedAt: payload.publishedAt ?? null,
    notes: formatReleaseNotes(payload.notes) || null,
    releaseUrl: payload.releaseUrl ?? null,
  };
}
