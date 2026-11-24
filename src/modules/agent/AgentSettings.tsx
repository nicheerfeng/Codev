import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Folder01Icon,
  PlusSignIcon,
  Settings01Icon,
  Tick02Icon,
  VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { VoiceSettingsPanel } from "@/modules/voice/VoiceSettingsPanel";
import { HarnessAssetsPanel } from "./HarnessAssetsPanel";
import { HarnessIcon } from "./HarnessIcon";
import { HarnessModelsPanel } from "./HarnessModelsPanel";
import { agentNotifyEnabled, setAgentNotifyEnabled } from "./notify";
import { PiAssetsPanel } from "./PiAssetsPanel";
import { PiModelsPanel } from "./PiModelsPanel";
import {
  SettingCard,
  SettingNote,
  SettingRow,
  SettingSectionHeader,
} from "./SettingPrimitives";
import { useAgentStore } from "./store";
import type { Harness } from "./types";

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

type PolicyEntry = {
  read?: string;
  write?: string;
  permission?: string;
  allowOutsideWorkspace?: boolean;
};

type PolicyMap = Record<string, PolicyEntry>;

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

type HarnessTab = "general" | "models" | "skills" | "plugins";

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

function RemotePhoneGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect x="6" y="2" width="12" height="20" rx="2.5" />
      <line x1="11" y1="18.5" x2="13" y2="18.5" />
    </svg>
  );
}

function verdictMeta(diagnosis?: Diagnosis) {
  switch (diagnosis?.verdict) {
    case "ready":
      return {
        label: "程序已定位",
        dot: "bg-emerald-500",
        pill: "border-emerald-500/35 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
      };
    case "needs_auth":
      return {
        label: "未检测到常见凭据",
        dot: "bg-amber-500",
        pill: "border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300",
      };
    case "needs_config":
      return {
        label: "未检测到 models.json",
        dot: "bg-amber-500",
        pill: "border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300",
      };
    case "missing_binary":
      return {
        label: "未定位程序",
        dot: "bg-destructive",
        pill: "border-destructive/35 bg-destructive/10 text-destructive",
      };
    default:
      return {
        label: "正在检查…",
        dot: "bg-muted-foreground/45",
        pill: "border-border/70 bg-muted/50 text-muted-foreground",
      };
  }
}

function HarnessGeneralPanel({
  harness,
  diagnosis,
  policy,
  piVersion,
  docConfig,
  onSavePolicy,
}: {
  harness: Harness;
  diagnosis?: Diagnosis;
  policy?: PolicyEntry;
  piVersion?: string;
  docConfig?: {
    id: string;
    label: string;
    path?: string;
    value: string;
    savedValue?: string;
    disabled: boolean;
    onChange: (value: string) => void;
    onSave: () => void;
  };
  onSavePolicy: (harnessId: string, patch: PolicyEntry) => Promise<void>;
}) {
  const verdict = verdictMeta(diagnosis);
  const docDirty = !!docConfig && !docConfig.disabled && docConfig.value !== (docConfig.savedValue ?? "");
  const permissionMode = policy?.permission ?? "ask";
  const allowOutside =
    policy?.allowOutsideWorkspace ?? permissionMode === "allow_all";

  return (
    <div className="space-y-4">
      <SettingCard>
        <SettingRow
          title="运行环境"
          description={
            <span className="font-mono text-[11px]">
              {diagnosis?.resolvedPath || (diagnosis ? "未找到启动程序" : "正在定位程序…")}
            </span>
          }
          control={
            <span
              className={cn(
                "inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[10px] font-medium",
                verdict.pill,
              )}
            >
              <span className={cn("size-1.5 rounded-full", verdict.dot)} />
              {verdict.label}
            </span>
          }
        />
        {harness.id === "pi" && (
          <SettingRow
            title="Pi 版本"
            description="本机已安装用于统一 Agent 宿主的 Pi CLI 版本。"
            control={
              <span className="rounded-md border border-border/70 bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground">
                {piVersion || "正在读取…"}
              </span>
            }
          />
        )}
        {harness.kind === "acp" && (
          <>
            <SettingRow
              title="工具与跨目录权限审批"
              description="控制代理发起工具调用、命令执行或跨文件夹访问确认（session/request_permission）时是否由宿主自动放行。"
              control={
                <Select
                  value={permissionMode}
                  onValueChange={(value) =>
                    void onSavePolicy(harness.id, {
                      read: policy?.read ?? "allow",
                      write: policy?.write ?? "allow",
                      permission: value,
                      allowOutsideWorkspace:
                        value === "allow_all" || value === "allow_read"
                          ? true
                          : (policy?.allowOutsideWorkspace ?? false),
                    })
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="w-56"
                    aria-label={`${harness.displayName} 工具与跨目录权限`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ask">执行前询问（默认安全）</SelectItem>
                    <SelectItem value="allow_read">
                      自动允许读取（含跨目录查文件）
                    </SelectItem>
                    <SelectItem value="allow_all">
                      全部自动允许（含命令与跨目录）
                    </SelectItem>
                    <SelectItem value="deny">自动拒绝敏感权限请求</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <SettingRow
              htmlFor={`agent-outside-ws-${harness.id}`}
              title="允许跨工作区文件读写"
              description="开启后，宿主 fs/read_text_file 与 fs/write_text_file 回调允许访问当前工作区目录之外的路径。"
              control={
                <Switch
                  id={`agent-outside-ws-${harness.id}`}
                  checked={allowOutside}
                  onCheckedChange={(checked) =>
                    void onSavePolicy(harness.id, {
                      read: policy?.read ?? "allow",
                      write: policy?.write ?? "allow",
                      permission: permissionMode,
                      allowOutsideWorkspace: checked,
                    })
                  }
                />
              }
            />
            <SettingRow
              title="ACP 宿主写文件策略"
              description="控制该代理通过 ACP fs/write_text_file 修改文件时的写入许可方式。"
              control={
                <Select
                  value={policy?.write ?? "allow"}
                  onValueChange={(value) =>
                    void onSavePolicy(harness.id, {
                      read: policy?.read ?? "allow",
                      write: value,
                      permission: permissionMode,
                      allowOutsideWorkspace: policy?.allowOutsideWorkspace ?? false,
                    })
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="w-56"
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
              }
            />
          </>
        )}
      </SettingCard>

      {diagnosis?.hints?.length ? (
        <SettingNote tone={diagnosis.verdict === "ready" ? "default" : "warning"}>
          {diagnosis.hints[0]}
        </SettingNote>
      ) : null}

      {docConfig && (
        <SettingCard>
          <SettingRow
            htmlFor={docConfig.id}
            title={
              <span className="inline-flex items-center gap-1.5">
                <span>{docConfig.label}</span>
                {docDirty && (
                  <span
                    className="size-1.5 rounded-full bg-amber-500"
                    title="未保存"
                    aria-label="未保存"
                  />
                )}
              </span>
            }
            description={
              docConfig.path ? (
                <span className="font-mono text-[10px]">{docConfig.path}</span>
              ) : undefined
            }
            control={
              <Button
                size="sm"
                variant={docDirty ? "default" : "outline"}
                disabled={docConfig.disabled || !docDirty}
                onClick={docConfig.onSave}
              >
                保存
              </Button>
            }
          >
            <Textarea
              id={docConfig.id}
              rows={8}
              disabled={docConfig.disabled}
              value={docConfig.value}
              placeholder="在此输入该代理的全局附加系统指令（Markdown）…"
              className="min-h-44 bg-background/80 font-mono text-xs leading-relaxed"
              onChange={(event) => docConfig.onChange(event.target.value)}
            />
          </SettingRow>
        </SettingCard>
      )}
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
  const [piTab, setPiTab] = useState<HarnessTab>("general");
  const [acpTabs, setAcpTabs] = useState<Record<string, HarnessTab>>({});
  const [modelsOpened, setModelsOpened] = useState(false);
  const [modelsDirty, setModelsDirty] = useState(false);
  const [acpModelsDirty, setAcpModelsDirty] = useState(false);
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
        return { title: "Antigravity", subtitle: "Google Antigravity CLI (ACP)" };
      case "projects":
        return { title: "项目配置", subtitle: "每个工作区的快捷创建入口与信任边界" };
      case "general":
        return { title: "通用设置", subtitle: "桌面通知与统一工作区行为" };
      case "remote":
        return { title: "手机连接", subtitle: "局域网移动控制与配对授权" };
      case "voice":
        return { title: "语音", subtitle: "流式语音输入与朗读配置" };
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
          <nav className="agent-settings-nav reader-scrollbar" aria-label="Agent 设置导航">
            <div className="agent-settings-brand">
              <h2>Agent 设置</h2>
              <p>代理 · 项目 · 工作区</p>
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
                      selected ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                    onClick={() => setPanel(id)}
                  >
                    <HarnessIcon harnessId={id} size={15} />
                    <span className="flex-1 truncate text-left">{label}</span>
                    {diag && (
                      <span
                        aria-hidden="true"
                        className={cn("size-1.5 shrink-0 rounded-full", verdictMeta(diag).dot)}
                      />
                    )}
                  </Button>
                );
              })}
            </div>

            <div className="agent-settings-nav-section">
              <span className="agent-settings-nav-label">项目</span>
              <Button
                size="sm"
                variant={panel === "projects" ? "secondary" : "ghost"}
                className={cn(
                  "w-full justify-start gap-2 px-2.5 text-xs",
                  panel === "projects"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
                onClick={() => setPanel("projects")}
              >
                <HugeiconsIcon icon={Folder01Icon} size={15} />
                <span className="flex-1 truncate text-left">项目配置</span>
              </Button>
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
                onClick={() => setPanel("general")}
              >
                <HugeiconsIcon icon={Settings01Icon} size={15} />
                <span className="flex-1 truncate text-left">通用</span>
              </Button>
              <Button
                size="sm"
                variant={panel === "remote" ? "secondary" : "ghost"}
                className={cn(
                  "w-full justify-start gap-2 px-2.5 text-xs",
                  panel === "remote"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
                onClick={() => setPanel("remote")}
              >
                <RemotePhoneGlyph />
                <span className="flex-1 truncate text-left">手机连接</span>
                {remote.enabled && (
                  <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                )}
              </Button>
              <Button
                size="sm"
                variant={panel === "voice" ? "secondary" : "ghost"}
                className={cn(
                  "w-full justify-start gap-2 px-2.5 text-xs",
                  panel === "voice"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
                onClick={() => {
                  setPanel("voice");
                  setVoiceOpened(true);
                }}
              >
                <HugeiconsIcon icon={VolumeHighIcon} size={15} />
                <span className="flex-1 truncate text-left">语音</span>
              </Button>
            </div>
          </nav>

          <div className="agent-settings-main">
            <header className="agent-settings-header">
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
                          selected ? "font-medium shadow-xs" : "text-muted-foreground",
                        )}
                        onClick={() => {
                          if (panel === "pi") {
                            setPiTab(id);
                            if (id === "models") setModelsOpened(true);
                          } else {
                            setAcpTabs((current) => ({ ...current, [panel]: id }));
                          }
                        }}
                      >
                        {label}
                      </Button>
                    );
                  })}
                </div>
              )}
            </header>

            <div className="agent-settings-body reader-scrollbar">
              <div className="agent-settings-content">
                {settingsError && (
                  <div role="alert" className="agent-global-error rounded-xl border border-destructive/30">
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
                  (acpTabs[panel] === "skills" || acpTabs[panel] === "plugins") && (
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
                {panel === "pi" && (piTab === "skills" || piTab === "plugins") && (
                  <PiAssetsPanel kind={piTab} />
                )}

                {harnesses
                  .filter((harness) =>
                    ["pi", "acp:codex", "acp:antigravity"].includes(harness.id),
                  )
                  .map((harness) => {
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
                                void saveDocument("codexAgents", codexAgentsDraft),
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
                    return (
                      <div
                        key={harness.id}
                        hidden={
                          panel !== harness.id ||
                          (harness.id === "pi" && piTab !== "general") ||
                          (harness.kind === "acp" &&
                            (acpTabs[harness.id] ?? "general") !== "general")
                        }
                      >
                        <HarnessGeneralPanel
                          harness={harness}
                          diagnosis={diagnoses[harness.id]}
                          policy={policies[harness.id]}
                          piVersion={piVersion}
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

                {panel === "projects" && (
                  <section className="space-y-4">
                    <SettingSectionHeader
                      title="已加载项目"
                      count={workspaces.length}
                      description="管理手动加入的 Agent 工作区目录，以及每个项目的快速创建入口与扩展信任级别。"
                      actions={
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void addProject()}
                        >
                          <HugeiconsIcon icon={PlusSignIcon} size={13} />
                          添加项目
                        </Button>
                      }
                    />
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
                        const trustValue =
                          trustedExt[workspace.cwd] === undefined
                            ? "default"
                            : trustedExt[workspace.cwd]
                              ? "allow"
                              : "deny";

                        return (
                          <div className="space-y-4">
                            <SettingCard>
                              <SettingRow
                                title="当前项目"
                                description={
                                  <span className="font-mono text-[11px]">
                                    {workspace.cwd}
                                  </span>
                                }
                                control={
                                  <Select
                                    value={workspace.id}
                                    onValueChange={setProjectId}
                                  >
                                    <SelectTrigger
                                      size="sm"
                                      className="w-52"
                                      aria-label="选择项目"
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {workspaces.map((item) => (
                                        <SelectItem key={item.id} value={item.id}>
                                          {item.title}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                }
                              />

                              <SettingRow
                                title="新建线程快捷入口"
                                description="勾选后，在右侧项目栏悬停该项目时将直接展示对应代理的新建按钮。"
                              >
                                <div className="flex flex-wrap gap-2">
                                  {harnesses.map((harness) => {
                                    const checked = enabled.includes(harness.id);
                                    return (
                                      <button
                                        key={harness.id}
                                        type="button"
                                        aria-pressed={checked}
                                        disabled={savingProject}
                                        onClick={() => {
                                          setSavingProject(true);
                                          void setProjectHarnesses(
                                            workspace.id,
                                            checked
                                              ? enabled.filter(
                                                  (id) => id !== harness.id,
                                                )
                                              : [...enabled, harness.id],
                                          )
                                            .catch(showError)
                                            .finally(() => setSavingProject(false));
                                        }}
                                        className={cn(
                                          "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:opacity-50",
                                          checked
                                            ? "border-primary/45 bg-primary/10 font-medium text-foreground"
                                            : "border-border/70 bg-background/60 text-muted-foreground hover:border-border hover:text-foreground",
                                        )}
                                      >
                                        <HarnessIcon
                                          harnessId={harness.id}
                                          harness={harness}
                                          size={14}
                                        />
                                        <span>{harness.displayName}</span>
                                        <span
                                          aria-hidden="true"
                                          className={cn(
                                            "inline-flex size-4 items-center justify-center rounded-sm border",
                                            checked
                                              ? "border-primary bg-primary text-primary-foreground"
                                              : "border-border bg-transparent",
                                          )}
                                        >
                                          {checked && (
                                            <HugeiconsIcon
                                              icon={Tick02Icon}
                                              size={11}
                                            />
                                          )}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </SettingRow>

                              <SettingRow
                                title="Pi 项目信任"
                                description="控制 Pi 是否加载此项目的设置、资源和扩展；重新连接后生效。"
                                control={
                                  <Select
                                    value={trustValue}
                                    onValueChange={(value) =>
                                      void act("host.policy.set", {
                                        trustWorkspaceCwd: workspace.cwd,
                                        trusted:
                                          value === "default"
                                            ? null
                                            : value === "allow",
                                      })
                                    }
                                  >
                                    <SelectTrigger
                                      size="sm"
                                      className="w-40"
                                      aria-label="Pi 项目信任"
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="default">
                                        Pi 默认设置
                                      </SelectItem>
                                      <SelectItem value="allow">
                                        信任项目
                                      </SelectItem>
                                      <SelectItem value="deny">
                                        不信任项目
                                      </SelectItem>
                                    </SelectContent>
                                  </Select>
                                }
                              />
                            </SettingCard>
                          </div>
                        );
                      })()
                    ) : (
                      <SettingNote>
                        暂无项目，点击右上角「添加项目」选择工作目录。
                      </SettingNote>
                    )}
                  </section>
                )}

                {panel === "general" && (
                  <section className="space-y-4">
                    <SettingSectionHeader title="工作区偏好" />
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
                  <div hidden={panel !== "voice"}>
                    <VoiceSettingsPanel embedded onDirtyChange={setVoiceDirty} />
                  </div>
                )}

                {panel === "remote" && (
                  <section className="space-y-4">
                    <SettingSectionHeader
                      title="局域网服务"
                      description="在局域网内开放移动控制页，支持扫码一次性配对授权。"
                    />
                    <SettingCard>
                      <SettingRow
                        htmlFor="agent-remote-switch"
                        title="允许手机连接"
                        description="默认只监听本机。开启后监听局域网地址；应用退出后连接自动停止。"
                        control={
                          <Switch
                            id="agent-remote-switch"
                            checked={remote.enabled}
                            onCheckedChange={(enabled) =>
                              void act(
                                enabled
                                  ? "host.remote.enable"
                                  : "host.remote.disable",
                                enabled ? { port: Number(port) } : {},
                              )
                            }
                          />
                        }
                      />
                      {!remote.enabled ? (
                        <SettingRow
                          htmlFor="agent-remote-port"
                          title="监听端口"
                          description="开启手机连接后将绑定此端口。"
                          control={
                            <Input
                              id="agent-remote-port"
                              type="number"
                              min={1}
                              max={65535}
                              value={port}
                              onChange={(e) => setPort(e.target.value)}
                              className="h-8 w-28"
                            />
                          }
                        />
                      ) : (
                        <SettingRow
                          title="可用访问入口"
                          description="请确保手机与当前电脑处于同一局域网下。"
                          control={
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
                          }
                        >
                          <div className="flex flex-wrap gap-1.5">
                            {remote.addresses?.map((url) => (
                              <code
                                key={url}
                                className="rounded-md border border-border/70 bg-background/80 px-2 py-1 font-mono text-[11px] text-foreground"
                              >
                                {url}/mobile.html
                              </code>
                            ))}
                          </div>
                        </SettingRow>
                      )}
                    </SettingCard>

                    {remote.enabled && (
                      <SettingNote tone="warning">
                        当前为局域网 HTTP 连接。若需公网访问请通过 HTTPS 入口或安全隧道，不要将本机端口直接暴露在公网。
                      </SettingNote>
                    )}

                    {remote.enabled && pair && (
                      <SettingCard>
                        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
                          {qr && (
                            <div className="shrink-0 overflow-hidden rounded-lg border border-border bg-white p-1.5">
                              <img
                                src={qr}
                                alt="用手机扫描连接二维码"
                                width={168}
                                height={168}
                              />
                            </div>
                          )}
                          <div className="min-w-0 flex-1 space-y-2.5">
                            <div className="flex items-baseline gap-2.5">
                              <span className="text-[11px] text-muted-foreground">
                                配对验证码
                              </span>
                              <strong className="agent-pair-code text-foreground">
                                {pair.code}
                              </strong>
                            </div>
                            <p className="text-[11px] leading-relaxed text-muted-foreground">
                              手机扫码后输入上方验证码，并在桌面端批准连接。有效期至{" "}
                              {new Date(pair.expiresAt * 1000).toLocaleTimeString()}。
                            </p>
                            <label
                              htmlFor="agent-pair-address"
                              className="flex flex-col gap-1.5 text-[11px] font-medium text-muted-foreground"
                            >
                              <span>手机可访问的主机地址</span>
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
                      </SettingCard>
                    )}

                    {devices.pending.length > 0 && (
                      <div className="space-y-2.5">
                        <SettingSectionHeader
                          title="待批准连接"
                          count={devices.pending.length}
                        />
                        <SettingCard>
                          {devices.pending.map((device) => (
                            <SettingRow
                              key={device.id}
                              title={`${device.name} 请求连接`}
                              control={
                                <div className="flex gap-2">
                                  <Button
                                    size="sm"
                                    onClick={() =>
                                      void act("host.device.approve", {
                                        id: device.id,
                                      })
                                    }
                                  >
                                    允许
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      void act("host.device.deny", {
                                        id: device.id,
                                      })
                                    }
                                  >
                                    拒绝
                                  </Button>
                                </div>
                              }
                            />
                          ))}
                        </SettingCard>
                      </div>
                    )}

                    <div className="space-y-2.5">
                      <SettingSectionHeader
                        title="已配对设备"
                        count={activeDevices.length}
                      />
                      {activeDevices.length > 0 ? (
                        <SettingCard>
                          {activeDevices.map((device) => (
                            <SettingRow
                              key={device.id}
                              title={device.name}
                              description={`配对时间：${new Date(
                                device.pairedAt * 1000,
                              ).toLocaleString()}`}
                              control={
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    void act("host.device.revoke", {
                                      id: device.id,
                                    })
                                  }
                                >
                                  撤销授权
                                </Button>
                              }
                            />
                          ))}
                        </SettingCard>
                      ) : (
                        <SettingNote>暂无已配对设备。</SettingNote>
                      )}
                    </div>
                  </section>
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
