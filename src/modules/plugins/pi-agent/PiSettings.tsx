import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PlusSignIcon,
  Cancel01Icon,
  CpuIcon,
  HelpCircleIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { readPiModels, writePiModels } from "./native";
import {
  splitModelConfig,
  joinModelConfig,
  modelDraftLabel,
  parseConfigObject,
  mergeCardSave,
  duplicateModel,
  PROVIDER_EXAMPLE,
  MODEL_EXAMPLE,
  type ModelDashboard,
  type ProviderDraft,
  type ModelDraft,
} from "./modelDashboard";
import { PiModelCard } from "./PiModelCard";
import { PiModelsHelp } from "./PiModelsHelp";
import { testSavedModel } from "./modelTest";

/** 检查公共配置卡片，错误就地展示且不覆盖用户输入。 */
function providerError(text: string): string {
  try {
    if ("models" in parseConfigObject(text, "公共配置"))
      return "models 由模型卡片自动组成，请从公共配置移除。";
    return "";
  } catch (error) {
    return String(error);
  }
}

/** Pi 设置采用独立功能侧栏，服务商在右侧顶部平铺，配置卡片排列在下方。 */
export function PiSettings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [dashboard, setDashboard] = useState<ModelDashboard | null>(null);
  const [saved, setSaved] = useState<ModelDashboard | null>(null);
  const [providerKey, setProviderKey] = useState("");
  const [path, setPath] = useState("");
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [confirm, setConfirm] = useState(false);
  const [help, setHelp] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const testAbort = useRef<AbortController | null>(null);
  const provider = dashboard?.providers.find(
    (item) => item.key === providerKey,
  );
  const savedProvider = saved?.providers.find(
    (item) => item.key === providerKey,
  );
  const dirty =
    dashboard !== null && JSON.stringify(dashboard) !== JSON.stringify(saved);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDashboard(null);
    setSaved(null);
    setMessage("");
    setLoadError("");
    setConfirm(false);
    setTestResults({});
    void readPiModels()
      .then((file) => {
        if (cancelled) return;
        setPath(file.path);
        const next = splitModelConfig(file.content);
        setDashboard(next);
        setSaved(next);
        setProviderKey(next.providers[0]?.key ?? "");
      })
      .catch((error) => {
        if (!cancelled) setLoadError(String(error));
      });
    return () => {
      cancelled = true;
      testAbort.current?.abort();
    };
  }, [open]);
  /** 更新一项服务商草稿，其他服务商和模型编辑保持。 */
  const updateProvider = (change: Partial<ProviderDraft>) => {
    setDashboard((current) =>
      current
        ? {
            ...current,
            providers: current.providers.map((item) =>
              item.key === providerKey ? { ...item, ...change } : item,
            ),
          }
        : current,
    );
    setMessage("");
  };
  /** 手动测试单个或全部已保存模型，两路并发且不写测试会话。 */
  const testModels = async (modelKey?: string) => {
    if (!saved || testAbort.current) return;
    let jobs: { key: string; provider: string; id: string }[];
    try {
      jobs = saved.providers.flatMap((item) =>
        item.models
          .filter((model) => !modelKey || model.key === modelKey)
          .map((model) => ({
            key: model.key,
            provider: item.name,
            id: String(parseConfigObject(model.text, "模型").id),
          })),
      );
    } catch (error) {
      setMessage(String(error));
      return;
    }
    if (!jobs.length) {
      setMessage("请先保存需要测试的模型卡片。");
      return;
    }
    const abort = new AbortController();
    testAbort.current = abort;
    setTesting(true);
    setTestResults((value) => ({
      ...value,
      ...Object.fromEntries(
        jobs.map((job) => [job.key, "已保存配置 · 等待测试…"]),
      ),
    }));
    let index = 0;
    let complete = 0;
    let passed = 0;
    const cwd = path.replace(/[\\/][^\\/]+$/, "");
    /** 每个测试结束后再领取下一个模型，限制同时启动的 Pi 数量。 */
    const worker = async () => {
      while (!abort.signal.aborted && index < jobs.length) {
        const job = jobs[index++];
        setTestResults((value) => ({
          ...value,
          [job.key]: "已保存配置 · 测试中…",
        }));
        let result: string;
        try {
          result = await testSavedModel(
            cwd,
            job.provider,
            job.id,
            abort.signal,
          );
          passed++;
        } catch (error) {
          result = `失败 · ${String(error)}`;
        }
        if (abort.signal.aborted) return;
        complete++;
        setTestResults((value) => ({
          ...value,
          [job.key]: `已保存配置 · ${result}`,
        }));
        setMessage(
          `测试 ${complete}/${jobs.length} · 可用 ${passed} · 失败 ${complete - passed}`,
        );
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(2, jobs.length) }, worker),
      );
    } finally {
      if (testAbort.current === abort) {
        testAbort.current = null;
        setTesting(false);
      }
    }
  };
  /** 仅更新当前模型卡片的 JSON 文本。 */
  const updateModel = (key: string, text: string) => {
    if (provider)
      updateProvider({
        models: provider.models.map((item) =>
          item.key === key ? { ...item, text } : item,
        ),
      });
  };
  /** 添加具有独立内部标识的服务商草稿，名称可在公共配置卡修改。 */
  const addProvider = () => {
    if (!dashboard) return;
    let name = "provider";
    let index = 2;
    while (dashboard.providers.some((item) => item.name === name))
      name = `provider-${index++}`;
    const next: ProviderDraft = {
      key: crypto.randomUUID(),
      name,
      text: PROVIDER_EXAMPLE,
      hasModels: true,
      models: [],
    };
    setDashboard({
      ...dashboard,
      hasProviders: true,
      providers: [...dashboard.providers, next],
    });
    setProviderKey(next.key);
    setMessage("已添加服务商，请修改公共配置中的接口地址、协议和密钥。");
  };
  /** 新增模型卡片时仅提供必要字段，避免虚构模型能力。 */
  const addModel = () => {
    if (provider)
      updateProvider({
        hasModels: true,
        models: [
          ...provider.models,
          { key: crypto.randomUUID(), text: MODEL_EXAMPLE },
        ],
      });
  };
  /** 复制当前模型作为新卡片，重复 ID 自动添加后缀。 */
  const copyModel = (model: ModelDraft) => {
    if (!provider) return;
    try {
      updateProvider({
        models: [...provider.models, duplicateModel(provider, model)],
      });
    } catch (error) {
      setMessage(String(error));
    }
  };
  /** 仅删除已确认的卡片，其余未保存草稿保持不变。 */
  const remove = async (modelKey?: string) => {
    if (!dashboard || !saved || saving.current || testing) return;
    saving.current = true;
    setBusy(true);
    try {
      /** 在独立快照中移除目标卡片。 */
      const change = (current: ModelDashboard): ModelDashboard => ({
        ...current,
        providers: modelKey
          ? current.providers.map((item) =>
              item.key === providerKey
                ? {
                    ...item,
                    models: item.models.filter(
                      (model) => model.key !== modelKey,
                    ),
                  }
                : item,
            )
          : current.providers.filter((item) => item.key !== providerKey),
      });
      const nextSaved = change(saved);
      if (JSON.stringify(nextSaved) !== JSON.stringify(saved))
        await writePiModels(joinModelConfig(nextSaved));
      const next = change(dashboard);
      if (!next.providers.length) next.hasProviders = nextSaved.hasProviders;
      const remaining = next.providers.find((item) => item.key === providerKey);
      if (remaining && !remaining.models.length && savedProvider)
        remaining.hasModels = savedProvider.hasModels;
      setSaved(nextSaved);
      setDashboard(next);
      if (!modelKey) setProviderKey(next.providers[0]?.key ?? "");
      setMessage("已删除此卡片，其他草稿保持。");
    } catch (error) {
      setMessage(String(error));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  /** 只聚合目标卡片到已保存快照并校验写入。 */
  const save = async (modelKey?: string) => {
    if (!dashboard || !saved || saving.current || testing) return;
    saving.current = true;
    setBusy(true);
    try {
      const next = mergeCardSave(dashboard, saved, providerKey, modelKey);
      const text = joinModelConfig(next);
      await writePiModels(text);
      setSaved(next);
      setTestResults((value) =>
        Object.fromEntries(
          Object.entries(value).filter(([key]) =>
            modelKey
              ? key !== modelKey
              : !provider?.models.some((model) => model.key === key),
          ),
        ),
      );
      setMessage("此卡片已保存，其他草稿保持；新启动会话读取更新后的配置。");
    } catch (error) {
      setMessage(String(error));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  /** 关闭时提醒尚未写入文件的草稿。 */
  const close = () => {
    if (!saving.current) dirty ? setConfirm(true) : onClose();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[90vh] min-h-0 w-[calc(100%-1rem)] max-w-[1280px] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[1280px]"
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "s"
          ) {
            event.preventDefault();
            event.stopPropagation();
            setMessage(
              "请在需要保存的卡片内按 Ctrl+S，或点击该卡片的保存图标。",
            );
          }
        }}
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <DialogTitle className="flex-1 text-sm">
            Pi 设置{dirty ? " · 未保存" : ""}
          </DialogTitle>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="关闭 Pi 设置"
            title="关闭"
            disabled={busy}
            onClick={close}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} />
          </Button>
        </header>
        <DialogDescription className="sr-only">
          左侧选择设置功能，右侧选择服务商并编辑模型卡片。
        </DialogDescription>
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Pi 设置导航"
            className="w-24 shrink-0 border-r border-border bg-muted/15 p-2 sm:w-36"
          >
            <Button
              variant="secondary"
              size="sm"
              aria-current="page"
              className="w-full justify-start gap-1.5 rounded-lg px-2 text-xs"
            >
              <HugeiconsIcon icon={CpuIcon} size={14} />
              模型选择
            </Button>
          </nav>
          <main
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            aria-label="模型看板"
          >
            <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-3 sm:px-4">
              <h2 className="min-w-0 flex-1 text-sm font-medium">模型选择</h2>
              <Button
                size="sm"
                variant="ghost"
                className="text-xs"
                disabled={!saved || busy || testing}
                title="对全部已保存模型各发送一次短请求"
                onClick={() => void testModels()}
              >
                {testing ? "测试中…" : "测试全部"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="gap-1 text-xs"
                aria-haspopup="dialog"
                onClick={() => setHelp(true)}
              >
                <HugeiconsIcon icon={HelpCircleIcon} size={14} />
                使用说明
              </Button>
            </div>
            <div
              role="tablist"
              aria-label="服务商"
              className="reader-scrollbar flex max-h-[22vh] shrink-0 flex-wrap items-center gap-1.5 overflow-y-auto border-b border-border p-3 sm:px-4"
            >
              {dashboard?.providers.map((item) => (
                <Button
                  key={item.key}
                  role="tab"
                  aria-selected={providerKey === item.key}
                  aria-controls="pi-model-cards"
                  id={`provider-${item.key}`}
                  variant={providerKey === item.key ? "secondary" : "ghost"}
                  size="sm"
                  className="max-w-full gap-2 rounded-lg text-xs"
                  disabled={busy}
                  onClick={() => {
                    setProviderKey(item.key);
                    setMessage("");
                  }}
                >
                  <span className="truncate">
                    {item.name || "未命名服务商"}
                  </span>
                  <span className="text-muted-foreground">
                    {item.models.length}
                  </span>
                </Button>
              ))}
              <Button
                size="sm"
                variant="outline"
                className="gap-1 rounded-lg text-xs"
                disabled={!dashboard || busy || testing}
                onClick={addProvider}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={13} />
                增加
              </Button>
            </div>
            <div className="reader-scrollbar min-h-0 flex-1 overflow-auto p-3 sm:p-4">
              {loadError && (
                <p
                  role="alert"
                  className="text-xs text-amber-600 dark:text-amber-300"
                >
                  {loadError}
                </p>
              )}
              {!dashboard && !loadError && (
                <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
                  <Spinner />
                  正在读取模型配置…
                </div>
              )}
              {dashboard && !provider && (
                <div className="py-16 text-center text-xs text-muted-foreground">
                  暂无服务商，点击上方“增加”开始；“使用说明”中有完整步骤和样例。
                </div>
              )}
              {provider && (
                <div
                  id="pi-model-cards"
                  role="tabpanel"
                  aria-labelledby={`provider-${provider.key}`}
                >
                  <div className="mb-3 flex items-center gap-2">
                    <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                      公共配置与模型清单 · {provider.models.length} 个模型
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1 text-xs"
                      disabled={busy || testing}
                      onClick={addModel}
                    >
                      <HugeiconsIcon icon={PlusSignIcon} size={13} />
                      新增模型
                    </Button>
                  </div>
                  <div className="grid min-w-[924px] grid-cols-3 items-stretch gap-3">
                    <PiModelCard
                      key={provider.key}
                      label="公共配置"
                      title={
                        <div className="flex min-w-0 items-center gap-1">
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            公共
                          </span>
                          <Input
                            aria-label="服务商名称"
                            className="h-7 min-w-0 rounded-md border-0 bg-transparent text-xs!"
                            disabled={busy || testing}
                            value={provider.name}
                            onChange={(event) =>
                              updateProvider({ name: event.target.value })
                            }
                          />
                        </div>
                      }
                      text={provider.text}
                      error={providerError(provider.text)}
                      dirty={
                        !savedProvider ||
                        savedProvider.text !== provider.text ||
                        savedProvider.name !== provider.name
                      }
                      busy={busy || testing}
                      onChange={(text) => updateProvider({ text })}
                      onSave={() => void save()}
                      onRemove={() => void remove()}
                    />
                    {provider.models.map((model) => {
                      const label = modelDraftLabel(model);
                      return (
                        <PiModelCard
                          key={model.key}
                          label={`模型 ${label.detail}`}
                          title={
                            <span
                              className="block truncate"
                              title={label.detail}
                            >
                              {label.title}
                              <span className="block truncate text-[10px] text-muted-foreground">
                                {label.detail}
                              </span>
                            </span>
                          }
                          text={model.text}
                          error={label.valid ? "" : label.detail}
                          dirty={
                            savedProvider?.models.find(
                              (item) => item.key === model.key,
                            )?.text !== model.text
                          }
                          busy={busy || testing}
                          onTest={() => void testModels(model.key)}
                          testStatus={testResults[model.key]}
                          onChange={(text) => updateModel(model.key, text)}
                          onSave={() => void save(model.key)}
                          onDuplicate={() => copyModel(model)}
                          onRemove={() => void remove(model.key)}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <footer className="flex shrink-0 items-center gap-2 border-t border-border p-3 sm:px-4">
              <div className="min-w-0 flex-1">
                <p
                  role="status"
                  className="reader-scrollbar max-h-16 overflow-auto break-words text-xs text-muted-foreground"
                >
                  {message ||
                    (dirty
                      ? "有未保存修改 · 点击对应卡片的保存图标"
                      : "每张模型卡片独立编辑，共用上方选定服务商的公共配置")}
                </p>
                <p
                  title={path}
                  className="mt-1 truncate text-[10px] text-muted-foreground"
                >
                  {path}
                </p>
              </div>
            </footer>
          </main>
        </div>
        <Dialog open={help && open} onOpenChange={setHelp}>
          <DialogContent
            showCloseButton={false}
            className="flex max-h-[85vh] flex-col gap-3 overflow-hidden rounded-2xl sm:max-w-3xl"
          >
            <div className="flex shrink-0 items-center gap-3">
              <DialogTitle className="flex-1">模型看板使用说明</DialogTitle>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="关闭使用说明"
                onClick={() => setHelp(false)}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={16} />
              </Button>
            </div>
            <DialogDescription className="shrink-0 text-xs">
              服务商与模型的添加、单卡保存及测试步骤
            </DialogDescription>
            <PiModelsHelp />
          </DialogContent>
        </Dialog>
        <Dialog open={confirm} onOpenChange={setConfirm}>
          <DialogContent showCloseButton={false}>
            <DialogTitle>放弃未保存的修改？</DialogTitle>
            <DialogDescription>尚未保存的卡片修改将丢失。</DialogDescription>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                继续编辑
              </Button>
              <Button onClick={onClose}>放弃修改</Button>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
