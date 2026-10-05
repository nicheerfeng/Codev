import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  EMPTY_VERSION_CHANNEL,
  VersionChannelCard,
  type VersionChannelState,
} from "@/components/VersionChannelCard";
import {
  compareDottedVersions,
  fetchLatestRelease,
  parseDottedVersion,
  PI_RELEASES_URL,
  PI_REPO_URL,
  updateReleaseStatus,
} from "@/lib/releaseChannel";
import { probePiAgent } from "./native";

export const parsePiVersion = parseDottedVersion;
export const comparePiVersions = compareDottedVersions;

/** Pi 设置只展示本机 CLI 和上游发行，不再混入 Codev。 */
export function PiVersionPanel({ embedded = false }: { embedded?: boolean }) {
  const [channel, setChannel] = useState<VersionChannelState>({
    ...EMPTY_VERSION_CHANNEL,
    releaseUrl: PI_RELEASES_URL,
  });
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setChannel((current) => ({ ...current, error: "", status: "" }));
    try {
      const probe = await probePiAgent();
      setChannel((current) => ({
        ...current,
        installed: parseDottedVersion(probe.version) ?? probe.version,
        detail: probe.path,
        error: probe.available ? "" : (probe.error ?? "Pi 不可用"),
      }));
    } catch (value) {
      setChannel((current) => ({ ...current, error: String(value) }));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const check = async () => {
    setChannel((current) => ({
      ...current,
      checking: true,
      error: "",
      status: "",
    }));
    try {
      const result = await fetchLatestRelease("pi");
      setChannel((current) => ({
        ...current,
        latest: result.latest,
        name: result.name,
        publishedAt: result.publishedAt,
        notes: result.notes,
        releaseUrl: result.releaseUrl ?? current.releaseUrl,
        status: updateReleaseStatus(current.installed, result.latest),
      }));
    } catch (value) {
      setChannel((current) => ({ ...current, error: String(value) }));
    } finally {
      setChannel((current) => ({ ...current, checking: false }));
    }
  };
  return (
    <section
      className={
        embedded
          ? "rounded-lg border border-border/70"
          : "flex min-h-0 flex-1 flex-col"
      }
      aria-label="Pi 版本"
    >
      <div
        className={
          embedded
            ? "flex items-center gap-2 px-3 pt-3"
            : "flex shrink-0 items-center gap-2 border-b border-border px-3 py-3 sm:px-4"
        }
      >
        <h2
          className={
            embedded
              ? "flex-1 text-xs font-medium"
              : "flex-1 text-sm font-medium"
          }
        >
          Pi 版本
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          title="刷新本机版本"
          aria-label="刷新本机版本"
          disabled={busy}
          onClick={() => void load()}
        >
          <HugeiconsIcon
            icon={Refresh01Icon}
            className={busy ? "animate-spin" : ""}
            size={14}
          />
        </Button>
      </div>
      <div
        className={
          embedded
            ? "p-3 pt-0"
            : "reader-scrollbar min-h-0 flex-1 overflow-auto p-3 sm:p-4"
        }
      >
        <div
          className={
            embedded
              ? "flex flex-col gap-3"
              : "mx-auto flex max-w-xl flex-col gap-3"
          }
        >
          <VersionChannelCard
            title="本机 Pi CLI"
            fallback="未探测到"
            repoUrl={PI_REPO_URL}
            channel={channel}
            onCheck={() => void check()}
            plain={embedded}
          />
        </div>
      </div>
    </section>
  );
}
