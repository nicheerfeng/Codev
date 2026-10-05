import { useEffect, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Settings01Icon,
  Cancel01Icon,
  CpuIcon,
  PlusSignIcon,
  Delete02Icon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
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
import {
  deleteResource,
  listResources,
  saveResource,
  probeResource,
  RESOURCE_NOTE,
  type ResourceCatalog,
  readCodexInstructions,
  writeCodexInstructions,
} from "./resources";
import type { CodexClient, Snapshot } from "./client";
import { VoiceSettingsPanel } from "@/modules/plugins/codex-agent/voice/VoiceSettingsPanel";

/** 资源选择始终显示，禁用状态说明具体原因，设置仍可管理未生效档案。 */
export function CodexResources({
  client,
  state,
  children,
  active = true,
}: {
  client: CodexClient;
  state: Snapshot;
  children?: ReactNode;
  active?: boolean;
}) {
  const [catalog, setCatalog] = useState<ResourceCatalog | null>(null);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"resources" | "general">("resources");
  const [turnDiff, setTurnDiff] = useState(
    () => localStorage.getItem("codev.codex.turn-diff") === "1",
  );
  const [selectedAlias, setSelectedAlias] = useState("");
  const activeAlias = catalog?.activeAlias ?? "";
  useEffect(() => {
    setSelectedAlias((current) =>
      catalog?.resources.some((resource) => resource.alias === current)
        ? current
        : activeAlias,
    );
  }, [catalog, activeAlias]);
  const [editing, setEditing] = useState<{
    originalAlias: string | null;
    alias: string;
    baseUrl: string;
    key: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState("");
  const [editedCurrent, setEditedCurrent] = useState(false);
  const [error, setError] = useState("");
  const [instructions, setInstructions] = useState("");
  const [instructionsBusy, setInstructionsBusy] = useState(false);
  const [instructionsMessage, setInstructionsMessage] = useState("");
  const [remove, setRemove] = useState<string | null>(null);
  const reason = client.switchReason();
  const switching = state.switching;
  /** 每次打开设置刷新档案，不向前端读取密钥。
   */
  const refresh = () => {
    void listResources()
      .then((value) => {
        setCatalog(value);
        setError("");
      })
      .catch((failure) => setError(String(failure)));
  };
  useEffect(() => {
    if (!active) return;
    void listResources()
      .then(setCatalog)
      .catch((failure) => setError(String(failure)));
  }, [state.resourceId, open, active]);
  useEffect(() => {
    if (open)
      void readCodexInstructions()
        .then(setInstructions)
        .catch((failure) => setInstructionsMessage(String(failure)));
  }, [open]);
  /** 保存 Codex 个人全局指令。 */
  const saveInstructions = async () => {
    setInstructionsBusy(true);
    try {
      await writeCodexInstructions(instructions);
      setInstructionsMessage("自定义提示词已保存");
    } catch (failure) {
      setInstructionsMessage(String(failure));
    } finally {
      setInstructionsBusy(false);
    }
  };
  /** 保存后清空明文输入，当前资源的修改通过显式重新应用生效。 */
  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const { originalAlias, ...resource } = editing;
      setCatalog(await saveResource(resource, originalAlias));
      setSelectedAlias(resource.alias.trim());
      if (originalAlias === activeAlias) setEditedCurrent(true);
      setError("");
      setEditing(null);
      toast.success("资源已保存，点击应用后生效");
    } catch (failure) {
      setError(String(failure));
    } finally {
      setSaving(false);
    }
  };
  /** 切换失败保持当前显示并呈现原生核验结果。 */
  const select = (alias: string) => {
    setSelectedAlias(alias);
    void client
      .switchResource(alias)
      .then(() => {
        setEditedCurrent(false);
        refresh();
      })
      .catch((failure) => toast.error(String(failure)));
  };
  return (
    <>
      <span
        title={reason || "切换登录资源"}
        className="flex min-w-0 max-w-40 items-center gap-1"
      >
        <Select
          value={activeAlias}
          disabled={Boolean(reason) || !catalog}
          onValueChange={select}
        >
          <SelectTrigger
            size="sm"
            className="h-7 min-w-0 max-w-36 bg-transparent text-xs"
            aria-label="登录资源"
          >
            <SelectValue placeholder="登录资源" />
          </SelectTrigger>
          <SelectContent className="rounded-xl">
            {catalog?.resources.map((resource) => (
              <SelectItem key={resource.alias} value={resource.alias}>
                {resource.alias}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {switching && (
          <span
            className="size-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
            aria-label="正在切换资源"
          />
        )}
      </span>
      {children}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Codex 设置"
        title="Codex 设置"
        onClick={() => setOpen(true)}
      >
        <HugeiconsIcon icon={Settings01Icon} size={15} />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            setEditing(null);
            setRemove(null);
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex h-[90vh] min-h-0 w-[calc(100%-1rem)] max-w-[1280px] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[1280px]"
        >
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
            <DialogTitle className="flex-1 text-sm">Codex 设置</DialogTitle>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="关闭 Codex 设置"
              title="关闭"
              onClick={() => {
                setOpen(false);
                setEditing(null);
                setRemove(null);
              }}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={16} />
            </Button>
          </header>
          <DialogDescription className="sr-only">
            左侧选择设置功能，右侧管理服务商与自定义提示词。
          </DialogDescription>
          <div className="flex min-h-0 flex-1">
            <nav
              aria-label="Codex 设置导航"
              className="w-24 shrink-0 border-r border-border bg-muted/15 p-2 sm:w-36"
            >
              <Button
                variant={panel === "resources" ? "secondary" : "ghost"}
                size="sm"
                aria-current={panel === "resources" ? "page" : undefined}
                className="w-full justify-start gap-1.5 rounded-lg px-2 text-xs"
                onClick={() => setPanel("resources")}
              >
                <HugeiconsIcon icon={CpuIcon} size={14} />
                服务商存储
              </Button>
              <Button
                variant={panel === "general" ? "secondary" : "ghost"}
                size="sm"
                aria-current={panel === "general" ? "page" : undefined}
                className="mt-1 w-full justify-start gap-1.5 rounded-lg px-2 text-xs"
                onClick={() => setPanel("general")}
              >
                <HugeiconsIcon icon={Settings01Icon} size={14} />
                通用
              </Button>
            </nav>
            <main
              className="flex min-h-0 min-w-0 flex-1 flex-col"
              aria-label="Codex 设置内容"
            >
              {panel === "general" ? (
                <div className="reader-scrollbar min-h-0 flex-1 space-y-3 overflow-auto p-3 sm:p-4">
                  <h2 className="text-sm font-medium">通用</h2>
                  <section className="space-y-2 rounded-lg border border-border/70 p-3">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-xs font-medium">自定义提示词</h3>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          对所有 Codex 项目生效；项目目录内的 AGENTS.md
                          仍会继续叠加。
                        </p>
                      </div>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={instructionsBusy}
                        onClick={() => void saveInstructions()}
                      >
                        保存
                      </Button>
                    </div>
                    <Textarea
                      value={instructions}
                      onChange={(event) => setInstructions(event.target.value)}
                      className="min-h-28 rounded-lg font-mono text-xs"
                      disabled={instructionsBusy}
                      aria-label="Codex 自定义提示词"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[10px] text-muted-foreground">
                        ~/.codex/AGENTS.md
                      </span>
                      {instructionsMessage && (
                        <span className="text-[11px] text-muted-foreground">
                          {instructionsMessage}
                        </span>
                      )}
                    </div>
                  </section>
                  <div className="flex items-center gap-3 rounded-lg border border-border/70 p-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-xs font-medium">回合文件感知</h3>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Codex
                        使用本回合协议返回的文件差异。没有差异记录的修改暂无法支持感知。
                      </p>
                    </div>
                    <Switch
                      checked={turnDiff}
                      aria-label="开启 Codex 回合文件感知"
                      onCheckedChange={(value) => {
                        setTurnDiff(value);
                        localStorage.setItem(
                          "codev.codex.turn-diff",
                          value ? "1" : "0",
                        );
                      }}
                    />
                  </div>
                  <VoiceSettingsPanel embedded />
                </div>
              ) : (
                <div className="reader-scrollbar min-h-0 flex-1 space-y-3 overflow-auto p-3 sm:p-4">
                  <h2 className="text-sm font-medium">服务商存储</h2>
                  <ul className="list-disc pl-4 text-xs text-muted-foreground space-y-1">
                    <li>
                      特点：支持类似 cc-switch 的资源切换，无需重启
                      Codev、无需代理。
                      <details className="inline ml-1">
                        <summary className="inline cursor-pointer text-[11px] text-foreground">
                          【更多】
                        </summary>
                        <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[10px] leading-relaxed">
                          <li>
                            {RESOURCE_NOTE} provider 名称沿用
                            ~/.codex/config.toml 的配置。
                          </li>
                          <li>
                            多渠道 API 保存在
                            ~/.codex/codev.json；别名与地址明文保存，key 使用
                            Windows 用户加密保护；应用时同步 config.toml 和
                            auth.json。 传输是否加密取决于所配置地址是否使用
                            HTTPS。
                          </li>
                          <li>
                            受线程写锁限制，切换前须确认本插件所有任务结束，再退出旧
                            runtime、建立新 runtime。provider
                            保持不变，原线程可在下次输入时恢复。
                          </li>
                          <li>
                            此处管理 API key 资源；应用会更新共享 Codex 配置。
                            其他客户端持有的同一线程不能同时写入；跨 provider
                            或目录的历史迁移需另行处理，不保证自动同步。
                          </li>
                        </ul>
                      </details>
                    </li>
                  </ul>
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span>
                      Provider：
                      <strong className="font-normal">
                        {catalog?.provider ?? "读取中"}
                      </strong>
                      （来自 config.toml）
                    </span>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        setEditing({
                          originalAlias: null,
                          alias: "",
                          baseUrl: "",
                          key: "",
                        });
                        setError("");
                      }}
                    >
                      <HugeiconsIcon icon={PlusSignIcon} size={12} />
                      添加资源
                    </Button>
                  </div>
                  {error && (
                    <p
                      role="alert"
                      className="text-xs text-destructive break-all"
                    >
                      {error}
                      <Button size="xs" variant="ghost" onClick={refresh}>
                        重试读取
                      </Button>
                    </p>
                  )}
                  <div className="reader-scrollbar max-h-64 overflow-auto rounded-lg border border-border">
                    {catalog?.resources.map((resource) => (
                      <div
                        key={resource.alias}
                        className={`flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 last:border-0 ${selectedAlias === resource.alias ? "bg-accent ring-1 ring-inset ring-primary/40" : ""}`}
                      >
                        <button
                          type="button"
                          aria-pressed={selectedAlias === resource.alias}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
                          onClick={() => setSelectedAlias(resource.alias)}
                        >
                          <span
                            className={`size-3 shrink-0 rounded-full border ${selectedAlias === resource.alias ? "border-primary bg-primary" : "border-muted-foreground"}`}
                          />
                          <span
                            className="max-w-28 shrink-0 truncate"
                            title={resource.alias}
                          >
                            {resource.alias}
                          </span>
                          {activeAlias === resource.alias && (
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              使用中
                            </span>
                          )}
                          <span
                            className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
                            title={resource.baseUrl}
                          >
                            {resource.baseUrl || "Codex 默认地址"}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            key：*
                          </span>
                        </button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          title={`编辑 ${resource.alias}`}
                          aria-label={`编辑 ${resource.alias}`}
                          onClick={() => {
                            setSelectedAlias(resource.alias);
                            setError("");
                            setEditing({
                              ...resource,
                              originalAlias: resource.alias,
                            });
                          }}
                        >
                          <HugeiconsIcon icon={PencilEdit01Icon} size={13} />
                        </Button>
                        {
                          <>
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={probing !== null}
                              title="仅探测模型目录，不执行生成调用"
                              onClick={() => {
                                setProbing(resource.alias);
                                setProbeResult("");
                                void probeResource(resource.alias)
                                  .then(setProbeResult)
                                  .catch((failure) =>
                                    setProbeResult(String(failure)),
                                  )
                                  .finally(() => setProbing(null));
                              }}
                            >
                              {probing === resource.alias ? "探测中…" : "探测"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              title={`删除 ${resource.alias}`}
                              aria-label={`删除 ${resource.alias}`}
                              disabled={
                                activeAlias === resource.alias || saving
                              }
                              onClick={() => setRemove(resource.alias)}
                            >
                              <HugeiconsIcon icon={Delete02Icon} size={13} />
                            </Button>
                          </>
                        }
                      </div>
                    ))}
                  </div>
                  {remove && (
                    <div className="flex items-center gap-2 text-xs">
                      <span>确认删除此资源档案？</span>
                      <Button
                        size="xs"
                        variant="destructive"
                        disabled={saving}
                        onClick={() => {
                          setSaving(true);
                          void deleteResource(remove)
                            .then((value) => {
                              setCatalog(value);
                              setRemove(null);
                              if (selectedAlias === remove)
                                setSelectedAlias(activeAlias);
                            })
                            .catch((failure) => setError(String(failure)))
                            .finally(() => setSaving(false));
                        }}
                      >
                        删除
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setRemove(null)}
                      >
                        取消
                      </Button>
                    </div>
                  )}
                  {editing && (
                    <form
                      className="space-y-2 rounded-lg border border-border p-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                      }}
                    >
                      <Input
                        aria-label="资源别名"
                        placeholder="资源别名"
                        value={editing.alias}
                        onChange={(event) =>
                          setEditing({ ...editing, alias: event.target.value })
                        }
                      />
                      <Input
                        aria-label="资源 baseURL"
                        placeholder="https://example.com/v1"
                        value={editing.baseUrl}
                        onChange={(event) =>
                          setEditing({
                            ...editing,
                            baseUrl: event.target.value,
                          })
                        }
                      />
                      <Input
                        aria-label="资源 API key"
                        type="text"
                        autoComplete="new-password"
                        placeholder="API key（编辑时留空保留原密钥）"
                        value={editing.key}
                        onChange={(event) =>
                          setEditing({ ...editing, key: event.target.value })
                        }
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => setEditing(null)}
                        >
                          取消编辑
                        </Button>
                        <Button
                          size="xs"
                          type="submit"
                          disabled={
                            saving ||
                            !editing.alias.trim() ||
                            !editing.baseUrl.trim()
                          }
                        >
                          保存资源
                        </Button>
                      </div>
                    </form>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <p
                      className="min-w-0 truncate text-[10px] text-muted-foreground"
                      title={catalog?.path}
                    >
                      {catalog?.path}
                    </p>
                    <span title={reason}>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={
                          Boolean(reason) ||
                          saving ||
                          !catalog?.resources.some(
                            (resource) => resource.alias === selectedAlias,
                          )
                        }
                        onClick={() => select(selectedAlias)}
                      >
                        应用选中资源
                      </Button>
                    </span>
                  </div>
                  {switching && (
                    <p
                      role="status"
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                    >
                      <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
                      正在切换资源，正在关闭旧运行时并建立新连接…
                    </p>
                  )}
                  {editedCurrent && !switching && (
                    <p role="status" className="text-xs text-muted-foreground">
                      当前档案已修改，重新应用后生效。
                    </p>
                  )}
                  {probeResult && (
                    <p role="status" className="text-xs text-muted-foreground">
                      {probeResult}
                    </p>
                  )}
                  {reason && (
                    <p role="status" className="text-xs text-muted-foreground">
                      {reason}
                    </p>
                  )}
                </div>
              )}
            </main>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
