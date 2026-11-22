import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { agentNotifyEnabled, setAgentNotifyEnabled } from "./notify";
import { useAgentStore } from "./store";
import type { Harness } from "./types";
import { VoiceSettingsPanel } from "@/modules/voice/VoiceSettingsPanel";

type Diagnosis = {
  id: string;
  displayName: string;
  verdict: "ready" | "missing_binary" | "needs_config" | "needs_auth";
  installed: boolean;
  resolvedPath?: string | null;
  nodePath?: string | null;
  managedCodex?: boolean;
  hints: string[];
};

type PolicyMap = Record<string, { read?: string; write?: string }>;

type DocsInfo = {
  piAppendSystemPath: string;
  piAppendSystem: string;
  piModelsPath: string;
  piModelsProviders: string[];
  codexAgentsPath: string;
  codexAgents: string;
};

type Remote = {
  enabled: boolean;
  port?: number;
  addresses?: string[];
  encrypted?: boolean;
};
type Pairing = {
  nonce: string;
  code: string;
  expiresAt: number;
  addresses: string[];
  port: number;
};
type Devices = {
  devices: Array<{
    id: string;
    name: string;
    pairedAt: number;
    revoked: boolean;
  }>;
  pending: Array<{ id: string; name: string; expiresAt: number }>;
};

function HarnessEditor({
  harness,
  diagnosis,
  policy,
  onSavePolicy,
  onAfterMutate,
}: {
  harness: Harness;
  diagnosis?: Diagnosis;
  policy?: { read?: string; write?: string };
  onSavePolicy: (harnessId: string, read: string, write: string) => Promise<void>;
  onAfterMutate: () => Promise<void>;
}) {
  const [command, setCommand] = useState(harness.command);
  const [args, setArgs] = useState(harness.args.join("\n"));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setCommand(harness.command);
    setArgs(harness.args.join("\n"));
  }, [harness.id, harness.command, harness.args]);

  const verdictLabel =
    diagnosis?.verdict === "ready"
      ? "就绪"
      : diagnosis?.verdict === "needs_auth"
        ? "需命令行登录"
        : diagnosis?.verdict === "needs_config"
          ? "需模型配置"
          : diagnosis?.verdict === "missing_binary"
            ? "未定位程序"
            : harness.installed
              ? "程序可定位"
              : "未找到启动程序";
  const isCustom = harness.id.startsWith("acp:custom-");

  return (
    <form
      className="agent-harness-config"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void useAgentStore
          .getState()
          .command("harness.save", {
            ...harness,
            command: command.trim(),
            args: args
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          })
          .then(onAfterMutate)
          .then(() => toast.success(`已保存 ${harness.displayName} 启动配置`))
          .catch((e) => useAgentStore.getState().report(e))
          .finally(() => setSaving(false));
      }}
    >
      <div className="flex items-center gap-2">
        <strong>{harness.displayName}</strong>
        <span className="text-[10px] text-muted-foreground">
          {harness.kind === "nativePi" ? "Pi 原生协议" : "独立 ACP 代理"}
        </span>
        <span className="flex-1" />
        <small
          className={
            diagnosis?.verdict === "ready"
              ? "text-green-600"
              : diagnosis?.verdict === "missing_binary"
                ? "text-destructive"
                : "text-amber-500"
          }
        >
          {verdictLabel}
        </small>
      </div>
      {diagnosis?.resolvedPath && (
        <div className="text-[10px] text-muted-foreground">
          实际执行：{diagnosis.resolvedPath}
        </div>
      )}
      {diagnosis?.hints?.map((hint, i) => (
        <div key={i} className="rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground">
          {hint}
        </div>
      ))}
      <label htmlFor={`harness-command-${harness.id}`}>
        程序或完整路径
        <Input
          id={`harness-command-${harness.id}`}
          aria-label={`${harness.displayName} 启动程序`}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          className="h-8 text-xs!"
        />
      </label>
      <label>
        参数，每行一个
        <textarea
          aria-label={`${harness.displayName} 参数`}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          rows={Math.min(5, Math.max(2, args.split("\n").length))}
        />
      </label>
      {harness.kind === "acp" && (
        <div className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1.5 text-[11px]">
          <span className="text-muted-foreground">ACP 宿主写文件策略</span>
          <select
            aria-label={`${harness.displayName} 写文件策略`}
            value={policy?.write ?? "ask"}
            onChange={(e) =>
              void onSavePolicy(harness.id, policy?.read ?? "allow", e.target.value)
            }
            className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
          >
            <option value="ask">每次询问确认（推荐）</option>
            <option value="allow">允许直接写入工作区</option>
            <option value="deny">禁止代理写文件</option>
          </select>
        </div>
      )}
      <div className="flex items-center gap-2">
        <p>沿用该命令行程序自己的登录与配置。保存后请重新连接空闲会话。</p>
        {isCustom ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={() =>
              void useAgentStore
                .getState()
                .command("harness.delete", { id: harness.id })
                .then(onAfterMutate)
                .catch((e) => useAgentStore.getState().report(e))
            }
          >
            删除
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              void useAgentStore
                .getState()
                .command("harness.reset", { id: harness.id })
                .then(onAfterMutate)
                .then(() => toast.success(`已恢复 ${harness.displayName} 默认命令`))
                .catch((e) => useAgentStore.getState().report(e))
            }
          >
            恢复默认
          </Button>
        )}
        <Button type="submit" size="sm" variant="outline" disabled={saving}>
          保存
        </Button>
      </div>
    </form>
  );
}
export function AgentSettings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const harnesses = useAgentStore((s) => s.harnesses);
  const workspaces = useAgentStore((s) => s.workspaces);
  const activeWorkspaceId = useAgentStore((s) => s.workspaceId);
  const [panel, setPanel] = useState<"harnesses" | "config" | "remote" | "voice">(
    "harnesses",
  );
  const [remote, setRemote] = useState<Remote>({ enabled: false });
  const [port, setPort] = useState("7331");
  const [devices, setDevices] = useState<Devices>({ devices: [], pending: [] });
  const [diagnoses, setDiagnoses] = useState<Record<string, Diagnosis>>({});
  const [policies, setPolicies] = useState<PolicyMap>({});
  const [trustedExt, setTrustedExt] = useState<Record<string, boolean>>({});
  const [docsInfo, setDocsInfo] = useState<DocsInfo | null>(null);
  const [piAppendDraft, setPiAppendDraft] = useState("");
  const [codexAgentsDraft, setCodexAgentsDraft] = useState("");
  const [notifyOn, setNotifyOn] = useState(agentNotifyEnabled);
  const [pair, setPair] = useState<Pairing | null>(null);
  const [qr, setQr] = useState("");
  const [address, setAddress] = useState("");
  const [custom, setCustom] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const report = useAgentStore.getState().report;
  const refresh = useCallback(async () => {
    try {
      const [remote, devices, diag, pol] = await Promise.all([
        useAgentStore.getState().command<Remote>("host.remote.status"),
        useAgentStore.getState().command<Devices>("host.devices"),
        useAgentStore
          .getState()
          .command<{ items?: Diagnosis[] }>("harness.diagnose"),
        useAgentStore
          .getState()
          .command<{ policies?: PolicyMap; trustedPiExtensions?: Record<string, boolean> }>(
            "host.policy.get",
          ),
      ]);
      setRemote(remote);
      setDevices(devices);
      setDiagnoses(
        Object.fromEntries((diag?.items ?? []).map((item) => [item.id, item])),
      );
      setPolicies(pol?.policies ?? {});
      setTrustedExt(pol?.trustedPiExtensions ?? {});
    } catch (e) {
      report(e);
    }
  }, [report]);
  const loadDocs = useCallback(async () => {
    try {
      const docs = await useAgentStore.getState().command<DocsInfo>("harness.docs.read");
      setDocsInfo(docs);
      setPiAppendDraft(docs.piAppendSystem);
      setCodexAgentsDraft(docs.codexAgents);
    } catch (e) {
      report(e);
    }
  }, [report]);
  useEffect(() => {
    if (!open) return;
    void refresh();
    if (panel === "config") void loadDocs();
    const timer = setInterval(() => {
      if (panel === "remote") void refresh();
    }, 2500);
    return () => clearInterval(timer);
  }, [open, panel, refresh, loadDocs]);
  useEffect(() => {
    if (!pair || !address) {
      setQr("");
      return;
    }
    let live = true;
    const link = `${address.replace(/\/$/, "")}/mobile.html#nonce=${encodeURIComponent(pair.nonce)}`;
    void import("qrcode")
      .then((module) => module.toDataURL(link, { width: 180, margin: 1 }))
      .then((url) => {
        if (live) setQr(url);
      })
      .catch(report);
    return () => {
      live = false;
    };
  }, [pair, address, report]);
  const act = async (operation: string, payload: unknown = {}) => {
    try {
      await useAgentStore.getState().command(operation, payload);
      await refresh();
    } catch (e) {
      report(e);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="agent-settings-dialog sm:max-w-3xl">
        <DialogTitle>Agent 主机设置</DialogTitle>
        <DialogDescription>
          代理运行、会话状态和手机连接由同一个 Rust 主机管理。
        </DialogDescription>
        <div className="flex gap-2 border-b border-border pb-2">
          <Button
            size="sm"
            variant={panel === "harnesses" ? "secondary" : "ghost"}
            onClick={() => setPanel("harnesses")}
          >
            代理与诊断
          </Button>
          <Button
            size="sm"
            variant={panel === "config" ? "secondary" : "ghost"}
            onClick={() => setPanel("config")}
          >
            规则与通知
          </Button>
          <Button
            size="sm"
            variant={panel === "remote" ? "secondary" : "ghost"}
            onClick={() => setPanel("remote")}
          >
            手机连接
          </Button>
          <Button
            size="sm"
            variant={panel === "voice" ? "secondary" : "ghost"}
            onClick={() => setPanel("voice")}
          >
            语音
          </Button>
        </div>
        <div className="agent-settings-body reader-scrollbar">
          {panel === "harnesses" ? (
            <>
              <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
                <p className="text-[11px] text-muted-foreground">
                  Pi 直接运行原生进程；Codex / Antigravity / 自定义 ACP 独立运行，互不混用模型。
                </p>
                <Button size="sm" variant="outline" onClick={() => void refresh()}>
                  重新自检
                </Button>
              </div>
              {harnesses.map((harness) => (
                <HarnessEditor
                  key={harness.id}
                  harness={harness}
                  diagnosis={diagnoses[harness.id]}
                  policy={policies[harness.id]}
                  onSavePolicy={async (harnessId, read, write) => {
                    await act("host.policy.set", { harnessId, read, write });
                    toast.success("已更新文件策略");
                  }}
                  onAfterMutate={refresh}
                />
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCustom(!custom)}
              >
                添加自定义 ACP 代理
              </Button>
              {custom && (
                <form
                  className="agent-harness-config"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const id = `acp:custom-${crypto.randomUUID().slice(0, 8)}`;
                    void act("harness.save", {
                      id,
                      displayName: customName,
                      kind: "acp",
                      command: customCommand,
                      args: [],
                      installed: false,
                      capabilities: {},
                    }).then(() => setCustom(false));
                  }}
                >
                  <Input
                    required
                    aria-label="代理名称"
                    placeholder="代理名称"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                  />
                  <Input
                    required
                    aria-label="ACP 程序路径"
                    placeholder="能直接以标准输入输出通信的 ACP 程序"
                    value={customCommand}
                    onChange={(e) => setCustomCommand(e.target.value)}
                  />
                  <Button type="submit" size="sm">
                    添加
                  </Button>
                </form>
              )}
            </>
          ) : panel === "config" ? (
            <div className="space-y-4">
              <div className="agent-setting-row">
                <div>
                  <strong>回合结束系统桌面通知</strong>
                  <p>
                    当窗口在后台或最小化时，代理任务完成或失败发送系统提醒。
                  </p>
                </div>
                <Switch
                  checked={notifyOn}
                  onCheckedChange={(checked) => {
                    setNotifyOn(checked);
                    setAgentNotifyEnabled(checked);
                  }}
                />
              </div>
              {activeWorkspaceId && (() => {
                const ws = workspaces.find((w) => w.id === activeWorkspaceId);
                if (!ws) return null;
                return (
                  <div className="agent-setting-row">
                    <div>
                      <strong>信任当前工作区扩展（.pi/extensions）</strong>
                      <p>
                        仅在你信任当前仓库代码时开启（{ws.cwd}）。
                      </p>
                    </div>
                    <Switch
                      checked={!!trustedExt[ws.cwd]}
                      onCheckedChange={(checked) =>
                        void act("host.policy.set", {
                          trustWorkspaceCwd: ws.cwd,
                          trusted: checked,
                        })
                      }
                    />
                  </div>
                );
              })()}
              <div className="agent-harness-config">
                <strong>Pi 原生全局指令与模型来源</strong>
                <small>
                  路径：{docsInfo?.piModelsPath || "~/.pi/agent/models.json"}（
                  {docsInfo?.piModelsProviders?.length
                    ? `已配置 Provider：${docsInfo.piModelsProviders.join("、")}`
                    : "未检测到自定义 models.json，使用 Pi CLI 默认登录/模型"}
                  ）
                </small>
                <label>
                  APPEND_SYSTEM.md（{docsInfo?.piAppendSystemPath}）
                  <textarea
                    rows={5}
                    value={piAppendDraft}
                    onChange={(e) => setPiAppendDraft(e.target.value)}
                    placeholder="为 Pi 原生代理追加全局系统指令…"
                  />
                </label>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void act("harness.docs.save", {
                        target: "piAppendSystem",
                        content: piAppendDraft,
                      }).then(() => toast.success("已保存 Pi APPEND_SYSTEM.md"))
                    }
                  >
                    保存 Pi 全局指令
                  </Button>
                </div>
              </div>
              <div className="agent-harness-config">
                <strong>Codex 全局指令（AGENTS.md）</strong>
                <small>
                  路径：{docsInfo?.codexAgentsPath}（仅影响 Codex CLI，从 ~/.codex/sessions 导入的旧历史保持只读浏览）
                </small>
                <label>
                  Codex AGENTS.md 内容
                  <textarea
                    rows={5}
                    value={codexAgentsDraft}
                    onChange={(e) => setCodexAgentsDraft(e.target.value)}
                    placeholder="填写 ~/.codex/AGENTS.md 全局规范…"
                  />
                </label>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void act("harness.docs.save", {
                        target: "codexAgents",
                        content: codexAgentsDraft,
                      }).then(() => toast.success("已保存 Codex AGENTS.md"))
                    }
                  >
                    保存 Codex AGENTS.md
                  </Button>
                </div>
              </div>
            </div>
          ) : panel === "voice" ? (
            <VoiceSettingsPanel embedded />
          ) : (
            <>
              <div className="agent-setting-row">
                <div>
                  <strong>允许手机连接</strong>
                  <p>
                    默认只监听本机。开启后监听局域网地址；应用退出后连接停止。
                  </p>
                </div>
                <Switch
                  checked={remote.enabled}
                  onCheckedChange={(enabled) =>
                    void act(
                      enabled ? "host.remote.enable" : "host.remote.disable",
                      enabled ? { port: Number(port) } : {},
                    )
                  }
                />
              </div>
              {!remote.enabled && (
                <label className="agent-port" htmlFor="agent-remote-port">
                  端口
                  <Input
                    id="agent-remote-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    className="h-8 w-28"
                  />
                </label>
              )}
              {remote.enabled && (
                <>
                  <p className="agent-settings-note">
                    当前为局域网 HTTP 连接。公网访问请通过 HTTPS
                    入口或安全隧道；不要把本机端口直接暴露到公网。
                  </p>
                  <div className="agent-remote-address">
                    {remote.addresses?.map((url) => (
                      <code key={url}>{url}/mobile.html</code>
                    ))}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void useAgentStore
                        .getState()
                        .command<Pairing>("host.pair.start")
                        .then((pair) => {
                          setPair(pair);
                          setAddress(
                            pair.addresses.find(
                              (url) => !url.includes("127.0.0.1"),
                            ) ??
                              pair.addresses[0] ??
                              "",
                          );
                        })
                        .catch(report)
                    }
                  >
                    生成一次性配对码
                  </Button>
                  {pair && (
                    <div className="agent-pair">
                      <div>
                        {qr && (
                          <img
                            src={qr}
                            alt="用手机扫描连接二维码"
                            width={180}
                            height={180}
                          />
                        )}
                      </div>
                      <div>
                        <strong className="agent-pair-code">{pair.code}</strong>
                        <p>
                          手机扫码后输入此验证码，再在桌面批准设备。有效期至{" "}
                          {new Date(pair.expiresAt * 1000).toLocaleTimeString()}
                          。
                        </p>
                        <label htmlFor="agent-pair-address">
                          手机可访问的主机地址
                          <Input
                            id="agent-pair-address"
                            value={address}
                            onChange={(e) => setAddress(e.target.value)}
                            placeholder="http://电脑局域网地址:7331"
                            aria-label="手机可访问的主机地址"
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </>
              )}
              {devices.pending.map((device) => (
                <div className="agent-setting-row" key={device.id}>
                  <span>{device.name} 请求连接</span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() =>
                        void act("host.device.approve", { id: device.id })
                      }
                    >
                      允许
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void act("host.device.deny", { id: device.id })
                      }
                    >
                      拒绝
                    </Button>
                  </div>
                </div>
              ))}
              <h3 className="mt-4 text-xs font-medium">已配对设备</h3>
              {devices.devices
                .filter((d) => !d.revoked)
                .map((device) => (
                  <div className="agent-setting-row" key={device.id}>
                    <span>
                      {device.name}
                      <small>
                        {new Date(device.pairedAt * 1000).toLocaleString()}
                      </small>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void act("host.device.revoke", { id: device.id })
                      }
                    >
                      撤销授权
                    </Button>
                  </div>
                ))}
              {!devices.devices.some((d) => !d.revoked) && (
                <p className="agent-settings-note">暂无已配对设备。</p>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
