import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  FloppyDiskIcon,
  PlusSignIcon,
  Refresh01Icon,
  Search01Icon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { openSearchPanel } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { useEditorThemeExt } from "@/modules/editor/lib/useEditorThemeExt";
import { ModelRemoveButton, PiModelCard } from "./PiModelCard";
import {
  MODEL_EXAMPLE,
  PROVIDER_EXAMPLE,
  duplicateModel,
  joinModelConfig,
  mergeCardSave,
  modelDraftLabel,
  parseConfigObject,
  splitModelConfig,
  type ModelDashboard,
  type ProviderDraft,
} from "./modelDashboard";
import { useAgentStore } from "./store";
import { SettingNote, SettingSectionHeader } from "./SettingPrimitives";

type ModelFile = { path: string; content: string | null };

function publicConfig(provider: ProviderDraft) {
  const config = parseConfigObject(provider.text, "服务商配置");
  delete config.name;
  if (typeof config.apiKey === "string") delete config.apiKey;
  return JSON.stringify(config, null, 2);
}

function apiKey(provider: ProviderDraft) {
  const value = parseConfigObject(provider.text, "服务商配置").apiKey;
  return typeof value === "string" ? value : undefined;
}

export function PiModelsPanel({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<ModelDashboard | null>(null);
  const [saved, setSaved] = useState<ModelDashboard | null>(null);
  const [selected, setSelected] = useState("");
  const [path, setPath] = useState("");
  const [configs, setConfigs] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<Record<string, string | undefined>>({});
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [message, setMessage] = useState("");
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const expected = useRef<string | null>(null);
  const mounted = useRef(true);
  const publicEditor = useRef<ReactCodeMirrorRef>(null);
  const report = useAgentStore.getState().report;
  const editorTheme = useEditorThemeExt();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setBusy(true);
    void useAgentStore
      .getState()
      .command<ModelFile>("pi.models.read")
      .then((file) => {
        if (!active) return;
        const dashboard = splitModelConfig(file.content ?? '{"providers":{}}');
        expected.current = file.content;
        setPath(file.path);
        setDraft(dashboard);
        setSaved(dashboard);
        setSelected(dashboard.providers[0]?.key ?? "");
        setConfigs(
          Object.fromEntries(
            dashboard.providers.map((item) => [item.key, publicConfig(item)]),
          ),
        );
        setKeys(
          Object.fromEntries(
            dashboard.providers.map((item) => [item.key, apiKey(item)]),
          ),
        );
      })
      .catch((error) => {
        if (active) setMessage(String(error));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [reloadSeq]);

  const provider = draft?.providers.find((item) => item.key === selected);
  const savedProvider = saved?.providers.find((item) => item.key === selected);
  const providerDirty =
    !!provider &&
    (!savedProvider ||
      provider.name !== savedProvider.name ||
      configs[selected] !== publicConfig(savedProvider) ||
      keys[selected] !== apiKey(savedProvider));
  let configError = "";
  if (provider) {
    try {
      if (
        "models" in parseConfigObject(configs[selected] ?? "{}", "服务商配置")
      )
        configError = "models 请在模型区编辑";
    } catch (error) {
      configError = String(error);
    }
  }
  const dirty =
    !!draft &&
    !!saved &&
    (JSON.stringify(draft) !== JSON.stringify(saved) ||
      draft.providers.some((item) => {
        const previous = saved.providers.find(
          (value) => value.key === item.key,
        );
        return (
          !previous ||
          configs[item.key] !== publicConfig(previous) ||
          keys[item.key] !== apiKey(previous)
        );
      }));
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const updateProvider = (change: Partial<ProviderDraft>) =>
    setDraft(
      (current) =>
        current && {
          ...current,
          providers: current.providers.map((item) =>
            item.key === selected ? { ...item, ...change } : item,
          ),
        },
    );

  const write = async (next: ModelDashboard) => {
    const content = joinModelConfig(next);
    await useAgentStore
      .getState()
      .command("pi.models.save", { content, expected: expected.current });
    expected.current = content;
    setSaved(next);
    setMessage("已保存，新启动的 Pi 会话读取更新后的配置");
  };

  const save = async (modelKey?: string) => {
    if (!draft || !saved || !provider || busy) return;
    setBusy(true);
    try {
      if (modelKey && savedProvider) {
        await write(mergeCardSave(draft, saved, selected, modelKey));
        return;
      }
      const config = parseConfigObject(configs[selected] ?? "{}", "服务商配置");
      if ("models" in config) throw new Error("models 请在模型区编辑");
      delete config.name;
      const secret = keys[selected];
      if (secret !== undefined) config.apiKey = secret;
      const prepared = {
        ...draft,
        providers: draft.providers.map((item) =>
          item.key === selected
            ? {
                ...item,
                text: JSON.stringify({ name: item.name, ...config }, null, 2),
              }
            : item,
        ),
      };
      const next = mergeCardSave(prepared, saved, selected, modelKey);
      await write(next);
      if (!modelKey) setDraft(prepared);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (modelKey?: string) => {
    if (!draft || !saved || busy) return;
    const removeFrom = (value: ModelDashboard): ModelDashboard => ({
      ...value,
      providers: modelKey
        ? value.providers.map((item) =>
            item.key === selected
              ? {
                  ...item,
                  models: item.models.filter((model) => model.key !== modelKey),
                }
              : item,
          )
        : value.providers.filter((item) => item.key !== selected),
    });
    setBusy(true);
    try {
      const nextSaved = removeFrom(saved);
      if (JSON.stringify(nextSaved) !== JSON.stringify(saved))
        await write(nextSaved);
      const next = removeFrom(draft);
      setDraft(next);
      if (!modelKey) setSelected(next.providers[0]?.key ?? "");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const addProvider = () => {
    if (!draft) return;
    let name = "provider";
    let index = 2;
    while (draft.providers.some((item) => item.name === name))
      name = `provider-${index++}`;
    const item: ProviderDraft = {
      key: crypto.randomUUID(),
      name,
      text: PROVIDER_EXAMPLE,
      hasModels: true,
      models: [],
    };
    setDraft({
      ...draft,
      hasProviders: true,
      providers: [...draft.providers, item],
    });
    setConfigs((value) => ({ ...value, [item.key]: publicConfig(item) }));
    setKeys((value) => ({ ...value, [item.key]: undefined }));
    setSelected(item.key);
  };

  const testModels = async (modelKey?: string) => {
    if (!saved || testing) return;
    const jobs = saved.providers.flatMap((item) =>
      item.models
        .filter((model) => !modelKey || model.key === modelKey)
        .map((model) => ({ provider: item.name, model })),
    );
    if (!jobs.length) {
      setMessage("请先保存需要测试的模型");
      return;
    }
    setTesting(true);
    try {
      for (const job of jobs) {
        if (!mounted.current) break;
        try {
          const modelId = String(
            parseConfigObject(job.model.text, "模型").id ?? "",
          );
          setTestResults((value) => ({ ...value, [job.model.key]: "测试中…" }));
          const result = await useAgentStore
            .getState()
            .command<{ elapsedMs: number }>("pi.models.test", {
              provider: job.provider,
              modelId,
            });
          setTestResults((value) => ({
            ...value,
            [job.model.key]: `可用 · ${result.elapsedMs} ms`,
          }));
        } catch (error) {
          setTestResults((value) => ({
            ...value,
            [job.model.key]: `失败 · ${String(error)}`,
          }));
        }
      }
    } finally {
      setTesting(false);
    }
  };

  if (!draft || !saved)
    return <SettingNote>{message || "正在读取模型配置…"}</SettingNote>;
  return (
    <div className="agent-model-settings space-y-4">
      <SettingSectionHeader
        title="服务商与模型配置"
        count={draft.providers.length}
        description="编辑 ~/.pi/agent/models.json 的服务商与模型清单，新启动或重连 Pi 会话后生效。"
        actions={
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy || testing}
              title="重新读取配置"
              aria-label="重新读取配置"
              onClick={() => {
                if (
                  !dirty ||
                  window.confirm("重新读取会放弃未保存的模型配置，继续？")
                )
                  setReloadSeq((value) => value + 1);
              }}
            >
              <HugeiconsIcon icon={Refresh01Icon} size={15} />
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || testing}
              onClick={() => void testModels()}
            >
              {testing ? "测试中…" : "测试全部"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || testing}
              onClick={addProvider}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} /> 添加服务商
            </Button>
          </>
        }
      />

      {draft.providers.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border/75 bg-muted/30 p-1.5"
          role="tablist"
          aria-label="服务商"
        >
          {draft.providers.map((item) => {
            const active = item.key === selected;
            return (
              <Button
                key={item.key}
                role="tab"
                aria-selected={active}
                size="sm"
                disabled={busy || testing}
                variant={active ? "secondary" : "ghost"}
                className="h-7 gap-1.5 px-2.5 text-xs"
                onClick={() => {
                  setSelected(item.key);
                  setShowKey(false);
                }}
              >
                <span className="truncate max-w-36">{item.name}</span>
                <span className="rounded-md bg-background/80 px-1.5 py-0.2 text-[10px] text-muted-foreground">
                  {item.models.length}
                </span>
              </Button>
            );
          })}
        </div>
      )}

      {provider && (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">
              公共配置与模型清单 · {provider.models.length} 个模型
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || testing}
              onClick={() =>
                updateProvider({
                  hasModels: true,
                  models: [
                    ...provider.models,
                    { key: crypto.randomUUID(), text: MODEL_EXAMPLE },
                  ],
                })
              }
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} /> 新增模型
            </Button>
          </div>
          <div className="agent-model-grid">
            <section
              key={provider.key}
              className="agent-model-public-card"
              aria-label="公共配置"
              onKeyDownCapture={(event) => {
                if (
                  (event.ctrlKey || event.metaKey) &&
                  event.key.toLowerCase() === "s"
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!busy && !testing && providerDirty) void save();
                }
                if (
                  (event.ctrlKey || event.metaKey) &&
                  event.key.toLowerCase() === "f"
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  if (publicEditor.current?.view)
                    openSearchPanel(publicEditor.current.view);
                }
              }}
            >
              <div className="agent-model-card-heading">
                <span>公共</span>
                <Input
                  aria-label="服务商名称"
                  className="agent-model-provider-name"
                  disabled={busy || testing}
                  value={provider.name}
                  onChange={(event) =>
                    updateProvider({ name: event.target.value })
                  }
                />
                {providerDirty && (
                  <span
                    className="agent-model-dirty"
                    title="未保存"
                    aria-label="未保存"
                  />
                )}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title="搜索公共配置"
                  aria-label="搜索公共配置"
                  onClick={() => {
                    if (publicEditor.current?.view)
                      openSearchPanel(publicEditor.current.view);
                  }}
                >
                  <HugeiconsIcon icon={Search01Icon} size={13} />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={busy || testing || !providerDirty}
                  title="保存公共配置"
                  aria-label="保存公共配置"
                  onClick={() => void save()}
                >
                  <HugeiconsIcon icon={FloppyDiskIcon} size={13} />
                </Button>
                <ModelRemoveButton
                  label="删除服务商"
                  disabled={busy || testing}
                  onRemove={() => void remove()}
                />
              </div>
              <div className="agent-model-key">
                <span>API Key</span>
                <Input
                  aria-label="API Key"
                  disabled={busy || testing}
                  type={showKey ? "text" : "password"}
                  value={keys[selected] ?? ""}
                  autoComplete="off"
                  onChange={(event) =>
                    setKeys((value) => ({
                      ...value,
                      [selected]: event.target.value,
                    }))
                  }
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                  title={showKey ? "隐藏 API Key" : "显示 API Key"}
                  onClick={() => setShowKey(!showKey)}
                >
                  <HugeiconsIcon
                    icon={showKey ? ViewOffIcon : ViewIcon}
                    size={14}
                  />
                </Button>
              </div>
              <div className="agent-model-public-editor">
                <CodeMirror
                  ref={publicEditor}
                  value={configs[selected] ?? ""}
                  onChange={(text) =>
                    setConfigs((value) => ({ ...value, [selected]: text }))
                  }
                  height="100%"
                  className="h-full"
                  theme={editorTheme}
                  extensions={[json(), EditorView.lineWrapping]}
                  editable={!busy && !testing}
                  basicSetup={{
                    highlightActiveLine: false,
                    highlightSelectionMatches: false,
                    foldGutter: true,
                  }}
                />
              </div>
              {configError && (
                <p role="status" className="agent-model-config-error">
                  {configError}
                </p>
              )}
            </section>
            {provider.models.map((model) => {
              const label = modelDraftLabel(model);
              return (
                <PiModelCard
                  key={model.key}
                  label={`模型 ${label.detail}`}
                  title={
                    <span className="block truncate" title={label.detail}>
                      {label.title}
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {label.detail}
                      </span>
                    </span>
                  }
                  text={model.text}
                  error={label.valid ? "" : label.detail}
                  dirty={
                    savedProvider?.models.find((item) => item.key === model.key)
                      ?.text !== model.text
                  }
                  busy={busy || testing}
                  onChange={(text) =>
                    updateProvider({
                      models: provider.models.map((item) =>
                        item.key === model.key ? { ...item, text } : item,
                      ),
                    })
                  }
                  onSave={() => void save(model.key)}
                  onRemove={() => void remove(model.key)}
                  onDuplicate={() => {
                    try {
                      updateProvider({
                        models: [
                          ...provider.models,
                          duplicateModel(provider, model),
                        ],
                      });
                    } catch (error) {
                      report(error);
                    }
                  }}
                  onTest={() => void testModels(model.key)}
                  testStatus={testResults[model.key]}
                />
              );
            })}
          </div>
        </>
      )}
      {!provider && (
        <SettingNote>
          暂无服务商，点击右上角「添加服务商」创建配置。
        </SettingNote>
      )}
      {message && <SettingNote role="status">{message}</SettingNote>}
      {path && (
        <p className="font-mono text-[10px] text-muted-foreground [overflow-wrap:anywhere]">
          配置文件：{path}
        </p>
      )}
    </div>
  );
}
