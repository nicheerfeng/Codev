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
import { PiModelsPanel } from "./PiModelsPanel";
import { PiAssetsPanel } from "./PiAssetsPanel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
}: {
  harness: Harness;
  diagnosis?: Diagnosis;
  policy?: { read?: string; write?: string };
  onSavePolicy: (
    harnessId: string,
    read: string,
    write: string,
  ) => Promise<void>;
}) {
  const verdictLabel =
    diagnosis?.verdict === "ready"
      ? "程序已定位"
      : diagnosis?.verdict === "needs_auth"
        ? "未检测到常见凭据"
        : diagnosis?.verdict === "needs_config"
          ? "未检测到 models.json"
          : diagnosis?.verdict === "missing_binary"
            ? "未定位程序"
            : harness.installed
              ? "程序可定位"
              : "未找到启动程序";
  return (
    <div className="agent-harness-details">
      <div className="agent-setting-row">
        <strong>{harness.displayName}</strong>
        <span>{verdictLabel}</span>
      </div>
      {harness.kind === "acp" && (
        <div className="agent-setting-row">
          <span>ACP 宿主写文件策略</span>
          <Select
            value={policy?.write ?? "allow"}
            onValueChange={(value) =>
              void onSavePolicy(harness.id, policy?.read ?? "allow", value)
            }
          >
            <SelectTrigger
              size="sm"
              aria-label={`${harness.displayName} 写文件策略`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="allow">最大权限（自动允许写入）</SelectItem>
              <SelectItem value="ask">执行前询问</SelectItem>
              <SelectItem value="deny">禁止代理写入</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {diagnosis?.hints?.length ? (
        <div className="agent-settings-note">{diagnosis.hints[0]}</div>
      ) : null}
    </div>
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
  const projectHarnesses = useAgentStore((s) => s.projectHarnesses);
  const setProjectHarnesses = useAgentStore((s) => s.setProjectHarnesses);
  const [panel, setPanel] = useState("pi");
  const [piTab, setPiTab] = useState<
    "general" | "models" | "skills" | "plugins"
  >("general");
  const [modelsOpened, setModelsOpened] = useState(false);
  const [modelsDirty, setModelsDirty] = useState(false);
  const [voiceOpened, setVoiceOpened] = useState(false);
  const [voiceDirty, setVoiceDirty] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [savingProject, setSavingProject] = useState(false);
  const [piVersion, setPiVersion] = useState("");
  const [settingsError, setSettingsError] = useState("");
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
  const report = useAgentStore.getState().report;
  const showError = useCallback(
    (error: unknown) => {
      setSettingsError(String(error));
      report(error);
    },
    [report],
  );
  const refresh = useCallback(async () => {
    try {
      const [remote, devices, diag, pol] = await Promise.all([
        useAgentStore.getState().command<Remote>("host.remote.status"),
        useAgentStore.getState().command<Devices>("host.devices"),
        useAgentStore
          .getState()
          .command<{ items?: Diagnosis[] }>("harness.diagnose"),
        useAgentStore.getState().command<{
          policies?: PolicyMap;
          trustedPiExtensions?: Record<string, boolean>;
        }>("host.policy.get"),
      ]);
      setRemote(remote);
      setDevices(devices);
      setDiagnoses(
        Object.fromEntries((diag?.items ?? []).map((item) => [item.id, item])),
      );
      setPolicies(pol?.policies ?? {});
      setTrustedExt(pol?.trustedPiExtensions ?? {});
    } catch (e) {
      setSettingsError(String(e));
      report(e);
    }
  }, [report]);
  const loadDocs = useCallback(async () => {
    try {
      const docs = await useAgentStore
        .getState()
        .command<DocsInfo>("harness.docs.read");
      setDocsInfo(docs);
      setPiAppendDraft(docs.piAppendSystem);
      setCodexAgentsDraft(docs.codexAgents);
    } catch (e) {
      setSettingsError(String(e));
      report(e);
    }
  }, [report]);
  useEffect(() => {
    if (!open) return;
    setSettingsError("");
    setDocsInfo(null);
    void refresh();
    void loadDocs();
  }, [open, refresh, loadDocs]);
  useEffect(() => {
    if (!open || panel !== "remote") return;
    const timer = setInterval(() => {
      void refresh();
    }, 2500);
    return () => clearInterval(timer);
  }, [open, panel, refresh]);
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
      .catch(showError);
    return () => {
      live = false;
    };
  }, [pair, address, showError]);
  const act = async (operation: string, payload: unknown = {}) => {
    try {
      await useAgentStore.getState().command(operation, payload);
      await refresh();
      setSettingsError("");
      return true;
    } catch (e) {
      setSettingsError(String(e));
      report(e);
      return false;
    }
  };
  const close = () => {
    const docsDirty =
      docsInfo &&
      (piAppendDraft !== docsInfo.piAppendSystem ||
        codexAgentsDraft !== docsInfo.codexAgents);
    if (
      (modelsDirty || voiceDirty || docsDirty) &&
      !window.confirm("有未保存的设置，确定关闭？")
    )
      return;
    setModelsDirty(false);
    setVoiceDirty(false);
    onClose();
  };
  const saveDocument = async (
    target: "piAppendSystem" | "codexAgents",
    content: string,
  ) => {
    if (!docsInfo) return;
    if (
      await act("harness.docs.save", {
        target,
        content,
        expected: docsInfo[target],
      })
    ) {
      setDocsInfo((value) => (value ? { ...value, [target]: content } : value));
      toast.success("已保存");
    }
  };
  const addProject = async () => {
    try {
      const { open: openDirectory } = await import("@tauri-apps/plugin-dialog");
      const cwd = await openDirectory({
        directory: true,
        multiple: false,
        title: "选择 Agent 工作目录",
      });
      if (typeof cwd === "string")
        await useAgentStore.getState().addWorkspace(cwd);
    } catch (error) {
      showError(error);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogContent className="agent-settings-dialog sm:max-w-5xl">
        <DialogTitle>Agent 设置</DialogTitle>
        <DialogDescription className="sr-only">
          配置代理、项目和工作区。
        </DialogDescription>
        <div className="agent-settings-layout">
          <nav className="agent-settings-nav" aria-label="Agent 设置导航">
            <span className="agent-settings-nav-label">代理</span>
            {[
              ["pi", "Pi"],
              ["acp:codex", "Codex"],
              ["acp:antigravity", "Antigravity"],
            ].map(([id, label]) => (
              <Button
                key={id}
                size="sm"
                variant={panel === id ? "secondary" : "ghost"}
                onClick={() => setPanel(id)}
              >
                {label}
              </Button>
            ))}
            <span className="agent-settings-nav-label">项目</span>
            <Button
              size="sm"
              variant={panel === "projects" ? "secondary" : "ghost"}
              onClick={() => setPanel("projects")}
            >
              项目配置
            </Button>
            <span className="agent-settings-nav-label">工作区</span>
            {[
              ["general", "通用"],
              ["remote", "手机连接"],
              ["voice", "语音"],
            ].map(([id, label]) => (
              <Button
                key={id}
                size="sm"
                variant={panel === id ? "secondary" : "ghost"}
                onClick={() => {
                  setPanel(id);
                  if (id === "voice") setVoiceOpened(true);
                }}
              >
                {label}
              </Button>
            ))}
          </nav>
          <div className="agent-settings-body reader-scrollbar">
            {settingsError && (
              <div role="alert" className="agent-global-error">
                <span>{settingsError}</span>
                <button
                  type="button"
                  aria-label="关闭错误"
                  onClick={() => setSettingsError("")}
                >
                  ×
                </button>
              </div>
            )}
            {panel === "pi" && (
              <>
                <div className="agent-settings-section-heading">
                  <strong>Pi</strong>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void refresh()}
                  >
                    检查环境
                  </Button>
                </div>
                <div
                  className="agent-provider-tabs"
                  role="tablist"
                  aria-label="Pi 设置"
                >
                  {(
                    [
                      ["general", "通用"],
                      ["models", "模型"],
                      ["skills", "技能"],
                      ["plugins", "插件"],
                    ] as const
                  ).map(([id, label]) => (
                    <Button
                      key={id}
                      role="tab"
                      aria-selected={piTab === id}
                      size="sm"
                      variant={piTab === id ? "secondary" : "ghost"}
                      onClick={() => {
                        setPiTab(id);
                        if (id === "models") setModelsOpened(true);
                      }}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </>
            )}
            {open && modelsOpened && (
              <div hidden={panel !== "pi" || piTab !== "models"}>
                <PiModelsPanel onDirtyChange={setModelsDirty} />
              </div>
            )}
            {panel === "pi" && (piTab === "skills" || piTab === "plugins") && (
              <PiAssetsPanel kind={piTab} />
            )}
            {harnesses
              .filter((harness) =>
                ["pi", "acp:codex", "acp:antigravity"].includes(harness.id),
              )
              .map((harness) => (
                <div
                  key={harness.id}
                  hidden={
                    panel !== harness.id ||
                    (harness.id === "pi" && piTab !== "general")
                  }
                >
                  <HarnessEditor
                    harness={harness}
                    diagnosis={diagnoses[harness.id]}
                    policy={policies[harness.id]}
                    onSavePolicy={async (harnessId, read, write) => {
                      if (
                        await act("host.policy.set", { harnessId, read, write })
                      )
                        toast.success("已更新文件策略");
                    }}
                  />
                  {harness.id === "pi" && (
                    <div className="agent-setting-row">
                      <strong>Pi 版本</strong>
                      <span>{piVersion}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void useAgentStore
                            .getState()
                            .command<{ version: string }>("pi.version")
                            .then((result) => setPiVersion(result.version))
                            .catch(showError)
                        }
                      >
                        查看版本
                      </Button>
                    </div>
                  )}
                  {harness.id === "pi" && (
                    <div className="agent-document-setting">
                      <label htmlFor="agent-pi-instructions">
                        Pi 全局追加指令
                      </label>
                      <small>{docsInfo?.piAppendSystemPath}</small>
                      <textarea
                        id="agent-pi-instructions"
                        rows={8}
                        disabled={!docsInfo}
                        value={piAppendDraft}
                        onChange={(event) =>
                          setPiAppendDraft(event.target.value)
                        }
                      />
                      <Button
                        size="sm"
                        disabled={
                          !docsInfo || piAppendDraft === docsInfo.piAppendSystem
                        }
                        onClick={() =>
                          void saveDocument("piAppendSystem", piAppendDraft)
                        }
                      >
                        保存
                      </Button>
                    </div>
                  )}
                  {harness.id === "acp:codex" && (
                    <div className="agent-document-setting">
                      <label htmlFor="agent-codex-instructions">
                        Codex 全局指令
                      </label>
                      <small>{docsInfo?.codexAgentsPath}</small>
                      <textarea
                        id="agent-codex-instructions"
                        rows={8}
                        disabled={!docsInfo}
                        value={codexAgentsDraft}
                        onChange={(event) =>
                          setCodexAgentsDraft(event.target.value)
                        }
                      />
                      <Button
                        size="sm"
                        disabled={
                          !docsInfo || codexAgentsDraft === docsInfo.codexAgents
                        }
                        onClick={() =>
                          void saveDocument("codexAgents", codexAgentsDraft)
                        }
                      >
                        保存
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            {panel === "projects" && (
              <section>
                <div className="agent-settings-section-heading">
                  <strong>项目配置</strong>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void addProject()}
                  >
                    添加项目
                  </Button>
                </div>
                {workspaces.length ? (
                  (() => {
                    const workspace =
                      workspaces.find((item) => item.id === projectId) ??
                      workspaces[0];
                    const enabled = (
                      projectHarnesses[workspace.id] ?? [
                        "pi",
                        "acp:codex",
                        "acp:antigravity",
                      ]
                    ).filter((id) =>
                      harnesses.some((harness) => harness.id === id),
                    );
                    return (
                      <>
                        <select
                          className="agent-project-select"
                          value={workspace.id}
                          onChange={(event) => setProjectId(event.target.value)}
                          aria-label="选择项目"
                        >
                          {workspaces.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.title}
                            </option>
                          ))}
                        </select>
                        <p className="agent-settings-note">{workspace.cwd}</p>
                        <div className="agent-project-settings">
                          <strong>新建线程快捷入口</strong>
                          <div className="agent-project-settings-options">
                            {harnesses.map((harness) => (
                              <label key={harness.id}>
                                <input
                                  type="checkbox"
                                  disabled={savingProject}
                                  checked={enabled.includes(harness.id)}
                                  onChange={(event) => {
                                    setSavingProject(true);
                                    void setProjectHarnesses(
                                      workspace.id,
                                      event.target.checked
                                        ? [...enabled, harness.id]
                                        : enabled.filter(
                                            (id) => id !== harness.id,
                                          ),
                                    )
                                      .catch(showError)
                                      .finally(() => setSavingProject(false));
                                  }}
                                />
                                {harness.displayName}
                              </label>
                            ))}
                          </div>
                        </div>
                        <div className="agent-setting-row">
                          <div>
                            <strong>Pi 项目信任</strong>
                            <p>
                              控制 Pi
                              是否加载此项目的设置、资源和扩展；重新连接后生效。
                            </p>
                          </div>
                          <select
                            aria-label="Pi 项目信任"
                            value={
                              trustedExt[workspace.cwd] === undefined
                                ? "default"
                                : trustedExt[workspace.cwd]
                                  ? "allow"
                                  : "deny"
                            }
                            onChange={(event) =>
                              void act("host.policy.set", {
                                trustWorkspaceCwd: workspace.cwd,
                                trusted:
                                  event.target.value === "default"
                                    ? null
                                    : event.target.value === "allow",
                              })
                            }
                          >
                            <option value="default">Pi 默认设置</option>
                            <option value="allow">信任项目</option>
                            <option value="deny">不信任项目</option>
                          </select>
                        </div>
                      </>
                    );
                  })()
                ) : (
                  <p className="agent-settings-note">暂无项目</p>
                )}
              </section>
            )}
            {panel === "general" && (
              <div className="agent-setting-row">
                <strong>回合结束系统桌面通知</strong>
                <Switch
                  checked={notifyOn}
                  onCheckedChange={(checked) => {
                    setNotifyOn(checked);
                    setAgentNotifyEnabled(checked);
                  }}
                />
              </div>
            )}
            {open && voiceOpened && (
              <div hidden={panel !== "voice"}>
                <VoiceSettingsPanel embedded onDirtyChange={setVoiceDirty} />
              </div>
            )}
            {panel === "remote" && (
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
                          .catch(showError)
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
                          <strong className="agent-pair-code">
                            {pair.code}
                          </strong>
                          <p>
                            手机扫码后输入此验证码，再在桌面批准设备。有效期至{" "}
                            {new Date(
                              pair.expiresAt * 1000,
                            ).toLocaleTimeString()}
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
