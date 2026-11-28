import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingCard,
  SettingNote,
  SettingRow,
  SettingSectionHeader,
} from "./SettingPrimitives";
import type { Harness } from "./types";

export type Diagnosis = {
  id: string;
  displayName: string;
  verdict: "ready" | "missing_binary" | "needs_config" | "needs_auth";
  installed: boolean;
  resolvedPath?: string | null;
  codexCliPath?: string | null;
  nodePath?: string | null;
  managedCodex?: boolean;
  hints: string[];
};

export type PolicyEntry = {
  read?: string;
  write?: string;
  permission?: string;
  allowOutsideWorkspace?: boolean;
};

export type PolicyMap = Record<string, PolicyEntry>;

export type RemoteStatus = {
  enabled: boolean;
  port?: number;
  addresses?: string[];
  encrypted?: boolean;
  tailscaleIp?: string | null;
};

export type PairingInfo = {
  nonce: string;
  code: string;
  expiresAt: number;
  addresses: string[];
  port: number;
};

export type PairedDevices = {
  devices: Array<{
    id: string;
    name: string;
    pairedAt: number;
    revoked: boolean;
  }>;
  remoteWriteDevices?: string[];
  pending: Array<{ id: string; name: string; expiresAt: number }>;
};

export function verdictMeta(diagnosis?: Diagnosis) {
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

export function HarnessGeneralPanel({
  harness,
  diagnosis,
  policy,
  piVersion,
  quickCreateEnabled,
  onToggleQuickCreate,
  docConfig,
  onSavePolicy,
}: {
  harness: Pick<Harness, "id" | "displayName" | "kind">;
  diagnosis?: Diagnosis;
  policy?: PolicyEntry;
  piVersion?: string;
  quickCreateEnabled: boolean;
  onToggleQuickCreate: (enabled: boolean) => void;
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
  const docDirty =
    !!docConfig &&
    !docConfig.disabled &&
    docConfig.value !== (docConfig.savedValue ?? "");
  const permissionMode = policy?.permission ?? "ask";
  const allowOutside =
    policy?.allowOutsideWorkspace ?? permissionMode === "allow_all";

  return (
    <div className="space-y-4">
      <SettingCard>
        <SettingRow
          htmlFor={`agent-quick-create-${harness.id}`}
          title="在项目栏显示新建快捷入口"
          description={`开启后，悬停项目栏目录时将展示 ${harness.displayName} 的快速新建线程按钮；不影响运行中的线程监测。`}
          control={
            <Switch
              id={`agent-quick-create-${harness.id}`}
              checked={quickCreateEnabled}
              onCheckedChange={onToggleQuickCreate}
            />
          }
        />
        <SettingRow
          title="运行环境"
          description={
            <div className="space-y-0.5 font-mono text-[11px]">
              <div className="break-all">
                {diagnosis?.resolvedPath ||
                  (diagnosis ? "未找到启动程序" : "正在定位程序…")}
              </div>
              {harness.id === "acp:codex" && diagnosis?.codexCliPath && (
                <div className="break-all text-[10px] text-muted-foreground/80">
                  本机 Codex CLI：{diagnosis.codexCliPath}
                </div>
              )}
            </div>
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
                      allowOutsideWorkspace:
                        policy?.allowOutsideWorkspace ?? false,
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
                    <SelectItem value="allow">
                      最大权限（自动允许写入）
                    </SelectItem>
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
        <SettingNote
          tone={diagnosis.verdict === "ready" ? "default" : "warning"}
        >
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

export function RemoteSettingsPanel({
  remote,
  port,
  pair,
  qr,
  address,
  devices,
  activeDevices,
  onPortChange,
  onAddressChange,
  onStartPair,
  onRefreshStatus,
  onReset,
  onAct,
}: {
  remote: RemoteStatus;
  port: string;
  pair: PairingInfo | null;
  qr: string;
  address: string;
  devices: PairedDevices;
  activeDevices: PairedDevices["devices"];
  onPortChange: (port: string) => void;
  onAddressChange: (address: string) => void;
  onStartPair: () => void;
  onRefreshStatus: () => void;
  onReset: () => void;
  onAct: (op: string, payload?: Record<string, unknown>) => Promise<unknown>;
}) {
  const [guideOpen, setGuideOpen] = useState(false);
  const tsIp = remote.tailscaleIp ?? null;
  const addressLabel = (url: string) => {
    if (tsIp && url.includes(tsIp)) return "Tailscale 加密入口";
    if (url.includes("127.0.0.1")) return "本机预览";
    return "内网入口";
  };

  return (
    <section className="space-y-4">
      <SettingSectionHeader
        title="手机连接服务"
        description="通过 Tailscale 加密通道与一次性配对码授权手机远程访问。"
        actions={
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setGuideOpen(true)}
            >
              使用说明
            </Button>
            <Button size="sm" variant="outline" onClick={onReset}>
              清空配置
            </Button>
          </div>
        }
      />
      <Dialog open={guideOpen} onOpenChange={setGuideOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle className="text-sm font-semibold">
            手机连接使用说明
          </DialogTitle>
          <DialogDescription className="sr-only">
            如何配置 Tailscale 远程加密访问 Codev 移动控制页
          </DialogDescription>
          <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
            <div className="space-y-1">
              <h4 className="font-medium text-foreground">
                1. 跨网加密直连（Tailscale）
              </h4>
              <ul className="list-disc space-y-1 pl-4">
                <li>
                  在 Windows 电脑与手机上分别安装 Tailscale 并登录同一账号。
                </li>
                <li>
                  开启「允许手机连接」后，Codev 会自动识别本机 Tailscale
                  虚拟地址（
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                    100.x.x.x:7331
                  </code>
                  ）。
                </li>
                <li>
                  点击「生成一次性配对码」，手机保持 Tailscale 开启即可在
                  4G/5G/任意网络下扫码配对，全程 WireGuard 端到端加密。
                </li>
              </ul>
            </div>
            <div className="space-y-1">
              <h4 className="font-medium text-foreground">
                2. 电脑浏览器预览移动端
              </h4>
              <p>
                开启服务后，在本机浏览器访问{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                  http://127.0.0.1:7331/mobile.html
                </code>
                （仅本机可达），按 F12 切换手机视图即可预览调试。
              </p>
            </div>
            <div className="space-y-1">
              <h4 className="font-medium text-foreground">3. 清空配置</h4>
              <p>
                点击「清空配置」会停止当前远程服务、吊销所有已配对设备并重置写权限与端口（恢复为
                7331），方便重新配对。
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <SettingCard>
        <SettingRow
          title="Tailscale 通道"
          description={
            tsIp
              ? `已检测到本机 Tailscale 在线（${tsIp}），通道已就绪，可直接生成配对码。`
              : "未检测到活跃的 Tailscale 虚拟网络。请先在本机启动并登录 Tailscale 后点击刷新。"
          }
          control={
            <div className="flex items-center gap-2">
              <span className="inline-flex h-5 items-center gap-1.5 rounded-full border border-border/70 bg-background/80 px-2 text-[10px] font-medium text-foreground">
                <span
                  className={
                    tsIp
                      ? "size-1.5 rounded-full bg-emerald-500"
                      : "size-1.5 rounded-full bg-muted-foreground/50"
                  }
                />
                {tsIp ? "已连接" : "未连接"}
              </span>
              <Button size="sm" variant="outline" onClick={onRefreshStatus}>
                刷新
              </Button>
            </div>
          }
        />
        <SettingRow
          htmlFor="agent-remote-switch"
          title="允许手机连接"
          description="开启后开放移动端远程访问入口，搭配 Tailscale 即可跨网加密直连；应用退出后自动停止。"
          control={
            <Switch
              id="agent-remote-switch"
              checked={remote.enabled}
              onCheckedChange={(enabled) =>
                void onAct(
                  enabled ? "host.remote.enable" : "host.remote.disable",
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
                onChange={(e) => onPortChange(e.target.value)}
                className="h-8 w-28"
              />
            }
          />
        ) : (
          <SettingRow
            title="可用访问入口"
            description="优先使用 Tailscale 加密地址（100.x.x.x）；点击右侧生成一次性配对码授权手机连接。"
            control={
              <Button variant="outline" size="sm" onClick={onStartPair}>
                生成一次性配对码
              </Button>
            }
          >
            <div className="flex flex-wrap gap-2">
              {remote.addresses?.map((url) => (
                <div
                  key={url}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background/80 px-2 py-1 text-[11px]"
                >
                  <span className="text-[10px] text-muted-foreground">
                    {addressLabel(url)}
                  </span>
                  <code className="font-mono text-foreground">
                    {url}/mobile.html
                  </code>
                </div>
              ))}
            </div>
          </SettingRow>
        )}
      </SettingCard>

      {remote.enabled && !tsIp && (
        <SettingNote tone="warning">
          当前未检测到 Tailscale 加密通道。请先启动并登录本机
          Tailscale，不要将本机端口直接暴露在公网。
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
                  onChange={(e) => onAddressChange(e.target.value)}
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
                        void onAct("host.device.approve", { id: device.id })
                      }
                    >
                      允许
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void onAct("host.device.deny", { id: device.id })
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
        <SettingSectionHeader title="已配对设备" count={activeDevices.length} />
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
                  <div className="flex items-center gap-2">
                    <Button
                      variant={
                        devices?.remoteWriteDevices?.includes(device.id)
                          ? "default"
                          : "outline"
                      }
                      size="sm"
                      onClick={() =>
                        void onAct("host.device.write", {
                          id: device.id,
                          enabled: !devices?.remoteWriteDevices?.includes(
                            device.id,
                          ),
                        })
                      }
                    >
                      {devices?.remoteWriteDevices?.includes(device.id)
                        ? "Git 可写"
                        : "Git 只读"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void onAct("host.device.revoke", { id: device.id })
                      }
                    >
                      撤销授权
                    </Button>
                  </div>
                }
              />
            ))}
          </SettingCard>
        ) : (
          <SettingNote>暂无已配对设备。</SettingNote>
        )}
      </div>
    </section>
  );
}
