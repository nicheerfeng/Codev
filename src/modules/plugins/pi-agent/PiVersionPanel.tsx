import { useCallback, useEffect, useState } from "react";
import { getIdentifier, getVersion } from "@tauri-apps/api/app";
import { HugeiconsIcon } from "@hugeicons/react";
import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { openExternalUrl } from "@/lib/external-link";
import { probePiAgent } from "./native";

const CODEV_REPO_URL = "https://github.com/nicheerfeng/Codev";
const CODEV_RELEASES_URL = `${CODEV_REPO_URL}/releases`;
const CODEV_LATEST_RELEASE_API =
  "https://api.github.com/repos/nicheerfeng/Codev/releases/latest";
const PI_REPO_URL = "https://github.com/earendil-works/pi";
const PI_RELEASES_URL = `${PI_REPO_URL}/releases`;
const PI_LATEST_RELEASE_API =
  "https://api.github.com/repos/earendil-works/pi/releases/latest";

/** 从探测输出或 GitHub tag 抽出可比较的版本号。 */
export function parsePiVersion(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const match = value.match(/(\d+(?:\.\d+)+)/);
  return match?.[1] ?? null;
}

/** 按点分段比较版本，缺段视为 0。 */
export function comparePiVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

type ChannelState = {
  installed: string | null;
  detail: string | null;
  latest: string | null;
  releaseUrl: string;
  checking: boolean;
  status: string;
  error: string;
};

const EMPTY_CHANNEL: ChannelState = {
  installed: null,
  detail: null,
  latest: null,
  releaseUrl: "",
  checking: false,
  status: "",
  error: "",
};

function updateStatus(installed: string | null, latest: string | null): string {
  const current = parsePiVersion(installed);
  if (!latest) return "已读取发行页，但未识别出版本号。";
  if (!current) return `GitHub 最新版本 ${latest}`;
  if (comparePiVersions(latest, current) > 0)
    return `有更新：${current} → ${latest}`;
  return `已是最新版本 ${current}`;
}

async function fetchLatestRelease(api: string): Promise<{
  latest: string | null;
  releaseUrl: string | null;
}> {
  const response = await fetch(api, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
  const payload = (await response.json()) as {
    tag_name?: string;
    html_url?: string;
  };
  return {
    latest: parsePiVersion(payload.tag_name),
    releaseUrl: payload.html_url ?? null,
  };
}

function VersionCard(props: {
  title: string;
  fallback: string;
  repoUrl: string;
  channel: ChannelState;
  onCheck: () => void;
}) {
  const message =
    props.channel.error ||
    props.channel.status ||
    (props.channel.latest ? `GitHub 最新 ${props.channel.latest}` : "");
  return (
    <article className="flex items-center gap-4 rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] text-muted-foreground">{props.title}</p>
        <p className="mt-1 text-lg font-medium">
          {props.channel.installed ?? props.fallback}
        </p>
        {props.channel.detail && (
          <p className="mt-2 break-all text-[10px] text-muted-foreground/80">
            {props.channel.detail}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void openExternalUrl(props.repoUrl)}
          >
            仓库
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void openExternalUrl(props.channel.releaseUrl)}
          >
            Release
          </Button>
          <Button
            size="sm"
            disabled={props.channel.checking}
            onClick={props.onCheck}
          >
            {props.channel.checking ? "检测中…" : "检测更新"}
          </Button>
        </div>
      </div>
      <div className="flex min-w-[9rem] max-w-[42%] shrink-0 items-center justify-center self-stretch px-1 text-center">
        {message ? (
          <p
            role={props.channel.error ? "alert" : undefined}
            className={`text-xs leading-5 ${props.channel.error ? "text-amber-600" : "text-foreground"}`}
          >
            {message}
          </p>
        ) : null}
      </div>
    </article>
  );
}

/** 上面是 Codev 本机版本与发行检测，下面是 Pi CLI 仓库进展。 */
export function PiVersionPanel() {
  const [codev, setCodev] = useState<ChannelState>({
    ...EMPTY_CHANNEL,
    releaseUrl: CODEV_RELEASES_URL,
  });
  const [pi, setPi] = useState<ChannelState>({
    ...EMPTY_CHANNEL,
    releaseUrl: PI_RELEASES_URL,
  });
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setCodev((current) => ({ ...current, error: "", status: "" }));
    setPi((current) => ({ ...current, error: "", status: "" }));
    try {
      const [version, identifier, probe] = await Promise.all([
        getVersion(),
        getIdentifier().catch(() => null),
        probePiAgent(),
      ]);
      setCodev((current) => ({
        ...current,
        installed: parsePiVersion(version) ?? version,
        detail: identifier,
        error: "",
      }));
      setPi((current) => ({
        ...current,
        installed: parsePiVersion(probe.version) ?? probe.version,
        detail: probe.path,
        error: probe.available ? "" : (probe.error ?? "Pi 不可用"),
      }));
    } catch (value) {
      const message = String(value);
      setCodev((current) => ({ ...current, error: message }));
      setPi((current) => ({ ...current, error: message }));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const checkCodev = async () => {
    setCodev((current) => ({
      ...current,
      checking: true,
      error: "",
      status: "",
    }));
    try {
      const result = await fetchLatestRelease(CODEV_LATEST_RELEASE_API);
      setCodev((current) => ({
        ...current,
        latest: result.latest,
        releaseUrl: result.releaseUrl ?? current.releaseUrl,
        status: updateStatus(current.installed, result.latest),
      }));
    } catch (value) {
      setCodev((current) => ({ ...current, error: String(value) }));
    } finally {
      setCodev((current) => ({ ...current, checking: false }));
    }
  };
  const checkPi = async () => {
    setPi((current) => ({ ...current, checking: true, error: "", status: "" }));
    try {
      const result = await fetchLatestRelease(PI_LATEST_RELEASE_API);
      setPi((current) => ({
        ...current,
        latest: result.latest,
        releaseUrl: result.releaseUrl ?? current.releaseUrl,
        status: updateStatus(current.installed, result.latest),
      }));
    } catch (value) {
      setPi((current) => ({ ...current, error: String(value) }));
    } finally {
      setPi((current) => ({ ...current, checking: false }));
    }
  };
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="版本">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-3 sm:px-4">
        <h2 className="flex-1 text-sm font-medium">版本</h2>
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
      <div className="reader-scrollbar min-h-0 flex-1 overflow-auto p-3 sm:p-4">
        <div className="mx-auto flex max-w-xl flex-col gap-3">
          <VersionCard
            title="本机 Codev"
            fallback="未探测到"
            repoUrl={CODEV_REPO_URL}
            channel={codev}
            onCheck={() => void checkCodev()}
          />
          <VersionCard
            title="本机 Pi"
            fallback="未探测到"
            repoUrl={PI_REPO_URL}
            channel={pi}
            onCheck={() => void checkPi()}
          />
        </div>
      </div>
    </section>
  );
}
