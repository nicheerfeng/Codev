import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { SessionView } from "./types";

function formatTokens(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function resolveContextPercent(
  context?: Record<string, unknown>,
): number | null {
  if (!context) return null;
  if (typeof context.percent === "number" && Number.isFinite(context.percent)) {
    return Math.max(0, Math.min(100, context.percent));
  }
  const tokens = Number(context.tokens ?? context.used);
  const windowSize = Number(context.window ?? context.size);
  if (
    Number.isFinite(tokens) &&
    tokens >= 0 &&
    Number.isFinite(windowSize) &&
    windowSize > 0
  ) {
    return Math.max(0, Math.min(100, (tokens / windowSize) * 100));
  }
  return null;
}

export function ContextViz({
  session,
  onCompact,
}: {
  session: SessionView;
  onCompact: () => void;
}) {
  const [compactStartedAt, setCompactStartedAt] = useState<number | null>(null);
  const [compactPendingUsage, setCompactPendingUsage] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const prevState = useRef(session.state);
  const prevTokens = useRef(session.context?.tokens);

  useEffect(() => {
    if (session.state === "compacting" && prevState.current !== "compacting") {
      setCompactStartedAt(Date.now());
      setCompactPendingUsage(false);
      setElapsedSec(0);
    } else if (session.state !== "compacting" && prevState.current === "compacting") {
      setCompactStartedAt(null);
      setCompactPendingUsage(true);
    }
    prevState.current = session.state;
  }, [session.state]);

  useEffect(() => {
    if (session.context?.tokens !== prevTokens.current) {
      prevTokens.current = session.context?.tokens;
      if (compactPendingUsage && session.state !== "compacting") {
        setCompactPendingUsage(false);
      }
    }
  }, [session.context?.tokens, compactPendingUsage, session.state]);

  useEffect(() => {
    if (!compactStartedAt) return;
    const timer = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - compactStartedAt) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [compactStartedAt]);

  const percent = resolveContextPercent(session.context);

  const usage =
    session.context?.usage && typeof session.context.usage === "object"
      ? (session.context.usage as Record<string, unknown>)
      : null;

  const canShow =
    session.capabilities.supportsContextUsage ||
    session.capabilities.supportsCompaction ||
    percent !== null;
  if (!canShow) return null;

  const r = 6;
  const c = 2 * Math.PI * r;
  const dash = percent !== null ? ((100 - percent) / 100) * c : c;
  const toneClass =
    percent !== null && percent >= 85
      ? "text-destructive"
      : percent !== null && percent >= 65
        ? "text-amber-500"
        : "text-muted-foreground";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`agent-context-pill ${toneClass}`}
          title="查看上下文占用明细与压缩操作"
          aria-label="查看上下文占用明细与压缩操作"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle
              cx="8"
              cy="8"
              r={r}
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.2"
              strokeWidth="2"
            />
            {percent !== null && (
              <circle
                cx="8"
                cy="8"
                r={r}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray={c}
                strokeDashoffset={dash}
                strokeLinecap="round"
                transform="rotate(-90 8 8)"
              />
            )}
          </svg>
          <span>
            {session.state === "compacting"
              ? `压缩中 ${elapsedSec}s`
              : compactPendingUsage
                ? "已压缩 · 待更新"
                : percent !== null
                  ? `${percent.toFixed(0)}%`
                  : null}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3 text-xs">
        <div className="mb-2 flex items-center justify-between font-medium">
          <span>上下文窗口使用情况</span>
          {percent !== null && <span>{percent.toFixed(1)}%</span>}
        </div>
        {session.state === "compacting" ? (
          <p className="mb-2 text-[11px] text-muted-foreground">
            正在压缩历史上下文（已用时 {elapsedSec} 秒）…
          </p>
        ) : compactPendingUsage ? (
          <p className="mb-2 text-[11px] text-muted-foreground">
            上下文已压缩，用量将在下一次模型响应后精确更新。
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <dt>累计 Token</dt>
          <dd className="text-right text-foreground">
            {formatTokens(session.context?.tokens ?? session.context?.used)}
          </dd>
          <dt>模型上限</dt>
          <dd className="text-right text-foreground">
            {formatTokens(session.context?.window ?? session.context?.size)}
          </dd>
          {usage && (
            <>
              <dt>输入 (Input)</dt>
              <dd className="text-right">{formatTokens(usage.input)}</dd>
              <dt>输出 (Output)</dt>
              <dd className="text-right">{formatTokens(usage.output)}</dd>
              <dt>缓存读取</dt>
              <dd className="text-right">{formatTokens(usage.cacheRead)}</dd>
              <dt>缓存写入</dt>
              <dd className="text-right">{formatTokens(usage.cacheWrite)}</dd>
            </>
          )}
        </dl>
        {session.capabilities.supportsCompaction && !session.readOnly && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3 h-7 w-full text-xs"
            disabled={session.state !== "idle"}
            onClick={onCompact}
          >
            {session.state === "compacting" ? "正在压缩…" : "立即压缩上下文"}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
