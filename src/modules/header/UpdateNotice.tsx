import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { HugeiconsIcon } from "@hugeicons/react";
import { Refresh03Icon } from "@hugeicons/core-free-icons";
import { useT } from "@/lib/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  CODEV_RELEASES_URL,
  compareDottedVersions,
  fetchLatestRelease,
  parseDottedVersion,
  type LatestRelease,
} from "@/lib/releaseChannel";
import { openExternalUrl } from "@/lib/external-link";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function formatPublishedAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/** 主窗口定时检测发行版本，网络失败静默等待下一周期，关闭后忽略在途结果。 */
export function UpdateNotice() {
  const t = useT();
  const enabled = usePreferencesStore((state) => state.autoCheckUpdates);
  const hours = usePreferencesStore((state) => state.updateCheckHours);
  const hydrated = usePreferencesStore((state) => state.hydrated);
  const checking = useRef(false);
  const [update, setUpdate] = useState<{
    current: string;
    release: LatestRelease;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const checkLabel = busy ? t("Checking for updates…") : t("Check for updates");
  /** 手动与自动检查共用请求锁；手动检查只提供行内反馈。 */
  const checkRelease = useCallback(
    async (manual = false, cancelled: () => boolean = () => false) => {
      if (checking.current) return;
      checking.current = true;
      setBusy(true);
      if (manual) setFeedback("");
      try {
        const current = parseDottedVersion(await getVersion());
        const release = await fetchLatestRelease("codev");
        const latest = parseDottedVersion(release.latest);
        if (cancelled()) return;
        const newer =
          current && latest && compareDottedVersions(latest, current) > 0;
        setUpdate(newer ? { current, release: { ...release, latest } } : null);
        if (manual)
          setFeedback(
            newer
              ? ""
              : current && latest
                ? t("Up to date")
                : t("Version not recognized. Try again later."),
          );
      } catch {
        if (manual && !cancelled())
          setFeedback(t("Could not check for updates"));
      } finally {
        checking.current = false;
        setBusy(false);
      }
    },
    [t],
  );
  useEffect(() => {
    if (!hydrated || !enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const interval = Math.min(168, Math.max(1, Number(hours) || 4)) * 3_600_000;
    /** 单次请求完成后安排下次检查，避免慢网络造成并发请求。 */
    const check = async () => {
      await checkRelease(false, () => disposed);
      if (!disposed) timer = setTimeout(() => void check(), interval);
    };
    void check();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [enabled, hours, hydrated, checkRelease]);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(""), 5000);
    return () => clearTimeout(timer);
  }, [feedback]);
  const published = formatPublishedAt(update?.release.publishedAt ?? null);
  const releaseUrl = update?.release.releaseUrl ?? CODEV_RELEASES_URL;
  return (
    <div data-no-drag className="mr-1 flex min-w-0 items-center gap-2">
      {feedback && (
        <span
          role="status"
          className="max-w-44 truncate text-[10px] text-muted-foreground"
        >
          {feedback}
        </span>
      )}
      {update && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="max-w-[30vw] truncate text-[10px] text-[#587765] hover:underline dark:text-[#a2bdaa]"
              onClick={() => void openExternalUrl(releaseUrl).catch(() => {})}
            >
              {t("Update available")}（v{update.current} → v
              {update.release.latest}）
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            className="block w-[min(22rem,calc(100vw-2rem))] max-w-none border border-border bg-popover p-3 text-popover-foreground shadow-md"
          >
            <p className="text-[10px] text-muted-foreground">
              {t("Click to open the GitHub release page")}
            </p>
            <p className="mt-1.5 text-[11px] font-medium">
              {update.release.name || `v${update.release.latest}`}
            </p>
            <p className="mt-1 text-[11px] leading-5">
              {t("Current version")} v{update.current} → {t("Latest version")} v
              {update.release.latest}
            </p>
            {published ? (
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {published}
              </p>
            ) : null}
            <pre className="reader-scrollbar mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-[11px] leading-5 text-muted-foreground">
              {update.release.notes || t("No release notes")}
            </pre>
          </TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={busy}
            aria-label={checkLabel}
            aria-busy={busy}
            title={checkLabel}
            className="size-7 shrink-0 rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
            onClick={() => void checkRelease(true)}
          >
            <HugeiconsIcon
              icon={Refresh03Icon}
              size={15}
              strokeWidth={1.75}
              className={
                busy
                  ? "animate-spin"
                  : "transition-transform duration-200 group-hover/button:rotate-45"
              }
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{checkLabel}</TooltipContent>
      </Tooltip>
    </div>
  );
}
