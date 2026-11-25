import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  PencilEdit01Icon,
  PlusSignIcon,
  Tick02Icon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { SettingNote, SettingSectionHeader } from "./SettingPrimitives";
import { useAgentStore } from "./store";

type Fields = { name: string; baseUrl: string; model: string; models: string[]; hasKey: boolean };
type Provider = Fields & { id: string };
type NativeConfig = {
  status: "read" | "missing" | "unavailable" | "invalid";
  providerId?: string;
  providerName?: string;
  baseUrl?: string | null;
  model?: string | null;
  models?: string[];
  hasKey?: boolean;
  revision?: string;
};
type Inventory = { active: string; items: Provider[]; native?: NativeConfig | null; canImport: boolean };
type Resource = Fields & {
  id: string;
  kind: "official" | "native" | "managed";
  description: string;
};
type Draft = { resource: Resource; fields: Fields; apiKey: string };
type Notice = { text: string; error?: boolean };
const OFFICIAL = "@official";
const NEW = "@new";

function modelNames(model: string, models: string[] = []) {
  return Array.from(new Set([model, ...models].filter(Boolean)));
}

function getResources(data: Inventory, codex: boolean): Resource[] {
  const native = data.native;
  const hasNativeRoute = native?.status === "read" &&
    (native.providerId !== "openai" || !!native.baseUrl);
  const resources: Resource[] = [{
    id: codex && hasNativeRoute ? OFFICIAL : "",
    kind: "official",
    name: codex ? "OpenAI Official" : "Google 官方登录",
    description: codex ? "使用 Codex CLI 登录账号" : "使用 Antigravity 登录账号",
    baseUrl: "",
    model: codex && !hasNativeRoute ? native?.model ?? "" : "",
    models: [],
    hasKey: false,
  }];
  if (codex && hasNativeRoute) {
    resources.push({
      id: "",
      kind: "native",
      name: native.providerName || native.providerId || "Codex 原生资源",
      baseUrl: native.baseUrl ?? "",
      description: "来自 Codex 原生配置",
      model: native.model ?? "",
      models: modelNames(native.model ?? "", native.models),
      hasKey: !!native.hasKey,
    });
  }
  return resources.concat(data.items.map((item) => ({
    ...item,
    kind: "managed",
    description: "",
    models: modelNames(item.model, item.models),
  })));
}

export function HarnessModelsPanel({
  harnessId,
  onDirtyChange,
}: {
  harnessId: "acp:codex" | "acp:antigravity";
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [data, setData] = useState<Inventory | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [modelInput, setModelInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const [discovered, setDiscovered] = useState<Record<string, string[]>>({});
  const [pendingApply, setPendingApply] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const codex = harnessId === "acp:codex";
  const command = useAgentStore.getState().command;
  const dirty = !!draft && (
    draft.resource.id === NEW || !!draft.apiKey || !!modelInput.trim() ||
    draft.fields.name !== draft.resource.name ||
    draft.fields.baseUrl !== draft.resource.baseUrl ||
    draft.fields.model !== draft.resource.model ||
    JSON.stringify(draft.fields.models) !== JSON.stringify(draft.resource.models)
  );

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    let current = true;
    command<Inventory>("harness.providers.list", { harnessId })
      .then((result) => { if (current) setData(result); })
      .catch((error) => { if (current) setLoadError(String(error)); });
    return () => { current = false; };
  }, [command, harnessId, reload]);

  const notice = (id: string, text: string, error = false) =>
    setNotices((previous) => ({ ...previous, [id]: { text, error } }));

  const run = async <T,>(id: string, op: string, payload: Record<string, unknown> = {}) => {
    setBusy(true);
    notice(id, "");
    try {
      return await command<T>(`harness.providers.${op}`, { harnessId, ...payload });
    } catch (error) {
      notice(id, error instanceof Error ? error.message : String(error), true);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const openEditor = (resource: Resource | null) => {
    if (dirty && !window.confirm("编辑内容还未保存，确定放弃？")) return;
    setModelInput("");
    setShowKey(false);
    if (!resource) { setDraft(null); return; }
    setDraft({ resource, fields: { ...resource }, apiKey: "" });
  };

  const addResource = () => openEditor({
    id: NEW, kind: "managed", name: "", baseUrl: "", model: "",
    models: [], hasKey: false, description: "",
  });

  const setFields = (values: Partial<Fields>) =>
    setDraft((old) => old && ({ ...old, fields: { ...old.fields, ...values } }));

  const addModel = (name: string) => {
    const value = name.trim();
    if (!draft || !value) return;
    const fields = draft.fields;
    setFields({ models: modelNames("", [...fields.models, value]), model: fields.model || value });
    setModelInput("");
  };

  const save = async () => {
    if (!draft || !data) return;
    const { resource, fields, apiKey } = draft;
    const extra = modelInput.trim();
    const model = fields.model || extra;
    if (!model) { notice(resource.id, "请添加至少一个模型", true); return; }
    const payload = { ...fields, apiKey, model, models: modelNames(model, [...fields.models, extra]) };
    const result = await run<Inventory>(resource.id, resource.kind === "native" ? "native.save" : "save",
      resource.kind === "native" ? { ...payload, providerId: data.native?.providerId, revision: data.native?.revision } :
        { ...payload, id: resource.id === NEW ? "" : resource.id });
    if (!result) return;
    setData(result);
    setDraft(null);
    setModelInput("");
    setShowKey(false);
    const id = resource.id === NEW ? result.items[result.items.length - 1]?.id ?? NEW : resource.id;
    if (resource.id !== NEW && (codex ? result.active === id : true)) {
      setPendingApply((previous) => Array.from(new Set([...previous, id])));
    }
    notice(id, "已保存");
  };

  const activateResource = async (resource: Resource) => {
    const result = await run<Inventory>(resource.id, "activate", { id: resource.id });
    if (!result) return;
    setData(result);
    if (codex) {
      setPendingApply((previous) => previous.filter((id) => id !== resource.id));
    } else {
      setPendingApply([resource.id]);
    }
  };

  const apply = async (resource: Resource) => {
    const result = await run<{ count: number }>(resource.id, "reconnect", { id: resource.id });
    if (!result) return;
    setPendingApply((previous) => previous.filter((id) => id !== resource.id));
    notice(resource.id, result.count ? `已重新连接 ${result.count} 个线程` : "配置将用于下次连接");
  };

  const probe = async (resource: Resource, open: boolean) => {
    const result = await run<{ models: string[] }>(resource.id, "discover", { id: resource.id });
    if (!result) return;
    setDiscovered((previous) => ({ ...previous, [resource.id]: modelNames("", result.models) }));
    notice(resource.id, `目录可用 · 共发现 ${result.models.length} 个模型`);
    if (open && draft?.resource.id !== resource.id) openEditor(resource);
  };

  const duplicate = async (resource: Resource) => {
    const result = await run<Inventory>(resource.id, "duplicate", { id: resource.id });
    if (result) { setData(result); notice(resource.id, "已创建副本"); }
  };

  const remove = async (resource: Resource) => {
    if (!window.confirm(`删除资源“${resource.name}”？`)) return;
    const result = await run<Inventory>(resource.id, "remove", { id: resource.id });
    if (!result) return;
    setData(result);
    if (draft?.resource.id === resource.id) { setDraft(null); setModelInput(""); setShowKey(false); }
  };

  const importLegacy = async () => {
    const result = await run<Inventory>("@catalog", "import");
    if (result) { setData(result); notice("@catalog", "已导入历史资源"); }
  };

  const renderNotice = (id: string) => {
    const status = notices[id];
    if (!status?.text) return null;
    return (
      <div className="px-4 pb-3">
        <SettingNote
          tone={status.error ? "destructive" : "default"}
          role={status.error ? "alert" : "status"}
          className="px-3 py-2"
        >
          {status.text}
        </SettingNote>
      </div>
    );
  };

  const renderEditor = () => {
    if (!draft) return null;
    const { resource, fields } = draft;
    const suggestions = (discovered[resource.id] ?? []).filter((name) => !fields.models.includes(name));
    return (
      <form
        className={cn(
          "border-t border-border/60 bg-muted/25 p-4",
          resource.id === NEW && "rounded-xl border border-border/80 bg-card",
        )}
        onSubmit={(event) => { event.preventDefault(); void save(); }}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-foreground">
            {resource.id === NEW ? "新增供应商资源" : `编辑 · ${resource.name || "资源配置"}`}
          </span>
          {resource.kind === "native" && (
            <span className="rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              写入 Codex 原生 config.toml
            </span>
          )}
        </div>
        <fieldset disabled={busy} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 text-[11px] font-medium text-muted-foreground">
              <label htmlFor="agent-resource-name">资源别名</label>
              <Input
                id="agent-resource-name"
                required
                placeholder="例如：中转站 / 公司网关"
                value={fields.name}
                onChange={(e) => setFields({ name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5 text-[11px] font-medium text-muted-foreground">
              <label htmlFor="agent-resource-key">API Key</label>
              <div className="flex items-center gap-1.5">
                <Input
                  id="agent-resource-key"
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  required={resource.id === NEW}
                  placeholder={fields.hasKey ? "已安全存储，留空保留原密钥" : "输入 API Key"}
                  value={draft.apiKey}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="shrink-0"
                  aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                  title={showKey ? "隐藏 API Key" : "显示 API Key"}
                  onClick={() => setShowKey((prev) => !prev)}
                >
                  <HugeiconsIcon icon={showKey ? ViewOffIcon : ViewIcon} size={14} />
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 text-[11px] font-medium text-muted-foreground sm:col-span-2">
              <label htmlFor="agent-resource-baseurl">Base URL</label>
              <Input
                id="agent-resource-baseurl"
                required
                type="url"
                value={fields.baseUrl}
                placeholder={codex ? "https://example.com/v1" : "https://example.com"}
                onChange={(e) => setFields({ baseUrl: e.target.value })}
              />
            </div>
          </div>

          <div className="space-y-2.5 rounded-lg border border-border/75 bg-background/75 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-foreground">模型清单</span>
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                  {fields.models.length}
                </span>
              </div>
              {resource.id !== NEW && (
                <Button type="button" size="xs" variant="outline" onClick={() => void probe(resource, false)}>
                  读取模型目录
                </Button>
              )}
            </div>

            {fields.models.length > 0 ? (
              <div className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60 bg-card/60">
                {fields.models.map((model) => {
                  const isDefault = model === fields.model;
                  return (
                    <div
                      key={model}
                      className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                        {model}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          size="xs"
                          variant={isDefault ? "secondary" : "ghost"}
                          disabled={isDefault}
                          className={cn(isDefault && "text-primary font-medium")}
                          onClick={() => setFields({ model })}
                        >
                          {isDefault && <HugeiconsIcon icon={Tick02Icon} size={12} />}
                          {isDefault ? "默认" : "设为默认"}
                        </Button>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`移除模型 ${model}`}
                          title={`移除模型 ${model}`}
                          onClick={() => {
                            const models = fields.models.filter((value) => value !== model);
                            setFields({ models, model: isDefault ? models[0] ?? "" : fields.model });
                          }}
                        >
                          <HugeiconsIcon icon={Cancel01Icon} size={12} />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="py-1 text-[11px] text-muted-foreground">
                暂无模型，请在下方添加模型 ID 或从上游目录探测加入。
              </p>
            )}

            <div className="flex items-center gap-2">
              <Input
                aria-label="添加模型"
                value={modelInput}
                placeholder={codex ? "输入模型 ID（回车快速添加）" : "输入模型 ID 或显示名（如 gemini-4-hydrogen）"}
                onChange={(e) => setModelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    addModel(modelInput);
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!modelInput.trim()}
                onClick={() => addModel(modelInput)}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={13} />
                添加模型
              </Button>
            </div>

            {!!suggestions.length && (
              <div className="space-y-1.5 border-t border-border/50 pt-2.5">
                <span className="block text-[10px] text-muted-foreground">
                  从目录发现 {suggestions.length} 个模型（点击加入清单）：
                </span>
                <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto reader-scrollbar">
                  {suggestions.map((name) => (
                    <button
                      type="button"
                      key={name}
                      onClick={() => addModel(name)}
                      className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-foreground transition-colors hover:border-primary/50 hover:bg-accent"
                    >
                      <span>+</span>
                      <span>{name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border/50 pt-3">
            <Button type="button" size="sm" variant="ghost" onClick={() => openEditor(null)}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={!dirty}>
              保存资源
            </Button>
          </div>
        </fieldset>
      </form>
    );
  };

  const resources = data ? getResources(data, codex) : [];
  const active = data?.active === OFFICIAL && !resources.some((r) => r.id === OFFICIAL) ? "" : data?.active;
  return (
    <section className="space-y-4">
      <SettingSectionHeader
        title="供应商资源"
        count={data ? resources.length : undefined}
        description={
          codex
            ? "在此切换 Codex 激活的 API 供应商；未保存修改需点击“保存资源”后应用到线程。"
            : "选择 Antigravity 使用的账号或中转资源（选定中转时同时接管桌面端与 CLI 会话；历史按来源就地写回原目录，切回官方登录即退让回原生账号）。"
        }
        actions={
          <>
            {data?.canImport && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void importLegacy()}>
                导入旧版资源
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy || !data} onClick={addResource}>
              <HugeiconsIcon icon={PlusSignIcon} size={13} />
              添加资源
            </Button>
          </>
        }
      />

      {notices["@catalog"]?.text && (
        <SettingNote
          tone={notices["@catalog"].error ? "destructive" : "default"}
          role={notices["@catalog"].error ? "alert" : "status"}
        >
          {notices["@catalog"].text}
        </SettingNote>
      )}

      {!data && (
        <SettingNote tone={loadError ? "destructive" : "default"} role={loadError ? "alert" : "status"}>
          <div className="flex items-center justify-between gap-3">
            <span>{loadError || "正在读取供应商资源…"}</span>
            {loadError && (
              <Button size="xs" variant="outline" onClick={() => { setLoadError(""); setReload((value) => value + 1); }}>
                重试
              </Button>
            )}
          </div>
        </SettingNote>
      )}

      {data && codex && (data.native?.status === "invalid" || data.native?.status === "unavailable") && (
        <SettingNote tone="warning" role="alert">
          {data.native.status === "invalid" ? "Codex 原生配置格式无效，请检查 ~/.codex/config.toml" : "无法读取 Codex 原生配置"}
        </SettingNote>
      )}

      {draft?.resource.id === NEW && (
        <div className="space-y-2">
          {notices[NEW]?.text && (
            <SettingNote tone={notices[NEW].error ? "destructive" : "default"} role={notices[NEW].error ? "alert" : "status"}>
              {notices[NEW].text}
            </SettingNote>
          )}
          {renderEditor()}
        </div>
      )}

      <ul className="space-y-2.5">
        {resources.map((resource) => {
          const current = active === resource.id;
          const editing = draft?.resource.id === resource.id;
          const applicable = pendingApply.includes(resource.id) && (!codex || current);
          const subtitle = resource.baseUrl || resource.description;
          const previewModels = resource.models.slice(0, 5);
          const extraModels = resource.models.length - previewModels.length;

          return (
            <li
              key={resource.id || resource.kind}
              className={cn(
                "overflow-hidden rounded-xl border transition-colors",
                current
                  ? "border-primary/45 bg-primary/[0.04]"
                  : "border-border/75 bg-card/70 hover:border-border",
              )}
            >
              <div className="flex items-start justify-between gap-4 px-4 py-3.5">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        current ? "bg-emerald-500" : "bg-muted-foreground/35",
                      )}
                    />
                    <strong className="truncate text-[13px] font-semibold text-foreground">
                      {resource.name}
                    </strong>
                    {current && (
                      <span className="inline-flex h-5 items-center rounded-full border border-emerald-500/35 bg-emerald-500/12 px-2 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                        {codex ? "使用中" : "新线程默认"}
                      </span>
                    )}
                    {resource.kind === "official" && (
                      <span className="inline-flex h-5 items-center rounded-full border border-border/70 bg-muted/50 px-2 text-[10px] text-muted-foreground">
                        官方登录
                      </span>
                    )}
                    {resource.kind === "native" && (
                      <span className="inline-flex h-5 items-center rounded-full border border-border/70 bg-muted/50 px-2 text-[10px] text-muted-foreground">
                        原生配置
                      </span>
                    )}
                  </div>

                  {(subtitle || resource.model) && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-4 text-[11px] text-muted-foreground">
                      {subtitle && (
                        <span className={cn("truncate max-w-full", resource.baseUrl && "font-mono")}>
                          {subtitle}
                        </span>
                      )}
                      {subtitle && resource.model && <span aria-hidden="true">·</span>}
                      {resource.model && (
                        <span className="inline-flex items-center gap-1">
                          <span>默认模型</span>
                          <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                            {resource.model}
                          </code>
                        </span>
                      )}
                    </div>
                  )}

                  {!editing && previewModels.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pl-4 pt-0.5">
                      {previewModels.map((model) => (
                        <span
                          key={model}
                          className={cn(
                            "inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px]",
                            model === resource.model
                              ? "border-primary/40 bg-primary/10 text-foreground"
                              : "border-border/60 bg-muted/40 text-muted-foreground",
                          )}
                        >
                          {model}
                        </span>
                      ))}
                      {extraModels > 0 && (
                        <span className="text-[10px] text-muted-foreground">
                          +{extraModels}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {!current && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void activateResource(resource)}>
                      使用
                    </Button>
                  )}
                  {applicable && (
                    <Button size="sm" variant="secondary" disabled={busy || editing} onClick={() => void apply(resource)}>
                      应用到空闲线程
                    </Button>
                  )}
                  {resource.kind !== "official" && (
                    <>
                      <Button
                        size="icon-sm"
                        variant={editing ? "secondary" : "ghost"}
                        disabled={busy}
                        aria-label={`编辑 ${resource.name}`}
                        aria-expanded={editing}
                        title="编辑资源"
                        onClick={() => openEditor(editing ? null : resource)}
                      >
                        <HugeiconsIcon icon={PencilEdit01Icon} size={14} />
                      </Button>
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={busy}
                            aria-label={`${resource.name}的更多操作`}
                            title="更多操作"
                          >
                            ···
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-36 rounded-lg">
                          <DropdownMenuItem className="text-xs" onSelect={() => void probe(resource, true)}>
                            探测模型目录
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-xs" onSelect={() => void duplicate(resource)}>
                            复制资源
                          </DropdownMenuItem>
                          {resource.kind === "managed" && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-xs"
                                variant="destructive"
                                disabled={current}
                                onSelect={() => void remove(resource)}
                              >
                                {current ? "使用中不可删除" : "删除资源"}
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </div>
              </div>
              {renderNotice(resource.id)}
              {editing && renderEditor()}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
