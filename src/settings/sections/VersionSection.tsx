import { usePreferencesStore } from "@/modules/settings/preferences";
import { setAutoCheckUpdates, setUpdateCheckHours } from "@/modules/settings/store";
import { useCallback, useEffect, useState } from "react";
import { getIdentifier, getVersion } from "@tauri-apps/api/app";
import { HugeiconsIcon } from "@hugeicons/react";
import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  EMPTY_VERSION_CHANNEL,
  VersionChannelCard,
  type VersionChannelState,
} from "@/components/VersionChannelCard";
import {
  CODEV_RELEASES_URL,
  CODEV_REPO_URL,
  fetchLatestRelease,
  parseDottedVersion,
  updateReleaseStatus,
} from "@/lib/releaseChannel";

/** 主设置只负责 Codev 本机版本和 GitHub 发行检测。 */
export function VersionSection() {
  const enabled = usePreferencesStore(state => state.autoCheckUpdates);
  const hours = usePreferencesStore(state => state.updateCheckHours);
  const [channel, setChannel] = useState<VersionChannelState>({
    ...EMPTY_VERSION_CHANNEL,
    releaseUrl: CODEV_RELEASES_URL,
  });
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setChannel((current) => ({ ...current, error: "", status: "" }));
    try {
      const [version, identifier] = await Promise.all([
        getVersion(),
        getIdentifier().catch(() => null),
      ]);
      setChannel((current) => ({
        ...current,
        installed: parseDottedVersion(version) ?? version,
        detail: identifier,
        error: "",
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
      const result = await fetchLatestRelease("codev");
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
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-[12px] font-semibold tracking-tight">
          版本
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
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-xs">
        <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={event => void setAutoCheckUpdates(event.target.checked)} />自动检查更新</label>
        <label className="ml-auto flex items-center gap-2">检查间隔
          <select aria-label="更新检查间隔" className="rounded border border-border bg-background px-2 py-1" value={hours} disabled={!enabled} onChange={event => void setUpdateCheckHours(Number(event.target.value))}>
            {[1, 2, 4, 8, 12, 24, 48, 168].map(value => <option key={value} value={value}>{value} 小时</option>)}
          </select>
        </label>
      </div>
      <VersionChannelCard
        title="本机 Codev"
        fallback="未探测到"
        repoUrl={CODEV_REPO_URL}
        channel={channel}
        onCheck={() => void check()}
      />
    </section>
  );
}
