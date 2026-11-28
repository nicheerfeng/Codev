import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setAutoCheckUpdates,
  setUpdateCheckHours,
} from "@/modules/settings/store";
import { useCallback, useEffect, useState } from "react";
import { getIdentifier, getVersion } from "@tauri-apps/api/app";
import { HugeiconsIcon } from "@hugeicons/react";
import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SettingCard, SettingRow } from "@/modules/agent/SettingPrimitives";
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
  const enabled = usePreferencesStore((state) => state.autoCheckUpdates);
  const hours = usePreferencesStore((state) => state.updateCheckHours);
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
      <SettingCard>
        <SettingRow
          htmlFor="settings-auto-check-updates"
          title="自动检查更新"
          description="定时检查 GitHub 最新发行版本。"
          control={
            <Switch
              id="settings-auto-check-updates"
              checked={enabled}
              onCheckedChange={(checked) => void setAutoCheckUpdates(checked)}
            />
          }
        />
        <SettingRow
          title="检查间隔"
          description="两次自动检查更新之间的时间间隔。"
          control={
            <Select
              value={String(hours)}
              disabled={!enabled}
              onValueChange={(value) => void setUpdateCheckHours(Number(value))}
            >
              <SelectTrigger
                size="sm"
                className="w-24"
                aria-label="更新检查间隔"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 4, 8, 12, 24, 48, 168].map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {value} 小时
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingCard>
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
