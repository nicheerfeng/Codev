import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PlusSignIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  File01Icon,
  Tick02Icon,
  Folder01Icon,
} from "@hugeicons/core-free-icons";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ZoomableImage } from "@/modules/reader/ZoomableImage";
import type { Draft, Session, Model, Skill } from "./protocol";
import { useCodexComposerDropStore } from "./codexComposerDropStore";
import { ingestPaths, isImagePath } from "./attachments";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  mergePromptHistory,
  shouldRecallPrevious,
  shouldRecallNext,
} from "./promptHistory";
import type { CodexClient } from "./client";
import { Tool } from "./controls";
import { CODEX_COMMANDS, parseCommand } from "./commands";
import { SANDBOX_LABELS, sandboxMode, type SandboxMode } from "./sandbox";
import { listResources } from "./resources";

/** 将剪贴板图片读成官方 image 输入支持的数据 URL。 */
function imageUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** 沿用 Pi 的输入卡片、模型弹层、附件和发送按钮布局。 */
export function CodexComposer({
  session,
  client,
  models,
  connected,
  onSelect,
}: {
  session: Session;
  client: CodexClient;
  models: Model[];
  connected: boolean;
  onSelect: (id: string) => void;
}) {
  const id = session.thread.id;
  const dropHover = useCodexComposerDropStore(
    (state) => state.hover && state.hoverKey === id,
  );
  const input = useRef<HTMLTextAreaElement>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const commandList = useRef<HTMLDivElement>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsError, setSkillsError] = useState("");
  const [skillsLoading, setSkillsLoading] = useState(false);
  const { skillsRevision, resourceId } = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
  );
  const [resourceName, setResourceName] = useState<{ id: string; alias: string } | null>(null);
  // 打开模型菜单时读取生效资源的别名，避免显示设置中尚未应用的选择。
  useEffect(() => {
    if (!modelOpen) return;
    let cancelled = false;
    void listResources().then(catalog => {
      const resource = catalog.resources.find(item => item.id === resourceId);
      if (!cancelled && resource) setResourceName({ id: resourceId, alias: resource.alias });
    }).catch(error => toast.error(String(error)));
    return () => { cancelled = true; };
  }, [modelOpen, resourceId]);
  const slashOpen = !commandDismissed && /^\/[^\s]*$/.test(session.draft);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 原生 skills/changed 事件要求重新读取目录。
  useEffect(() => {
    if (!slashOpen || !connected) return;
    let cancelled = false;
    setSkills([]);
    setSkillsError("");
    setSkillsLoading(true);
    void client
      .listSkills(session.thread.cwd)
      .then((result) => {
        if (!cancelled) {
          setSkills(result.skills);
          setSkillsError(result.error);
        }
      })
      .catch((error) => {
        if (!cancelled) setSkillsError(String(error));
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, connected, session.thread.cwd, slashOpen, skillsRevision]);
  const commands: Array<{ name: string; description: string; skill?: Skill }> =
    [
      ...CODEX_COMMANDS,
      ...skills.map((skill) => ({
        name: skill.name,
        description: skill.shortDescription || skill.description,
        skill,
      })),
    ].filter((command) =>
      command.name
        .toLowerCase()
        .startsWith(session.draft.slice(1).toLowerCase()),
    );
  const showCommands = slashOpen;
  useLayoutEffect(() => {
    if (showCommands)
      commandList.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
  }, [showCommands, commandIndex]);
  const recall = useRef(-1);
  const previousDraft = useRef<Draft | null>(null);
  const history = mergePromptHistory(
    session.submitted,
    session.thread.turns.flatMap((turn) => turn.items),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: 附件或停止恢复完成后聚焦原线程。
  useEffect(() => {
    if (session.focusRevision) input.current?.focus();
  }, [session.focusRevision]);
  const selectedModel = session.model || session.thread.model || "";
  const model = models.find((item) => item.model === selectedModel);
  const activeModel = model ?? (!selectedModel ? models.find((item) => item.isDefault) : undefined);
  const effectiveMode = sandboxMode(session.effectiveSandbox);
  const effectiveLabel = effectiveMode
    ? SANDBOX_LABELS[effectiveMode]
    : session.effectiveSandbox?.type === "externalSandbox"
      ? "外部沙箱"
      : "未启动";
  const disabled = !connected || !session.loaded || commandBusy;
  const payload = Boolean(
    session.draft.trim() ||
      session.attachments.length ||
      session.images.length ||
      session.skills.length,
  );
  useLayoutEffect(() => {
    const el = input.current;
    if (el) {
      el.style.height = "0px";
      el.style.height = `${Math.min(180, Math.max(72, el.scrollHeight))}px`;
    }
  }, [session.draft]);
  /** 选择文件后以路径附件呈现，发送时由 Codex 读取。 */
  const attach = async () => {
    const paths = await open({ multiple: true });
    if (paths)
      await ingestPaths(
        client,
        id,
        paths.map((path) => ({ path, kind: "file" })),
      );
  };
  /** 发送成功前保留草稿，恢复输入焦点。 */
  const send = async (mode: "followUp" | "steer" = "followUp") => {
    if (disabled) return;
    recall.current = -1;
    const command = parseCommand(session.draft);
    if (command) {
      if (!CODEX_COMMANDS.some((item) => item.name === command.name)) {
        toast.error(`暂不支持 /${command.name}，输入 / 查看可用命令`);
        return;
      }
      if (
        command.argument ||
        session.attachments.length ||
        session.skills.length ||
        session.images.length
      ) {
        toast.error("该命令不接受附加参数或附件");
        return;
      }
      if (session.busy && command.name !== "stop") {
        toast.error("请等待当前任务结束后执行此命令");
        return;
      }
      setCommandBusy(true);
      try {
        if (command.name === "compact") await client.compact(id);
        if (command.name === "fork") onSelect(await client.fork(id));
        if (command.name === "new")
          onSelect(await client.create(session.thread.cwd));
        if (command.name === "model") setModelOpen(true);
        if (command.name === "stop") {
          client.patch(id, { draft: "" });
          await client.stopAndRestore(id);
        } else client.patch(id, { draft: "" });
        setCommandDismissed(true);
      } catch (error) {
        toast.error(String(error));
      } finally {
        setCommandBusy(false);
      }
    } else {
      await client.submit(id, mode);
    }
    input.current?.focus();
  };
  /** 补全命令后保留焦点，第二次 Enter 才执行，与 Pi 菜单交互一致。 */
  const chooseCommand = (command: { name: string; skill?: Skill }) => {
    if (command.skill) {
      const skill = command.skill;
      client.patch(id, {
        draft: "",
        skills: [
          ...session.skills.filter((selected) => selected.path !== skill.path),
          skill,
        ],
      });
    } else client.patch(id, { draft: `/${command.name}` });
    setCommandDismissed(true);
    input.current?.focus();
  };
  return (
    <footer className="codex-composer-footer">
      {session.queue.length > 0 && (
        <div
          className="reader-scrollbar mx-auto mb-2 max-h-32 max-w-3xl overflow-auto rounded-lg border border-border/70 px-2 py-1.5 text-xs"
          aria-label="待发送队列"
          role="region"
        >
          <div className="flex justify-between text-muted-foreground">
            <span>待发送 · {session.queue.length}</span>
            {session.queueError && (
              <button type="button" onClick={() => client.retryQueue(id)}>
                重试队列
              </button>
            )}
          </div>
          {session.queueError && (
            <p role="alert" className="text-destructive">
              {session.queueError}
            </p>
          )}
          {session.queue.map((entry) => (
            <div key={entry.id} className="flex items-start gap-2 py-1">
              <span className="min-w-0 flex-1 whitespace-pre-wrap">
                {entry.draft || "附件任务"}
                {entry.attachments.length +
                  entry.images.length +
                  entry.skills.length >
                0
                  ? " · 含附件"
                  : ""}
              </span>
              {(["steer", "edit", "delete"] as const).map((action) => (
                <button
                  type="button"
                  key={action}
                  disabled={session.sending}
                  aria-label={
                    {
                      steer: "安排到当前步骤之后",
                      edit: "退回编辑",
                      delete: "删除排队消息",
                    }[action]
                  }
                  onClick={() =>
                    void client
                      .queueAction(id, entry.id, action)
                      .catch((error) => toast.error(String(error)))
                  }
                >
                  {{ steer: "追加", edit: "编辑", delete: "删除" }[action]}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div
        data-codex-composer-drop=""
        className={`codex-composer-card ${dropHover ? "ring-2 ring-primary bg-accent/40" : ""}`}
      >
        {dropHover && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-2xl bg-accent/90 text-xs">
            添加到此线程
          </div>
        )}
        {showCommands && (
          <div
            ref={commandList}
            role="listbox"
            aria-label="Codex 命令"
            className="reader-scrollbar absolute bottom-full z-20 mb-2 max-h-52 w-full overflow-auto rounded-xl border border-border bg-popover p-1 shadow-md"
          >
            {commands.map((command, index) => (
              <button
                key={command.skill?.path ?? `command:${command.name}`}
                type="button"
                role="option"
                aria-selected={index === commandIndex % commands.length}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs ${index === commandIndex % commands.length ? "bg-accent" : "hover:bg-accent"}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseCommand(command)}
                title={command.skill?.path}
              >
                <span>/{command.name}</span>
                {command.skill && (
                  <span className="shrink-0 text-muted-foreground">
                    {
                      {
                        user: "全局",
                        repo: "项目",
                        system: "系统",
                        admin: "管理员",
                      }[command.skill.scope]
                    }
                  </span>
                )}
                <span className="truncate text-muted-foreground">
                  {command.description}
                </span>
              </button>
            ))}
            {skillsLoading && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                正在读取项目与全局技能…
              </p>
            )}
            {skillsError && (
              <p role="alert" className="px-3 py-2 text-xs text-destructive">
                技能读取失败：{skillsError}
              </p>
            )}
            {!skillsLoading && !commands.length && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                没有匹配的命令或技能
              </p>
            )}
          </div>
        )}
        {(session.attachments.length > 0 ||
          session.images.length > 0 ||
          session.skills.length > 0) && (
          <div className="codex-attachments reader-scrollbar">
            {session.skills.map((skill) => (
              <span
                key={skill.path}
                className="codex-file-chip"
                title={skill.path}
              >
                <span className="truncate">
                  {skill.name} ·{" "}
                  {
                    {
                      user: "全局",
                      repo: "项目",
                      system: "系统",
                      admin: "管理员",
                    }[skill.scope]
                  }
                </span>
                <Tool
                  icon={Cancel01Icon}
                  label={`移除技能 ${skill.name}`}
                  onClick={() =>
                    client.patch(id, {
                      skills: session.skills.filter(
                        (selected) => selected.path !== skill.path,
                      ),
                    })
                  }
                />
              </span>
            ))}
            {session.images.map((url, index) => (
              <div key={url} className="relative">
                <ZoomableImage
                  src={url}
                  alt={`待发送图片 ${index + 1}`}
                  className="h-16 max-w-24 rounded-lg object-cover"
                />
                <Button
                  variant="secondary"
                  size="icon-xs"
                  className="absolute -top-1 -right-1"
                  aria-label={`移除图片 ${index + 1}`}
                  onClick={() =>
                    client.patch(id, {
                      images: session.images.filter((_, i) => i !== index),
                    })
                  }
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={12} />
                </Button>
              </div>
            ))}
            {session.attachments.map((path) => (
              <span key={path} className="codex-file-chip" title={path}>
                {isImagePath(path) ? (
                  <ZoomableImage
                    src={convertFileSrc(path)}
                    alt="待发送图片"
                    className="h-12 max-w-20 rounded-lg"
                  />
                ) : (
                  <HugeiconsIcon
                    icon={
                      session.directories.includes(path)
                        ? Folder01Icon
                        : File01Icon
                    }
                    size={14}
                  />
                )}
                <span className="truncate">
                  {path.replace(/\\/g, "/").split("/").pop()}
                </span>
                <Tool
                  icon={Cancel01Icon}
                  label={`移除 ${path.replace(/\\/g, "/").split("/").pop()}`}
                  onClick={() =>
                    client.patch(id, {
                      attachments: session.attachments.filter(
                        (p) => p !== path,
                      ),
                    })
                  }
                />
              </span>
            ))}
          </div>
        )}
        <Textarea
          ref={input}
          aria-label="发送给 Codex"
          placeholder={
            session.busy
              ? "追加任务，或输入 / 命令…"
              : "描述任务，或输入 / 命令…"
          }
          disabled={disabled}
          value={session.draft}
          className="codex-prompt reader-scrollbar min-h-18 max-h-45 rounded-none border-0 bg-transparent! px-3 py-3 text-[13px]! shadow-none focus-visible:ring-0 [field-sizing:fixed]"
          onChange={(event) => {
            recall.current = -1;
            setCommandIndex(0);
            setCommandDismissed(false);
            client.patch(id, { draft: event.target.value });
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith("image/"),
            );
            if (!files.length) return;
            event.preventDefault();
            void Promise.all(files.map(imageUrl))
              .then((images) =>
                client.patch(id, {
                  images: [
                    ...client.getSnapshot().sessions[id].images,
                    ...images,
                  ],
                }),
              )
              .catch((error) => toast.error(String(error)));
          }}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (showCommands && event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setCommandDismissed(true);
              return;
            }
            if (
              showCommands &&
              commands.length > 0 &&
              ["ArrowUp", "ArrowDown", "Tab", "Escape", "Enter"].includes(
                event.key,
              ) &&
              !event.shiftKey
            ) {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") setCommandDismissed(true);
              else if (
                event.key === "Enter" &&
                !commands[commandIndex % commands.length].skill &&
                session.draft ===
                  `/${commands[commandIndex % commands.length].name}`
              ) {
                void send();
              } else if (event.key === "Tab" || event.key === "Enter")
                chooseCommand(commands[commandIndex % commands.length]);
              else
                setCommandIndex(
                  (current) =>
                    (current +
                      (event.key === "ArrowUp" ? -1 : 1) +
                      commands.length) %
                    commands.length,
                );
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!disabled && payload)
                void send(
                  event.ctrlKey || event.metaKey ? "steer" : "followUp",
                );
            }
            const caret = input.current?.selectionStart ?? 0;
            if (
              event.key === "ArrowUp" &&
              shouldRecallPrevious({
                showCommands,
                browsing: recall.current >= 0,
                text: session.draft,
                caret,
              })
            ) {
              if (recall.current + 1 < history.length) {
                event.preventDefault();
                if (recall.current < 0)
                  previousDraft.current = {
                    draft: session.draft,
                    attachments: session.attachments,
                    images: session.images,
                    skills: session.skills,
                    directories: session.directories,
                  };
                client.patch(id, {
                  draft: history[++recall.current],
                  attachments: [],
                  images: [],
                  skills: [],
                  directories: [],
                });
                requestAnimationFrame(() =>
                  input.current?.setSelectionRange(0, 0),
                );
              }
            }
            if (
              event.key === "ArrowDown" &&
              shouldRecallNext({
                showCommands,
                browsing: recall.current >= 0,
                text: session.draft,
                caret,
              })
            ) {
              event.preventDefault();
              client.patch(
                id,
                --recall.current < 0
                  ? previousDraft.current!
                  : { draft: history[recall.current] },
              );
              requestAnimationFrame(() => {
                const length = input.current?.value.length ?? 0;
                input.current?.setSelectionRange(length, length);
              });
            }
          }}
        />
        <div className="flex min-w-0 flex-wrap items-center gap-1 px-2 pb-2">
          <Tool
            icon={PlusSignIcon}
            label="添加附件"
            disabled={disabled}
            onClick={() =>
              void attach().catch((error) => toast.error(String(error)))
            }
          />
          <Popover open={modelOpen} onOpenChange={setModelOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                disabled={disabled}
                title="选择模型"
                aria-label="选择模型"
                className="min-w-0 max-w-[min(240px,50%)] gap-1 text-xs"
              >
                <span className="truncate">
                  {model?.displayName ||
                    selectedModel ||
                    activeModel?.displayName ||
                    "默认模型"}
                </span>
                <HugeiconsIcon icon={ArrowDown01Icon} size={11} />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              collisionPadding={8}
              className="w-80 max-w-[calc(100vw-24px)] gap-1 rounded-xl p-2"
            >
              <Input
                aria-label="搜索模型"
                placeholder="搜索模型"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                className="mb-2 h-8 rounded-lg text-xs!"
              />
              {client.getSnapshot().modelCatalogError && <p className="px-2 py-1 text-xs text-muted-foreground">{client.getSnapshot().modelCatalogError}</p>}
              <div className="reader-scrollbar max-h-60 overflow-auto">
                <div className="px-3 py-2 text-xs text-muted-foreground break-words">
                  资源方：{resourceName?.id === resourceId ? resourceName.alias : "读取中…"}
                </div>
                {models
                  .filter((item) =>
                    `${item.displayName} ${item.model}`
                      .toLowerCase()
                      .includes(filter.toLowerCase()),
                  )
                  .map((item) => (
                    <Button
                      key={item.id}
                      variant="ghost"
                      aria-current={
                        session.model === item.model ? "true" : undefined
                      }
                      className={`h-auto w-full justify-start gap-2 rounded-lg py-2 text-left ${session.model === item.model ? "bg-accent" : ""}`}
                      onClick={() => {
                        void client
                          .selectModel(id, item.model, item.defaultReasoningEffort || session.effort || "medium")
                          .catch((error) => toast.error(String(error)));
                        setModelOpen(false);
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs">
                          {item.displayName?.trim() || item.model}
                        </span>
                        {item.displayName?.trim() && item.displayName.trim() !== item.model && <span className="block truncate text-[10px] text-muted-foreground">{item.model}</span>}
                      </span>
                      {session.model === item.model && (
                        <HugeiconsIcon icon={Tick02Icon} size={14} />
                      )}
                    </Button>
                  ))}
              </div>
            </PopoverContent>
          </Popover>
          {(
            <Select
              value={session.effort || "medium"}
              onValueChange={(value) =>
                void client
                  .selectModel(
                    id,
                    selectedModel,
                    value,
                  )
                  .catch((error) => toast.error(String(error)))
              }
              disabled={disabled}
            >
              <SelectTrigger
                size="sm"
                className="h-6 max-w-24 bg-transparent px-1 text-[11px]"
                aria-label="思考等级"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                side="top"
                position="popper"
                className="rounded-xl"
              >
                {[...new Set([...(activeModel?.supportedReasoningEfforts.length ? activeModel.supportedReasoningEfforts.map(option => option.reasoningEffort) : ["none", "minimal", "low", "medium", "high", "xhigh", "max"]), session.effort || "medium"])].map((effort) => (
                  <SelectItem
                    key={effort}
                    value={effort}
                  >
                    {effort}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={session.sandbox}
            onValueChange={(value) =>
              client.patch(id, {
                sandbox: value as SandboxMode,
              })
            }
            disabled={disabled}
          >
            <SelectTrigger
              size="sm"
              className="h-6 max-w-32 bg-transparent px-1 text-[11px]"
              aria-label="沙箱等级"
              title="沙箱等级，下一轮生效"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top" position="popper" className="rounded-xl">
              {(Object.keys(SANDBOX_LABELS) as SandboxMode[]).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {SANDBOX_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {session.compacting ? (
              <span className="text-[10px] text-muted-foreground">
                正在压缩上下文
              </span>
            ) : (
              session.tokenUsage && (
                <span
                  className="px-1 text-[10px] text-muted-foreground"
                  title={`${session.tokenUsage.last.totalTokens.toLocaleString()} tokens · 累计 ${session.tokenUsage.total.totalTokens.toLocaleString()}`}
                >
                  {session.tokenUsage.modelContextWindow
                    ? `${Math.round((session.tokenUsage.last.totalTokens / session.tokenUsage.modelContextWindow) * 100)}%`
                    : `${session.tokenUsage.last.totalTokens.toLocaleString()} tokens`}
                </span>
              )
            )}
            {session.busy && (
              <Button
                variant="secondary"
                className="rounded-full"
                data-running-stop="true"
                size="icon-sm"
                title="停止"
                aria-label="停止"
                disabled={
                  !session.turnId || session.sending || session.stopping
                }
                onClick={() =>
                  void client
                    .stopAndRestore(id)
                    .catch((error) => toast.error(String(error)))
                }
              >
                <span className="size-2.5 rounded-xs bg-current" />
              </Button>
            )}
            {session.busy && (
              <Button
                size="icon-sm"
                className="rounded-full"
                variant="ghost"
                aria-label="当前步骤完成后继续"
                title="当前步骤完成后继续"
                disabled={disabled || !payload}
                onClick={() => void send("followUp")}
              >
                <HugeiconsIcon icon={ArrowDown01Icon} size={16} />
              </Button>
            )}
            <Button
              size="icon-sm"
              className="rounded-full"
              title={session.busy ? "追加消息" : "发送"}
              aria-label={session.busy ? "追加消息" : "发送"}
              disabled={
                disabled ||
                session.sending ||
                (session.busy && !session.turnId) ||
                !payload
              }
              onClick={() => void send(session.busy ? "steer" : "followUp")}
            >
              <HugeiconsIcon icon={ArrowUp01Icon} size={17} />
            </Button>
          </div>
        </div>
      </div>
      <div className="mx-auto mt-1.5 flex max-w-3xl flex-wrap items-center gap-2 px-1 text-[10px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={session.thread.cwd}>
          {session.thread.cwd}
        </span>
        {session.busy && <span className="shrink-0">运行中</span>}
        <span className="shrink-0">
          {session.busy ? "Enter 排队 · Ctrl/⌘ + Enter 追加" : "Enter 发送"} ·
          Shift + Enter 换行
        </span>
        {session.effectiveSandbox && (
          <span className="shrink-0" title="服务端生效的沙箱等级">
            {effectiveLabel}
          </span>
        )}
      </div>
    </footer>
  );
}
