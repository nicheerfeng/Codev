import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Settings01Icon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { VoiceSettingsPanel } from "@/modules/voice/VoiceSettingsPanel";
import {
  HarnessGeneralPanel,
  RemoteSettingsPanel,
  verdictMeta,
  type Diagnosis,
  type PairedDevices as Devices,
  type PairingInfo as Pairing,
  type PolicyMap,
  type RemoteStatus as Remote,
} from "./AgentSettingsPanels";
import { HarnessAssetsPanel } from "./HarnessAssetsPanel";
import { HarnessIcon } from "./HarnessIcon";
import { HarnessModelsPanel } from "./HarnessModelsPanel";
import { agentNotifyEnabled, setAgentNotifyEnabled } from "./notify";
import { PiAssetsPanel } from "./PiAssetsPanel";
import { PiModelsPanel } from "./PiModelsPanel";
import {
  SettingCard,
  SettingRow,
  SettingSectionHeader,
} from "./SettingPrimitives";
import { useAgentStore } from "./store";

type DocsInfo = {
  piAppendSystemPath: string;
  piAppendSystem: string;
  piModelsPath: string;
  piModelsProviders: string[];
  codexAgentsPath: string;
  codexAgents: string;
  antigravityAgentsPath: string;
  antigravityAgents: string;
};

type HarnessTab = "general" | "models" | "skills" | "plugins";
type GeneralTab = "prefs" | "voice" | "remote";

const HARNESS_PANELS = [
  { id: "pi", label: "Pi" },
  { id: "acp:codex", label: "Codex" },
  { id: "acp:antigravity", label: "Antigravity" },
] as const;

const HARNESS_TABS: ReadonlyArray<readonly [HarnessTab, string]> = [
  ["general", "通用"],
  ["models", "模型"],
  ["skills", "技能"],
  ["plugins", "插件"],
];

const GENERAL_TABS: ReadonlyArray<readonly [GeneralTab, string]> = [
  ["prefs", "偏好"],
  ["voice", "语音"],
  ["remote", "手机连接"],
];

export function AgentSettings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const harnesses = useAgentStore((s) => s.harnesses);
  const quickHarnesses = useAgentStore((s) => s.quickHarnesses);
  const setQuickHarnesses = useAgentStore((s) => s.setQuickHarnesses);
  const [panel, setPanel] = useState("pi");
  const [piTab, setPiTab] = useState<HarnessTab>("general");
  const [generalTab, setGeneralTab] = useState<GeneralTab>("prefs");
  const [acpTabs, setAcpTabs] = useState<Record<string, HarnessTab>>({});
  const [modelsOpened, setModelsOpened] = useState(false);
  const [modelsDirty, setModelsDirty] = useState(false);
  const [acpModelsDirty, setAcpModelsDirty] = useState(false);
  const [voiceOpened, setVoiceOpened] = useState(false);
  const [voiceDirty, setVoiceDirty] = useState(false);
  const [piVersion, setPiVersion] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [remote, setRemote] = useState<Remote>({ enabled: false });
  const [port, setPort] = useState("7331");
  const [devices, setDevices] = useState<Devices>({ devices: [], pending: [] });
  const [diagnoses, setDiagnoses] = useState<Record<string, Diagnosis>>({});
  const [policies, setPolicies] = useState<PolicyMap>({});
  const [docsInfo, setDocsInfo] = useState<DocsInfo | null>(null);
  const [piAppendDraft, setPiAppendDraft] = useState("");
  const [codexAgentsDraft, setCodexAgentsDraft] = useState("");
  const [antigravityAgentsDraft, setAntigravityAgentsDraft] = useState("");
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
        }>("host.policy.get"),
      ]);
      setRemote(remote);
      setDevices(devices);
      setDiagnoses(
        Object.fromEntries((diag?.items ?? []).map((item) => [item.id, item])),
      );
      setPolicies(pol?.policies ?? {});
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
      setAntigravityAgentsDraft(docs.antigravityAgents);
    } catch (e) {
      setSettingsError(String(e));
      report(e);
    }
  }, [report]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSettingsError("");
    setDocsInfo(null);
    setDiagnoses({});
    setPiVersion("正在读取…");
    void refresh();
    void loadDocs();
    void useAgentStore
      .getState()
      .command<{ version: string }>("pi.version")
      .then((result) => {
        if (!cancelled) setPiVersion(result.version || "未知版本");
      })
      .catch((error) => {
        if (!cancelled)
          setPiVersion(
            `读取失败：${error instanceof Error ? error.message : String(error)}`,
          );
      });
    return () => {
      cancelled = true;
    };
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
        codexAgentsDraft !== docsInfo.codexAgents ||
        antigravityAgentsDraft !== docsInfo.antigravityAgents);
    if (
      (modelsDirty || acpModelsDirty || voiceDirty || docsDirty) &&
      !window.confirm("有未保存的设置，确定关闭？")
    )
      return;
    setModelsDirty(false);
    setAcpModelsDirty(false);
    setVoiceDirty(false);
    onClose();
  };

  const saveDocument = async (
    target: "piAppendSystem" | "codexAgents" | "antigravityAgents",
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

  const isHarnessPanel =
    panel === "pi" || panel === "acp:codex" || panel === "acp:antigravity";
  const activeTab: HarnessTab =
    panel === "pi" ? piTab : (acpTabs[panel] ?? "general");

  const headerInfo = (() => {
    switch (panel) {
      case "pi":
        return { title: "Pi", subtitle: "原生 RPC 与扩展生态配置" };
      case "acp:codex":
        return { title: "Codex", subtitle: "OpenAI Codex CLI (ACP)" };
      case "acp:antigravity":
        return {
          title: "Antigravity",
          subtitle: "Google Antigravity CLI (ACP)",
        };
      case "general":
        return {
          title: "通用设置",
          subtitle: "桌面通知、语音配置与手机连接",
        };
      default:
        return { title: "Agent 设置", subtitle: "" };
    }
  })();

  const activeDevices = devices.devices.filter((d) => !d.revoked);

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogContent className="agent-settings-dialog sm:max-w-5xl">
        <DialogTitle className="sr-only">Agent 设置</DialogTitle>
        <DialogDescription className="sr-only">
          配置代理、项目和工作区。
        </DialogDescription>
        <div className="agent-settings-layout">
          <nav
            className="agent-settings-nav reader-scrollbar"
            aria-label="Agent 设置导航"
          >
            <div className="agent-settings-brand">
              <h2>Agent 设置</h2>
              <p>代理 · 工作区</p>
            </div>

            <div className="agent-settings-nav-section">
              <span className="agent-settings-nav-label">代理</span>
              {HARNESS_PANELS.map(({ id, label }) => {
                const selected = panel === id;
                const diag = diagnoses[id];
                return (
                  <Button
                    key={id}
                    size="sm"
                    variant={selected ? "secondary" : "ghost"}
                    className={cn(
                      "w-full justify-start gap-2 px-2.5 text-xs",
                      selected
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                    onClick={() => setPanel(id)}
                  >
                    <HarnessIcon harnessId={id} size={15} />
                    <span className="flex-1 truncate text-left">{label}</span>
                    {diag && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          verdictMeta(diag).dot,
                        )}
                      />
                    )}
                  </Button>
                );
              })}
            </div>

            <div className="agent-settings-nav-section">
              <span className="agent-settings-nav-label">工作区</span>
              <Button
                size="sm"
                variant={panel === "general" ? "secondary" : "ghost"}
                className={cn(
                  "w-full justify-start gap-2 px-2.5 text-xs",
                  panel === "general"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
                onClick={() => {
                  setPanel("general");
                  setVoiceOpened(true);
                }}
              >
                <HugeiconsIcon icon={Settings01Icon} size={15} />
                <span className="flex-1 truncate text-left">通用</span>
                {remote.enabled && (
                  <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                )}
              </Button>
            </div>
          </nav>

          <div className="agent-settings-main">
            <header className="agent-settings-header">
              {isHarnessPanel && (
                <div
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-border/75 bg-muted/40 p-0.5"
                  role="tablist"
                  aria-label={`${headerInfo.title} 设置`}
                >
                  {HARNESS_TABS.map(([id, label]) => {
                    const selected = activeTab === id;
                    return (
                      <Button
                        key={id}
                        role="tab"
                        aria-selected={selected}
                        size="xs"
                        variant={selected ? "secondary" : "ghost"}
                        className={cn(
                          "px-2.5 text-xs",
                          selected
                            ? "font-medium shadow-xs"
                            : "text-muted-foreground",
                        )}
                        onClick={() => {
                          if (panel === "pi") {
                            setPiTab(id);
                            if (id === "models") setModelsOpened(true);
                          } else {
                            setAcpTabs((current) => ({
                              ...current,
                              [panel]: id,
                            }));
                          }
                        }}
                      >
                        {label}
                      </Button>
                    );
                  })}
                </div>
              )}

              {panel === "general" && (
                <div
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-border/75 bg-muted/40 p-0.5"
                  role="tablist"
                  aria-label="通用设置"
                >
                  {GENERAL_TABS.map(([id, label]) => {
                    const selected = generalTab === id;
                    return (
                      <Button
                        key={id}
                        role="tab"
                        aria-selected={selected}
                        size="xs"
                        variant={selected ? "secondary" : "ghost"}
                        className={cn(
                          "px-2.5 text-xs",
                          selected
                            ? "font-medium shadow-xs"
                            : "text-muted-foreground",
                        )}
                        onClick={() => {
                          setGeneralTab(id);
                          if (id === "voice") setVoiceOpened(true);
                        }}
                      >
                        {label}
                      </Button>
                    );
                  })}
                </div>
              )}

              <div className="flex min-w-0 items-center gap-2.5">
                {isHarnessPanel && <HarnessIcon harnessId={panel} size={18} />}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h1 className="truncate text-sm font-semibold text-foreground">
                      {headerInfo.title}
                    </h1>
                    {isHarnessPanel && diagnoses[panel] && (
                      <span
                        className={cn(
                          "hidden sm:inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[10px] font-medium",
                          verdictMeta(diagnoses[panel]).pill,
                        )}
                      >
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            verdictMeta(diagnoses[panel]).dot,
                          )}
                        />
                        {verdictMeta(diagnoses[panel]).label}
                      </span>
                    )}
                  </div>
                  {headerInfo.subtitle && (
                    <p className="truncate text-[11px] text-muted-foreground">
                      {headerInfo.subtitle}
                    </p>
                  )}
                </div>
              </div>
            </header>

            <div className="agent-settings-body reader-scrollbar">
              <div className="agent-settings-content">
                {settingsError && (
                  <div
                    role="alert"
                    className="agent-global-error rounded-xl border border-destructive/30"
                  >
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

                {(panel === "acp:codex" || panel === "acp:antigravity") &&
                  acpTabs[panel] === "models" && (
                    <HarnessModelsPanel
                      key={panel}
                      harnessId={panel}
                      onDirtyChange={setAcpModelsDirty}
                    />
                  )}
                {(panel === "acp:codex" || panel === "acp:antigravity") &&
                  (acpTabs[panel] === "skills" ||
                    acpTabs[panel] === "plugins") && (
                    <HarnessAssetsPanel
                      key={`${panel}:${acpTabs[panel]}`}
                      harnessId={panel}
                      kind={acpTabs[panel]}
                    />
                  )}
                {open && modelsOpened && (
                  <div hidden={panel !== "pi" || piTab !== "models"}>
                    <PiModelsPanel onDirtyChange={setModelsDirty} />
                  </div>
                )}
                {panel === "pi" &&
                  (piTab === "skills" || piTab === "plugins") && (
                    <PiAssetsPanel kind={piTab} />
                  )}

                {HARNESS_PANELS.map(({ id, label }) => {
                  const harness = harnesses.find((item) => item.id === id) ?? {
                    id,
                    displayName: label,
                    kind:
                      id === "pi" ? ("nativePi" as const) : ("acp" as const),
                    installed: diagnoses[id]?.installed ?? false,
                    supportsResume: true,
                    supportsModels: true,
                    supportsThinking: id !== "acp:antigravity",
                  };
                  const docConfig =
                    harness.id === "pi"
                      ? {
                          id: "agent-pi-instructions",
                          label: "Pi 全局追加指令",
                          path: docsInfo?.piAppendSystemPath,
                          value: piAppendDraft,
                          savedValue: docsInfo?.piAppendSystem,
                          disabled: !docsInfo,
                          onChange: setPiAppendDraft,
                          onSave: () =>
                            void saveDocument("piAppendSystem", piAppendDraft),
                        }
                      : harness.id === "acp:codex"
                        ? {
                            id: "agent-codex-instructions",
                            label: "Codex 全局指令",
                            path: docsInfo?.codexAgentsPath,
                            value: codexAgentsDraft,
                            savedValue: docsInfo?.codexAgents,
                            disabled: !docsInfo,
                            onChange: setCodexAgentsDraft,
                            onSave: () =>
                              void saveDocument(
                                "codexAgents",
                                codexAgentsDraft,
                              ),
                          }
                        : {
                            id: "agent-antigravity-instructions",
                            label: "Antigravity 全局指令",
                            path: docsInfo?.antigravityAgentsPath,
                            value: antigravityAgentsDraft,
                            savedValue: docsInfo?.antigravityAgents,
                            disabled: !docsInfo,
                            onChange: setAntigravityAgentsDraft,
                            onSave: () =>
                              void saveDocument(
                                "antigravityAgents",
                                antigravityAgentsDraft,
                              ),
                          };
                  const isVisible =
                    panel === harness.id &&
                    (harness.id === "pi"
                      ? piTab === "general"
                      : (acpTabs[harness.id] ?? "general") === "general");
                  if (!isVisible) return null;
                  return (
                    <div key={harness.id}>
                      <HarnessGeneralPanel
                        harness={harness}
                        diagnosis={diagnoses[harness.id]}
                        policy={policies[harness.id]}
                        piVersion={piVersion}
                        quickCreateEnabled={quickHarnesses.includes(harness.id)}
                        onToggleQuickCreate={(enabled) => {
                          const next = enabled
                            ? Array.from(
                                new Set([...quickHarnesses, harness.id]),
                              )
                            : quickHarnesses.filter(
                                (item) => item !== harness.id,
                              );
                          void setQuickHarnesses(next).catch(showError);
                        }}
                        docConfig={docConfig}
                        onSavePolicy={async (harnessId, patch) => {
                          if (
                            await act("host.policy.set", {
                              harnessId,
                              ...patch,
                            })
                          )
                            toast.success("已更新代理权限策略");
                        }}
                      />
                    </div>
                  );
                })}

                {panel === "general" && generalTab === "prefs" && (
                  <section className="space-y-4">
                    <SettingSectionHeader
                      title="工作区偏好"
                      description="管理桌面端通知等全局行为。"
                    />
                    <SettingCard>
                      <SettingRow
                        htmlFor="agent-notify-switch"
                        title="回合结束系统桌面通知"
                        description="当 Agent 完成当前回合且窗口未聚焦时发送系统通知提醒。"
                        control={
                          <Switch
                            id="agent-notify-switch"
                            checked={notifyOn}
                            onCheckedChange={(checked) => {
                              setNotifyOn(checked);
                              setAgentNotifyEnabled(checked);
                            }}
                          />
                        }
                      />
                    </SettingCard>
                  </section>
                )}

                {open && voiceOpened && (
                  <div hidden={panel !== "general" || generalTab !== "voice"}>
                    <VoiceSettingsPanel
                      embedded
                      onDirtyChange={setVoiceDirty}
                    />
                  </div>
                )}

                {panel === "general" && generalTab === "remote" && (
                  <RemoteSettingsPanel
                    remote={remote}
                    port={port}
                    pair={pair}
                    qr={qr}
                    address={address}
                    devices={devices}
                    activeDevices={activeDevices}
                    onPortChange={setPort}
                    onAddressChange={setAddress}
                    onStartPair={() =>
                      void useAgentStore
                        .getState()
                        .command<Pairing>("host.pair.start")
                        .then((nextPair) => {
                          setPair(nextPair);
                          setAddress(
                            nextPair.addresses.find(
                              (url) => !url.includes("127.0.0.1"),
                            ) ??
                              nextPair.addresses[0] ??
                              "",
                          );
                        })
                        .catch(showError)
                    }
                    onRefreshStatus={() => void refresh()}
                    onReset={() => {
                      if (
                        !window.confirm(
                          "确定停止手机连接服务并清空所有已配对设备与配置？",
                        )
                      )
                        return;
                      void act("host.remote.reset").then((ok) => {
                        if (!ok) return;
                        setPair(null);
                        setQr("");
                        setAddress("");
                        setPort("7331");
                        toast.success("已清空手机连接配置");
                      });
                    }}
                    onAct={act}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
