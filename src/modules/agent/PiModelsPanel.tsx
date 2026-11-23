import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HugeiconsIcon } from "@hugeicons/react";
import { ViewIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { PiModelCard } from "@/modules/plugins/pi-agent/PiModelCard";
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
} from "@/modules/plugins/pi-agent/modelDashboard";
import { useAgentStore } from "./store";

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
  const report = useAgentStore.getState().report;

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
    if (
      !draft ||
      !saved ||
      busy ||
      !window.confirm(modelKey ? "删除此模型？" : "删除此服务商及其模型？")
    )
      return;
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
    return (
      <p className="agent-settings-note">{message || "正在读取模型配置…"}</p>
    );
  return (
    <div className="agent-model-settings">
      <div className="agent-provider-tabs">
        {draft.providers.map((item) => (
          <Button
            key={item.key}
            size="sm"
            disabled={busy || testing}
            variant={item.key === selected ? "secondary" : "ghost"}
            onClick={() => {
              setSelected(item.key);
              setShowKey(false);
            }}
          >
            {item.name} <small>{item.models.length}</small>
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || testing}
          onClick={addProvider}
        >
          添加服务商
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || testing}
          onClick={() => {
            if (
              !dirty ||
              window.confirm("重新读取会放弃未保存的模型配置，继续？")
            )
              setReloadSeq((value) => value + 1);
          }}
        >
          重新读取
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || testing}
          onClick={() => void testModels()}
        >
          测试全部
        </Button>
      </div>
      {provider && (
        <>
          <div className="agent-model-provider">
            <div className="flex items-center gap-2">
              <strong className="flex-1">
                公共配置{providerDirty ? " · 未保存" : ""}
              </strong>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || testing}
                onClick={() => void remove()}
              >
                删除服务商
              </Button>
              <Button
                size="sm"
                disabled={busy || testing || !providerDirty}
                onClick={() => void save()}
              >
                保存
              </Button>
            </div>
            <label>
              服务商名称
              <Input
                disabled={busy || testing}
                value={provider.name}
                onChange={(event) =>
                  updateProvider({ name: event.target.value })
                }
              />
            </label>
            <label>
              API Key
              <div className="flex gap-2">
                <Input
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
                  size="icon-sm"
                  variant="ghost"
                  aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                  title={showKey ? "隐藏 API Key" : "显示 API Key"}
                  onClick={() => setShowKey(!showKey)}
                >
                  <HugeiconsIcon icon={showKey ? ViewOffIcon : ViewIcon} size={14} />
                </Button>
              </div>
            </label>
            <label>
              其他配置
              <textarea
                disabled={busy || testing}
                rows={5}
                value={configs[selected] ?? ""}
                spellCheck={false}
                onChange={(event) =>
                  setConfigs((value) => ({
                    ...value,
                    [selected]: event.target.value,
                  }))
                }
              />
            </label>
          </div>
          <div className="flex items-center gap-2 py-2">
            <strong className="flex-1">模型</strong>
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
              添加模型
            </Button>
          </div>
          <div className="agent-model-grid">
            {provider.models.map((model) => {
              const label = modelDraftLabel(model);
              return (
                <PiModelCard
                  key={model.key}
                  label={`模型 ${label.detail}`}
                  title={label.title}
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
      {message && (
        <p role="status" className="agent-settings-note">
          {message}
        </p>
      )}
      <small className="text-muted-foreground">{path}</small>
    </div>
  );
}
