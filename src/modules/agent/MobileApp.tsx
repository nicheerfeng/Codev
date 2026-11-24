import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AgentPane } from "./AgentPane";
import { agentClient } from "./client";
import { useAgentStore } from "./store";
import { useVcsStore } from "@/modules/vcs/store";

const TOKEN_KEY = "codev.agent.deviceToken";
const nonceFromLink = () =>
  new URLSearchParams(window.location.hash.slice(1)).get("nonce") ?? "";
const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};
const randomSecret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

export function MobileApp() {
  const [token, setToken] = useState(getToken);
  const [nonce, setNonce] = useState(nonceFromLink);
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState("我的手机");
  const [serverToken, setServerToken] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [request, setRequest] = useState<{
    requestId: string;
    claimSecret: string;
  } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [hostOffline, setHostOffline] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [mobileTab, setMobileTab] = useState<"agent" | "vcs">("agent");
  const snapshotsMap = useVcsStore((s) => s.snapshots);
  const inboxesMap = useVcsStore((s) => s.inboxes);
  const vcsSnapshots = useMemo(() => Object.values(snapshotsMap), [snapshotsMap]);
  const forgeInboxes = useMemo(() => Object.values(inboxesMap), [inboxesMap]);
  const totalUnread = useVcsStore((s) => s.totalForgeUnread);
  const save = useCallback((token: string) => {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* token remains usable for this page */
    }
    setToken(token);
    history.replaceState(null, "", location.pathname);
  }, []);
  const logout = useCallback(() => {
    agentClient.disconnect();
    setToken("");
    setRequest(null);
    setError("");
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* optional persistence */
    }
    useAgentStore.setState({
      connection: "disconnected",
      views: {},
      sessions: {},
      selected: null,
      slots: [null],
      opened: [],
      serverId: null,
    });
  }, []);
  useEffect(() => {
    window.addEventListener("codev:agent-logout", logout);
    return () => window.removeEventListener("codev:agent-logout", logout);
  }, [logout]);
  useEffect(() => {
    if (!token) return;
    const abort = new AbortController();
    setConnecting(true);
    setHostOffline(false);
    setError("");
    void fetch("/v1/bootstrap", {
      headers: { Authorization: `Bearer ${token}` },
      signal: abort.signal,
    })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          const err = new Error("设备授权无效或已被吊销，请在桌面重新配对。") as Error & {
            revoked?: boolean;
          };
          err.revoked = true;
          throw err;
        }
        if (!response.ok) {
          throw new Error(`代理主机暂时不可用（HTTP ${response.status}）`);
        }
        useAgentStore.getState().connectRemote({
          endpoint: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/ws`,
          token,
        });
      })
      .catch((e: Error & { revoked?: boolean }) => {
        if (!abort.signal.aborted) {
          setError(String(e.message ?? e));
          if (e.revoked) {
            try {
              localStorage.removeItem(TOKEN_KEY);
            } catch {
              /* optional */
            }
            setToken("");
          } else {
            setHostOffline(true);
          }
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setConnecting(false);
      });
    return () => abort.abort();
  }, [token, retryTick]);
  useEffect(() => {
    if (!request) return;
    let stopped = false;
    let inFlight = false;
    const expires = Date.now() + 300000;
    const poll = async () => {
      if (inFlight || stopped) return;
      if (Date.now() > expires) {
        setError("配对已过期，请在桌面重新生成配对码。");
        setRequest(null);
        setWaiting(false);
        return;
      }
      inFlight = true;
      try {
        const response = await fetch("/v1/pair/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "配对失败");
        if (!stopped && data.status === "approved") {
          save(data.token);
          setRequest(null);
          setWaiting(false);
        }
      } catch (error) {
        if (!stopped) {
          setError(error instanceof Error ? error.message : String(error));
          setWaiting(false);
          setRequest(null);
        }
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2200);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [request, save]);
  const pair = async () => {
    setError("");
    setWaiting(true);
    const claimSecret = randomSecret();
    try {
      const response = await fetch("/v1/pair/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce, code, deviceName, claimSecret }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "配对失败");
      setRequest({ requestId: data.requestId, claimSecret });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWaiting(false);
    }
  };
  if (token && !connecting && !hostOffline) {
    return (
      <div className="flex h-dvh w-screen flex-col overflow-hidden bg-background">
        <nav className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 bg-card px-2 text-xs">
          <button
            type="button"
            onClick={() => setMobileTab("agent")}
            className={`rounded px-2.5 py-1 font-medium ${mobileTab === "agent" ? "bg-accent text-foreground" : "text-muted-foreground"}`}
          >
            Agent 会话
          </button>
          <button
            type="button"
            onClick={() => setMobileTab("vcs")}
            className={`flex items-center gap-1 rounded px-2.5 py-1 font-medium ${mobileTab === "vcs" ? "bg-accent text-foreground" : "text-muted-foreground"}`}
          >
            <span>仓库与收件箱 (只读)</span>
            {totalUnread > 0 && (
              <span className="rounded-full bg-primary/20 px-1 text-[10px] text-primary">
                {totalUnread}
              </span>
            )}
          </button>
        </nav>
        <div className="min-h-0 flex-1 overflow-hidden">
          {mobileTab === "agent" ? (
            <AgentPane mobile />
          ) : (
            <div className="h-full space-y-4 overflow-y-auto p-3 text-xs">
              <section className="space-y-2">
                <h2 className="font-semibold text-foreground">
                  仓库状态投影（{vcsSnapshots.length}）
                </h2>
                {vcsSnapshots.length === 0 ? (
                  <p className="text-muted-foreground">暂无活跃 Git 仓库快照。</p>
                ) : (
                  vcsSnapshots.map((snap) => (
                    <div
                      key={snap.worktreeRoot}
                      className="space-y-1.5 rounded border border-border/60 bg-card p-2.5"
                    >
                      <div className="flex items-center justify-between font-medium">
                        <span>
                          {snap.repoName} · {snap.branch}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {snap.ahead ? `↑${snap.ahead}` : ""}{" "}
                          {snap.behind ? `↓${snap.behind}` : ""}
                        </span>
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        已暂存 {snap.counts.staged} · 修改 {snap.counts.modified} · 未跟踪{" "}
                        {snap.counts.untracked} · 冲突 {snap.counts.conflicted}
                      </div>
                      {snap.entries.slice(0, 15).map((e) => (
                        <div
                          key={e.path}
                          className="truncate font-mono text-[10.5px] text-foreground/80"
                        >
                          {e.indexStatus}
                          {e.worktreeStatus} {e.path}
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </section>
              <section className="space-y-2">
                <h2 className="font-semibold text-foreground">
                  Forge 通知与 Issues/PR（{forgeInboxes.length}）
                </h2>
                {forgeInboxes.map((inbox) => (
                  <div
                    key={inbox.repo?.fullName ?? "none"}
                    className="space-y-1.5 rounded border border-border/60 bg-card p-2.5"
                  >
                    <div className="font-medium">
                      {inbox.repo?.fullName ?? "未连接远程"}（未读 {inbox.unreadCount}）
                    </div>
                    {inbox.notifications.slice(0, 8).map((n) => (
                      <div key={n.id} className="text-[11px] text-foreground/85">
                        {n.unread ? "● " : ""}
                        [{n.subjectType}] {n.title}
                      </div>
                    ))}
                    {inbox.pulls.slice(0, 6).map((pr) => (
                      <div key={pr.id} className="text-[10.5px] text-muted-foreground">
                        PR #{pr.number}: {pr.title} ({pr.checksStatus})
                      </div>
                    ))}
                  </div>
                ))}
              </section>
            </div>
          )}
        </div>
      </div>
    );
  }
  if (token && hostOffline) {
    return (
      <main className="agent-pair-page">
        <div className="agent-pair-form">
          <h1>Codev</h1>
          <p>暂时无法连接到代理主机，已保留本机设备凭证。</p>
          {error && (
            <div className="agent-error" role="alert">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <Button type="button" onClick={() => setRetryTick((v) => v + 1)}>
              重新连接
            </Button>
            <Button type="button" variant="outline" onClick={logout}>
              清除凭证并重新配对
            </Button>
          </div>
        </div>
      </main>
    );
  }
  return (
    <main className="agent-pair-page">
      <form
        className="agent-pair-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (advanced) save(serverToken.trim());
          else void pair();
        }}
      >
        <h1>Codev</h1>
        <p>
          {connecting
            ? "正在连接代理主机…"
            : waiting
              ? "请在电脑的“代理与手机设置”中批准这台设备。"
              : "连接电脑上的代理主机，继续阅读、发送任务和处理审批。"}
        </p>
        {!connecting && (
          <>
            {advanced ? (
              <>
                <label htmlFor="server-token">服务器访问令牌</label>
                <Input
                  id="server-token"
                  type="password"
                  autoComplete="off"
                  required
                  value={serverToken}
                  onChange={(e) => setServerToken(e.target.value)}
                  placeholder="独立服务器启动时显示的访问令牌"
                />
              </>
            ) : (
              <>
                {!nonce && (
                  <>
                    <label htmlFor="pair-nonce">配对标识</label>
                    <Input
                      id="pair-nonce"
                      value={nonce}
                      onChange={(e) => setNonce(e.target.value)}
                      placeholder="请先扫描电脑上的二维码"
                      required
                      disabled={waiting}
                    />
                  </>
                )}
                <label htmlFor="device-name">设备名称</label>
                <Input
                  id="device-name"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  required
                  maxLength={80}
                  disabled={waiting}
                />
                <label htmlFor="pair-code">电脑显示的六位配对码</label>
                <Input
                  id="pair-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="000000"
                  required
                  disabled={waiting}
                />
              </>
            )}
            <Button type="submit" disabled={waiting}>
              {waiting ? "等待桌面批准…" : "连接"}
            </Button>
            {!waiting && (
              <button
                type="button"
                className="text-xs text-muted-foreground"
                onClick={() => setAdvanced(!advanced)}
              >
                {advanced ? "使用手机配对" : "使用独立服务器令牌"}
              </button>
            )}
          </>
        )}
        {error && (
          <div className="agent-error" role="alert">
            {error}
          </div>
        )}
        <small>代理在电脑或服务器上运行，关闭手机页面不会停止任务。</small>
      </form>
    </main>
  );
}
