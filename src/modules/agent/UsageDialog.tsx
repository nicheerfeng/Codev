import { useCallback, useEffect, useRef, useState } from "react";
import { Analytics01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HarnessIcon } from "./HarnessIcon";
import { useAgentStore } from "./store";

type Totals = {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
  unpriced: number;
};
type Row = {
  timestamp: number;
  source: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
  durationMs: number | null;
  firstTokenMs: number | null;
};
type Group = {
  name: string;
  requests: number;
  tokens: number;
  cost: number | null;
};
type Price = {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
type Data = {
  totals: Totals;
  rows: Row[];
  points: Array<{
    timestamp: number;
    tokens: number;
    requests: number;
    cost: number | null;
  }>;
  providers: Group[];
  models: Group[];
  options: Array<{ model: string; provider: string; source: string }>;
  prices: Price[];
};
type Sync = {
  updated: number;
  files: number;
  errors: string[];
  syncedAt: number;
};
const sourceNames: Record<string, string> = {
  pi: "Pi",
  codex: "Codex",
  agy: "Antigravity",
};
const harnessIds: Record<string, string> = {
  pi: "pi",
  codex: "acp:codex",
  agy: "acp:antigravity",
};
const format = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}K`
      : value.toLocaleString();
const money = (value: number | null) =>
  value == null ? "未定价" : `$${value.toFixed(value < 1 ? 4 : 2)}`;

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}
function rangeStart(range: string, custom: string, now: number) {
  if (range === "today") return Math.floor(startOfToday().getTime() / 1000);
  if (range === "all") return 0;
  if (range === "custom")
    return custom
      ? Math.floor(new Date(`${custom}T00:00:00`).getTime() / 1000)
      : 0;
  return Math.floor(now / 1000) - Number(range) * 86400;
}

export function UsageDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [range, setRange] = useState("today");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [source, setSource] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [tab, setTab] = useState<"logs" | "providers" | "models" | "prices">(
    "logs",
  );
  const [metric, setMetric] = useState<"tokens" | "requests" | "cost">(
    "tokens",
  );
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Data | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState("");
  const [interval, setIntervalSeconds] = useState(60);
  const [price, setPrice] = useState<Price>({
    model: "",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  const pending = useRef<Promise<void> | null>(null);
  const requestSequence = useRef(0);
  const start = rangeStart(range, customStart, now);
  const end =
    range === "custom" && customEnd
      ? Math.floor(new Date(`${customEnd}T00:00:00`).getTime() / 1000) + 86400
      : 4102444800;
  const hourly = range === "today" || range === "1";

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const result = await useAgentStore
        .getState()
        .command<Data>("usage.query", {
          start,
          end,
          source,
          provider,
          model,
          page,
          interval: hourly ? "hour" : "day",
          timezoneOffset: -new Date().getTimezoneOffset() * 60,
        });
      if (sequence === requestSequence.current) setData(result);
    } catch (value) {
      if (sequence === requestSequence.current) setError(String(value));
    }
  }, [start, end, source, provider, model, page, hourly]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const sync = useCallback(() => {
    if (pending.current) return pending.current;
    setSyncing(true);
    pending.current = (async () => {
      try {
        const result = await useAgentStore
          .getState()
          .command<Sync>("usage.sync");
        setLastSync(result.syncedAt);
        setNow(Date.now());
        setError(
          result.errors.length
            ? `部分日志读取失败（${result.errors.length} 项）：${result.errors[0]}`
            : "",
        );
        await refreshRef.current();
      } catch (value) {
        setError(String(value));
      } finally {
        setSyncing(false);
        pending.current = null;
      }
    })();
    return pending.current;
  }, []);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);
  useEffect(() => {
    if (!open) return;
    void sync();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void sync();
    }, interval * 1000);
    const visible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [open, interval, sync]);

  const totals = data?.totals;
  const totalTokens = totals
    ? totals.input + totals.output + totals.cacheRead + totals.cacheWrite
    : 0;
  const cacheRate =
    totals && totals.input + totals.cacheRead + totals.cacheWrite > 0
      ? (totals.cacheRead /
          (totals.input + totals.cacheRead + totals.cacheWrite)) *
        100
      : 0;
  const points = (() => {
    const values = data?.points ?? [];
    if (!hourly) return values;
    const hour = 3600;
    const first = Math.floor(start / hour) * hour;
    const last = Math.floor(now / 1000 / hour) * hour;
    const byTime = new Map(values.map((point) => [point.timestamp, point]));
    const result = [];
    for (let time = first; time <= last; time += hour) {
      result.push(
        byTime.get(time) ?? {
          timestamp: time,
          tokens: 0,
          requests: 0,
          cost: null,
        },
      );
    }
    return result;
  })();
  const chartValue = (point: (typeof points)[number]) =>
    metric === "tokens"
      ? point.tokens
      : metric === "requests"
        ? point.requests
        : (point.cost ?? 0);
  const max = Math.max(1, ...points.map(chartValue));
  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const value = max * (1 - index / 4);
    return {
      value,
      label:
        metric === "cost"
          ? value < 1
            ? `$${value.toFixed(2)}`
            : `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
          : format(Math.round(value)),
    };
  });
  const providers = [
    ...new Set(
      (data?.options ?? [])
        .filter((item) => !source || item.source === source)
        .map((item) => item.provider),
    ),
  ];
  const models = [
    ...new Set(
      (data?.options ?? [])
        .filter(
          (item) =>
            (!source || item.source === source) &&
            (!provider || item.provider === provider),
        )
        .map((item) => item.model),
    ),
  ];
  const savePrice = async () => {
    try {
      await useAgentStore.getState().command("usage.prices.save", price);
      setError("");
      await refresh();
    } catch (value) {
      setError(String(value));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="agent-usage-dialog sm:max-w-none">
        <header className="agent-usage-header">
          <HugeiconsIcon icon={Analytics01Icon} size={20} />
          <DialogTitle>用量统计</DialogTitle>
          <span className="agent-usage-header-spacer" />
          <span className="agent-usage-muted">
            {lastSync
              ? `同步于 ${new Date(lastSync * 1000).toLocaleTimeString()}`
              : "等待同步"}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={syncing}
            onClick={() => void sync()}
          >
            {syncing ? "同步中…" : "立即同步"}
          </Button>
          <Select
            value={String(interval)}
            onValueChange={(value) => setIntervalSeconds(Number(value))}
          >
            <SelectTrigger size="sm" aria-label="同步间隔">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[5, 10, 30, 60].map((seconds) => (
                <SelectItem key={seconds} value={String(seconds)}>
                  {seconds} 秒
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </header>
        <DialogDescription className="sr-only">
          按时间、代理、供应商和模型查看本机用量。
        </DialogDescription>
        <div className="agent-usage-scroll reader-scrollbar">
          <div className="agent-usage-filters">
            <Select
              value={range}
              onValueChange={(value) => {
                setRange(value);
                setPage(0);
              }}
            >
              <SelectTrigger size="sm" aria-label="时间范围">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">当天</SelectItem>
                <SelectItem value="1">近 24 小时</SelectItem>
                <SelectItem value="7">近 7 天</SelectItem>
                <SelectItem value="30">近 30 天</SelectItem>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="custom">自定义</SelectItem>
              </SelectContent>
            </Select>
            {range === "custom" && (
              <>
                <Input
                  type="date"
                  aria-label="开始日期"
                  value={customStart}
                  onChange={(event) => setCustomStart(event.target.value)}
                />
                <Input
                  type="date"
                  aria-label="结束日期"
                  value={customEnd}
                  onChange={(event) => setCustomEnd(event.target.value)}
                />
              </>
            )}
            <div className="agent-usage-sources">
              <button
                type="button"
                className={!source ? "is-active" : ""}
                onClick={() => {
                  setSource("");
                  setProvider("");
                  setModel("");
                  setPage(0);
                }}
              >
                全部
              </button>
              {Object.entries(sourceNames).map(([id, name]) => (
                <button
                  key={id}
                  type="button"
                  title={name}
                  aria-label={name}
                  className={source === id ? "is-active" : ""}
                  onClick={() => {
                    setSource(id);
                    setProvider("");
                    setModel("");
                    setPage(0);
                  }}
                >
                  <HarnessIcon harnessId={harnessIds[id]} size={16} />
                </button>
              ))}
            </div>
            <Select
              value={provider || "all"}
              onValueChange={(value) => {
                setProvider(value === "all" ? "" : value);
                setModel("");
                setPage(0);
              }}
            >
              <SelectTrigger size="sm" aria-label="供应商">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部供应商</SelectItem>
                {providers.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={model || "all"}
              onValueChange={(value) => {
                setModel(value === "all" ? "" : value);
                setPage(0);
              }}
            >
              <SelectTrigger size="sm" aria-label="模型">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部模型</SelectItem>
                {models.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && (
            <div className="agent-usage-error" role="alert">
              {error}
            </div>
          )}
          <section className="agent-usage-overview">
            <div className="agent-usage-cards">
              <div>
                <span>总成本（估算）</span>
                <strong>{money(totals?.cost ?? null)}</strong>
                {!!totals?.unpriced && (
                  <small>{totals.unpriced} 条未定价</small>
                )}
              </div>
              <div>
                <span>总请求数</span>
                <strong>{format(totals?.requests ?? 0)}</strong>
              </div>
              <div>
                <span>真实消耗 Tokens</span>
                <strong>{format(totalTokens)}</strong>
              </div>
              <div>
                <span>缓存命中率</span>
                <strong>{cacheRate.toFixed(1)}%</strong>
              </div>
            </div>
            <div className="agent-usage-chart-head">
              <strong>
                {metric === "tokens"
                  ? "Tokens"
                  : metric === "requests"
                    ? "请求数"
                    : "成本"}{" "}
                · {hourly ? "按小时" : "按天"}
              </strong>
              <div>
                {(
                  [
                    ["tokens", "Tokens"],
                    ["requests", "请求"],
                    ["cost", "成本"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    type="button"
                    key={id}
                    className={metric === id ? "is-active" : ""}
                    onClick={() => setMetric(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {points.length ? (
              <div className="agent-usage-chart-shell">
                <div className="agent-usage-y-axis" aria-hidden="true">
                  {yTicks.map((tick, index) => (
                    <span
                      key={`${tick.value}-${index}`}
                      className="agent-usage-y-tick"
                      style={{ top: `${(index / 4) * 100}%` }}
                    >
                      {tick.label}
                    </span>
                  ))}
                </div>
                <div className="agent-usage-chart">
                  {points.map((point) => (
                    <Tooltip key={point.timestamp} delayDuration={200}>
                      <TooltipTrigger asChild>
                        <div
                          className="agent-usage-chart-column"
                          tabIndex={0}
                          aria-label={`${new Date(point.timestamp * 1000).toLocaleString()}，${metric === "tokens" ? "Tokens" : metric === "requests" ? "请求数" : "成本"}：${metric === "cost" ? money(point.cost) : chartValue(point).toLocaleString()}`}
                        >
                          <div className="agent-usage-bar-stage">
                            <div
                              className="agent-usage-bar"
                              style={{
                                height: `${Math.max(1, (chartValue(point) / max) * 100)}%`,
                              }}
                            />
                          </div>
                          <small>
                            {hourly
                              ? new Date(
                                  point.timestamp * 1000,
                                ).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })
                              : new Date(
                                  point.timestamp * 1000,
                                ).toLocaleDateString([], {
                                  month: "numeric",
                                  day: "numeric",
                                })}
                          </small>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent
                        side="top"
                        sideOffset={6}
                        collisionPadding={12}
                        className="z-[100] rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
                      >
                        <span className="text-muted-foreground">
                          {new Date(point.timestamp * 1000).toLocaleString()}
                        </span>
                        <span>
                          {metric === "tokens"
                            ? "Tokens"
                            : metric === "requests"
                              ? "请求数"
                              : "成本"}
                          ：
                          {metric === "cost"
                            ? money(point.cost)
                            : chartValue(point).toLocaleString()}
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </div>
            ) : (
              <div className="agent-usage-empty">暂无用量记录</div>
            )}
          </section>
          <section className="agent-usage-detail">
            <nav>
              {(
                [
                  ["logs", "请求日志", totals?.requests],
                  ["providers", "供应商", data?.providers.length],
                  ["models", "模型", data?.models.length],
                  ["prices", "定价", undefined],
                ] as const
              ).map(([id, label, count]) => (
                <button
                  key={id}
                  type="button"
                  className={tab === id ? "is-active" : ""}
                  onClick={() => setTab(id)}
                >
                  {label} {count !== undefined && <small>{count}</small>}
                </button>
              ))}
            </nav>
            {tab === "logs" && (
              <>
                <div className="agent-usage-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>应用</th>
                        <th>供应商</th>
                        <th>模型</th>
                        <th>成本</th>
                        <th>新增输入</th>
                        <th>输出</th>
                        <th>缓存命中</th>
                        <th>速度</th>
                        <th>首字</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data?.rows.map((row, index) => (
                        <tr key={`${row.timestamp}-${index}`}>
                          <td>
                            {row.timestamp
                              ? new Date(row.timestamp * 1000).toLocaleString()
                              : "未知"}
                          </td>
                          <td>{sourceNames[row.source] ?? row.source}</td>
                          <td>{row.provider}</td>
                          <td>{row.model}</td>
                          <td>{money(row.cost)}</td>
                          <td>{format(row.input)}</td>
                          <td>{format(row.output)}</td>
                          <td>{format(row.cacheRead)}</td>
                          <td>
                            {row.durationMs && row.output >= 200
                              ? `≈${Math.round((row.output / row.durationMs) * 1000)} tok/s`
                              : "—"}
                          </td>
                          <td>
                            {row.firstTokenMs != null
                              ? `≈${(row.firstTokenMs / 1000).toFixed(1)}s`
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="agent-usage-pagination">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    上一页
                  </Button>
                  <span>第 {page + 1} 页</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={(page + 1) * 50 >= (totals?.requests ?? 0)}
                    onClick={() => setPage(page + 1)}
                  >
                    下一页
                  </Button>
                </div>
              </>
            )}
            {(tab === "providers" || tab === "models") && (
              <div className="agent-usage-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{tab === "models" ? "模型" : "供应商"}</th>
                      <th>请求数</th>
                      <th>Tokens</th>
                      <th>成本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(tab === "models" ? data?.models : data?.providers)?.map(
                      (group) => (
                        <tr key={group.name}>
                          <td>{group.name}</td>
                          <td>{group.requests}</td>
                          <td>{format(group.tokens)}</td>
                          <td>{money(group.cost)}</td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {tab === "prices" && (
              <div className="agent-usage-prices">
                <p>价格单位为美元 / 100 万 Token，费用为估算值。</p>
                <div className="agent-usage-price-form">
                  <Input
                    placeholder="模型 ID"
                    value={price.model}
                    onChange={(event) =>
                      setPrice({ ...price, model: event.target.value })
                    }
                  />
                  {(
                    [
                      ["input", "输入"],
                      ["output", "输出"],
                      ["cacheRead", "缓存读取"],
                      ["cacheWrite", "缓存写入"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        value={price[key]}
                        onChange={(event) =>
                          setPrice({
                            ...price,
                            [key]: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                  ))}
                  <Button size="sm" onClick={() => void savePrice()}>
                    保存
                  </Button>
                </div>
                <div className="agent-usage-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>模型</th>
                        <th>输入</th>
                        <th>输出</th>
                        <th>缓存读取</th>
                        <th>缓存写入</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data?.prices.map((item) => (
                        <tr key={item.model}>
                          <td>{item.model}</td>
                          <td>{item.input}</td>
                          <td>{item.output}</td>
                          <td>{item.cacheRead}</td>
                          <td>{item.cacheWrite}</td>
                          <td>
                            <button
                              type="button"
                              onClick={() => setPrice(item)}
                            >
                              编辑
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
