import { Button } from "@/components/ui/button";
import { openExternalUrl } from "@/lib/external-link";

export type VersionChannelState = {
  installed: string | null;
  detail: string | null;
  latest: string | null;
  name: string | null;
  publishedAt: string | null;
  notes: string | null;
  releaseUrl: string;
  checking: boolean;
  status: string;
  error: string;
};

export const EMPTY_VERSION_CHANNEL: VersionChannelState = {
  installed: null,
  detail: null,
  latest: null,
  name: null,
  publishedAt: null,
  notes: null,
  releaseUrl: "",
  checking: false,
  status: "",
  error: "",
};

function formatPublishedAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/** 本机版本、检测状态，以及点击后展开的最近发行说明。 */
export function VersionChannelCard(props: {
  title: string;
  fallback: string;
  repoUrl: string;
  channel: VersionChannelState;
  onCheck: () => void;
}) {
  const message =
    props.channel.error ||
    props.channel.status ||
    (props.channel.latest ? `GitHub 最新 ${props.channel.latest}` : "");
  const published = formatPublishedAt(props.channel.publishedAt);
  return (
    <article className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-4">
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
      </div>
      {props.channel.notes ? (
        <div className="mt-3 border-t border-border/70 pt-3">
          <p className="text-[11px] font-medium">
            {props.channel.name ||
              (props.channel.latest ? `v${props.channel.latest}` : "最近更新")}
          </p>
          {published ? (
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {published}
            </p>
          ) : null}
          <pre className="reader-scrollbar mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-[11px] leading-5 text-muted-foreground">
            {props.channel.notes}
          </pre>
        </div>
      ) : null}
    </article>
  );
}
