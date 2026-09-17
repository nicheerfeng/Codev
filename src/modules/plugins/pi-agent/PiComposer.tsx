import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUp01Icon,
  PlusSignIcon,
  Cancel01Icon,
  ArrowDown01Icon,
  PencilEdit01Icon,
  Delete02Icon,
  Tick02Icon,
  File01Icon,
  Folder01Icon,
} from "@hugeicons/core-free-icons";
import { ZoomableImage } from "@/modules/reader/ZoomableImage";
import type { PiImage, PiModel, PiViewState } from "./types";
import { PI_LOCAL_COMMANDS } from "./commands";
import { draftHasPayload, EMPTY_DRAFT, type PiDraft } from "./piAttachments";
import { usePiComposerDropStore } from "./piComposerDropStore";
import {
  mergePromptHistory,
  nextHistoryIndex,
  prependPrompt,
  shouldRecallNext,
  shouldRecallPrevious,
} from "./promptHistory";

export type { PiDraft } from "./piAttachments";
export { EMPTY_DRAFT } from "./piAttachments";
type Props = {
  draft: PiDraft;
  onChange: (value: PiDraft) => void;
  view: PiViewState;
  onSend: (behavior: "steer" | "followUp") => void;
  onStop: () => void;
  onLocalQueueAction?: (id: string, action: "edit" | "delete") => void;
  onRetryQueue?: () => void;
  onQueueAction: (
    kind: "steering" | "followUp",
    index: number,
    text: string,
    action: "edit" | "delete" | "steer",
  ) => void;
  onModel: (provider: string, id: string) => void;
  onLoadModels: () => void;
  onLoadCommands?: () => Promise<void>;
  onThinking: (level: string) => void;
  onSettings: () => void;
  onError: (error: unknown) => void;
  busy: boolean;
  disabled: boolean;
  project: string;
  catalogModel?: PiModel | null;
  catalogModels?: PiModel[];
  status?: string;
  notice?: string;
  onDismissNotice?: () => void;
  focusRevision?: number;
};

function modelTitle(model: PiModel): string {
  return model.name?.trim() || model.id;
}

function ComposerDropHover() {
  const hover = usePiComposerDropStore((state) => state.hover);
  if (!hover) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-2xl border border-sky-400 ring-1 ring-sky-400/40"
    />
  );
}

function duplicateModelTitles(models: PiModel[]): Set<string> {
  const counts = new Map<string, number>();
  for (const model of models) {
    const title = modelTitle(model);
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([title]) => title),
  );
}

/** 将粘贴或选择的图片转成 Pi 原生图片输入。 */
async function readImage(file: File): Promise<PiImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return { type: "image", data: btoa(binary), mimeType: file.type };
}

/** 用 Codev 控件承载 mcode 输入卡片布局：正文上方、模型/用量与发送在卡片内。 */
export function PiComposer(props: Props) {
  const catalogModels = props.view.models.length
    ? props.view.models
    : (props.catalogModels ?? []);
  const catalogModel =
    props.view.model ?? props.catalogModel ?? catalogModels[0] ?? null;
  const selectedModelKey = catalogModel
    ? `${catalogModel.provider}/${catalogModel.id}`
    : "";
  const repeatedTitles = duplicateModelTitles(catalogModels);
  const compacting = props.view.compaction?.status === "running";
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!compacting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [compacting]);
  const input = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const draftRef = useRef(props.draft);
  draftRef.current = props.draft;
  const [submitted, setSubmitted] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyIndexRef = useRef(-1);
  historyIndexRef.current = historyIndex;
  const historyDraft = useRef<PiDraft | null>(null);
  const applyingHistory = useRef(false);
  const [recallRevision, setRecallRevision] = useState(0);
  const recallCaret = useRef<"start" | "end" | null>(null);
  const history = mergePromptHistory(submitted, props.view.items);
  const [modelFilter, setModelFilter] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const modelList = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!modelOpen) return;
    modelList.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [modelOpen, selectedModelKey, modelFilter]);
  const [commandIndex, setCommandIndex] = useState(0);
  const commandList = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    commandList.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [commandIndex]);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [commandsLoading, setCommandsLoading] = useState(false);
  const commandsPending = useRef(false);
  /** 打开 slash 菜单时加载原生命令，并阻止连续按键重复请求。 */
  const loadCommands = async () => {
    if (
      !props.onLoadCommands ||
      commandsPending.current ||
      props.view.commands.length
    )
      return;
    commandsPending.current = true;
    setCommandsLoading(true);
    try {
      await props.onLoadCommands();
    } catch (error) {
      props.onError(error);
    } finally {
      commandsPending.current = false;
      setCommandsLoading(false);
    }
  };
  const commands = [
    ...PI_LOCAL_COMMANDS,
    ...props.view.commands.filter(
      (command) =>
        !PI_LOCAL_COMMANDS.some((local) => local.name === command.name),
    ),
  ].filter((command) =>
    command.name
      .toLowerCase()
      .startsWith(props.draft.text.slice(1).toLowerCase()),
  );
  const showCommands =
    !commandDismissed &&
    /^\/[^\s]*$/.test(props.draft.text) &&
    (commands.length > 0 || commandsLoading);
  /** 选择命令后保留输入焦点，允许补写参数再发送。 */
  const changeDraft = (value: PiDraft) => {
    if (!applyingHistory.current && historyIndexRef.current !== -1) {
      historyIndexRef.current = -1;
      setHistoryIndex(-1);
      historyDraft.current = null;
    }
    props.onChange(value);
  };
  const recallHistory = (direction: -1 | 1) => {
    const next = nextHistoryIndex(
      historyIndexRef.current,
      direction,
      history.length,
    );
    if (next == null) return;
    applyingHistory.current = true;
    if (historyIndexRef.current === -1 && next >= 0)
      historyDraft.current = { ...draftRef.current };
    historyIndexRef.current = next;
    setHistoryIndex(next);
    if (next === -1) {
      const restored = historyDraft.current ?? EMPTY_DRAFT;
      historyDraft.current = null;
      recallCaret.current = null;
      changeDraft(restored);
    } else {
      recallCaret.current = direction === -1 ? "start" : "end";
      changeDraft({ text: history[next] ?? "", images: [], files: [] });
    }
    applyingHistory.current = false;
    setRecallRevision((value) => value + 1);
  };
  const sendDraft = (behavior: "steer" | "followUp") => {
    const text = draftRef.current.text;
    historyIndexRef.current = -1;
    setHistoryIndex(-1);
    historyDraft.current = null;
    if (text.trim()) setSubmitted((value) => prependPrompt(value, text));
    props.onSend(behavior);
  };
  const chooseCommand = (name: string) => {
    changeDraft({ ...props.draft, text: `/${name} ` });
    setCommandIndex(0);
    input.current?.focus();
  };
  useLayoutEffect(() => {
    if (props.focusRevision) input.current?.focus();
  }, [props.focusRevision]);
  const running =
    compacting ||
    props.view.status === "running" ||
    props.view.status === "stopping";
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(180, Math.max(72, node.scrollHeight))}px`;
    const caret = recallCaret.current;
    if (!caret || historyIndex < 0) return;
    const pos = caret === "start" ? 0 : node.value.length;
    node.setSelectionRange(pos, pos);
    recallCaret.current = null;
  }, [historyIndex, props.draft.text, recallRevision]);
  /** 保留读取期间新输入的文字，追加图片后聚焦原输入框。 */
  const addImages = async (selected: File[]) => {
    try {
      const images = await Promise.all(
        selected
          .filter((file) => file.type.startsWith("image/"))
          .map(readImage),
      );
      changeDraft({
        ...draftRef.current,
        images: [...draftRef.current.images, ...images],
      });
      input.current?.focus();
    } catch (error) {
      props.onError(error);
    }
  };
  return (
    <footer
      data-testid="pi-composer"
      className="shrink-0 px-3 pt-2 pb-3 @min-[700px]:px-5"
    >
      {props.notice && (
        <div
          data-testid="pi-notice"
          role="status"
          className="relative mx-auto mb-2 w-full max-w-3xl px-7 text-center text-xs leading-5 text-muted-foreground"
        >
          <div className="reader-scrollbar max-h-20 overflow-y-auto [overflow-wrap:anywhere]">
            {props.notice}
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute top-0 right-0"
            aria-label="关闭提示"
            onClick={props.onDismissNotice}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} />
          </Button>
        </div>
      )}
      {props.view.compaction && (
        <div
          role="status"
          className="mx-auto mb-2 max-w-3xl text-center text-xs text-muted-foreground"
        >
          {compacting
            ? "正在压缩上下文"
            : props.view.compaction.status === "done"
              ? "上下文已压缩"
              : "压缩未完成，待发送消息已保留"}
          {` · 用时 ${Math.max(0, Math.floor(((props.view.compaction.finishedAt ?? now) - props.view.compaction.startedAt) / 1000))} 秒`}
        </div>
      )}
      {!!props.view.localQueue?.length && (
        <div
          data-testid="pi-local-queue"
          className="reader-scrollbar mx-auto mb-2 max-h-32 max-w-3xl overflow-auto rounded-lg border border-border/70 px-2 py-1.5 text-xs"
        >
          <div className="flex items-center justify-between text-muted-foreground">
            <span>待发送 · {props.view.localQueue.length}</span>
            {!compacting && (
              <Button
                size="xs"
                variant="ghost"
                disabled={!!props.view.queueSendingId}
                onClick={props.onRetryQueue}
              >
                继续发送
              </Button>
            )}
          </div>
          {props.view.localQueue.map((item) => (
            <div key={item.id} className="flex items-start gap-2 py-1">
              <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {item.text}
                {item.images.length > 0 && ` · ${item.images.length} 张图片`}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="退回编辑待发送消息"
                disabled={props.view.queueSendingId === item.id}
                onClick={() => props.onLocalQueueAction?.(item.id, "edit")}
              >
                <HugeiconsIcon icon={PencilEdit01Icon} size={13} />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="删除待发送消息"
                disabled={props.view.queueSendingId === item.id}
                onClick={() => props.onLocalQueueAction?.(item.id, "delete")}
              >
                <HugeiconsIcon icon={Delete02Icon} size={13} />
              </Button>
            </div>
          ))}
        </div>
      )}
      {props.status && !compacting && (
        <div
          data-testid="pi-status"
          className="reader-scrollbar mx-auto mb-2 max-h-20 w-full max-w-3xl overflow-y-auto text-center text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]"
        >
          {props.status}
        </div>
      )}
      {props.view.queue.pendingCount > 0 && (
        <div
          data-testid="pi-queue"
          className="pi-queue reader-scrollbar mx-auto mb-2 max-h-28 w-full max-w-3xl overflow-y-auto rounded-lg border border-border/70 bg-muted/20 px-2 py-1.5 text-xs"
        >
          <div className="mb-1 text-[10px] text-muted-foreground">
            待处理消息 · {props.view.queue.pendingCount}
          </div>
          {(["steering", "followUp"] as const).flatMap((kind) =>
            props.view.queue[kind].map((text, index) => (
              <div className="pi-queue-item" key={`${kind}-${index}-${text}`}>
                <span className="pi-queue-mode">
                  {kind === "steering" ? "下一步" : "随后"}
                </span>
                <button
                  type="button"
                  className="min-w-0 flex-1 whitespace-pre-wrap text-left [overflow-wrap:anywhere]"
                  disabled={props.disabled || kind !== "followUp"}
                  title={kind === "followUp" ? "安排到当前步骤之后" : undefined}
                  onClick={() => {
                    if (kind === "followUp")
                      props.onQueueAction(kind, index, text, "steer");
                  }}
                >
                  {text}
                </button>
                <div className="flex shrink-0 items-center gap-0.5">
                  {kind === "followUp" && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="安排到当前步骤之后"
                      aria-label="安排到当前步骤之后"
                      disabled={props.disabled}
                      onClick={() =>
                        props.onQueueAction(kind, index, text, "steer")
                      }
                    >
                      <HugeiconsIcon icon={ArrowUp01Icon} size={13} />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="退回输入框编辑"
                    aria-label="退回编辑"
                    disabled={props.disabled}
                    onClick={() =>
                      props.onQueueAction(kind, index, text, "edit")
                    }
                  >
                    <HugeiconsIcon icon={PencilEdit01Icon} size={13} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="删除排队消息"
                    aria-label="删除排队消息"
                    disabled={props.disabled}
                    onClick={() =>
                      props.onQueueAction(kind, index, text, "delete")
                    }
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={13} />
                  </Button>
                </div>
              </div>
            )),
          )}
        </div>
      )}
      <div
        data-pi-composer-drop=""
        className="relative mx-auto w-full max-w-3xl rounded-2xl border border-border bg-card shadow-sm focus-within:border-ring/60"
      >
        <ComposerDropHover />
        {showCommands && (
          <div
            ref={commandList}
            role="listbox"
            aria-label="Pi 命令"
            className="reader-scrollbar absolute bottom-full z-20 mb-2 max-h-52 w-full overflow-auto rounded-xl border border-border bg-popover p-1 shadow-md"
          >
            {commandsLoading && (
              <div
                role="status"
                className="px-3 py-2 text-xs text-muted-foreground"
              >
                正在加载 Pi 命令…
              </div>
            )}
            {commands.map((command, index) => (
              <button
                key={command.name}
                type="button"
                role="option"
                aria-selected={index === commandIndex % commands.length}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs ${index === commandIndex % commands.length ? "bg-accent" : "hover:bg-accent"}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseCommand(command.name)}
              >
                <span>/{command.name}</span>
                <span className="truncate text-muted-foreground">
                  {command.description}
                </span>
              </button>
            ))}
          </div>
        )}
        {(!!props.draft.images.length || !!props.draft.files.length) && (
          <div className="flex max-h-28 flex-wrap gap-2 overflow-auto px-3 pt-3">
            {props.draft.images.map((item, index) => (
              <div
                key={`${index}-${item.data.slice(-16)}`}
                className="relative"
              >
                <ZoomableImage
                  className="h-16 max-w-24 rounded-lg object-cover"
                  src={`data:${item.mimeType};base64,${item.data}`}
                  alt={`待发送图片 ${index + 1}`}
                />
                <Button
                  variant="secondary"
                  size="icon-xs"
                  className="absolute -top-1 -right-1"
                  aria-label={`移除图片 ${index + 1}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    changeDraft({
                      ...props.draft,
                      images: props.draft.images.filter((_, i) => i !== index),
                    });
                  }}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={12} />
                </Button>
              </div>
            ))}
            {props.draft.files.map((item) => (
              <div
                key={item.path}
                className="relative flex max-w-48 items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2 py-1.5"
              >
                <HugeiconsIcon
                  icon={item.kind === "dir" ? Folder01Icon : File01Icon}
                  size={14}
                />
                <span
                  className="min-w-0 truncate text-[11px]"
                  title={item.path}
                >
                  {item.name}
                </span>
                <Button
                  variant="secondary"
                  size="icon-xs"
                  className="absolute -top-1 -right-1"
                  aria-label={`移除 ${item.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    changeDraft({
                      ...props.draft,
                      files: props.draft.files.filter(
                        (file) => file.path !== item.path,
                      ),
                    });
                  }}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={12} />
                </Button>
              </div>
            ))}
          </div>
        )}
        <Textarea
          ref={input}
          aria-label="向 Pi 发送任务"
          placeholder="描述任务，或输入 / 命令…"
          value={props.draft.text}
          className="pi-prompt reader-scrollbar min-h-18 max-h-45 rounded-none border-0 bg-transparent! px-3 py-3 text-[13px]! shadow-none focus-visible:ring-0 [field-sizing:fixed]"
          disabled={props.disabled}
          onFocus={() => {
            if (props.draft.text.startsWith("/")) void loadCommands();
          }}
          onChange={(event) => {
            setCommandIndex(0);
            setCommandDismissed(false);
            if (event.target.value.startsWith("/")) void loadCommands();
            changeDraft({ ...props.draft, text: event.target.value });
          }}
          onPaste={(event) => {
            const images = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith("image/"),
            );
            if (images.length) {
              event.preventDefault();
              void addImages(images);
            }
          }}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (
              showCommands &&
              event.key === "Enter" &&
              !event.shiftKey &&
              props.draft.text !==
                `/${commands[commandIndex % commands.length].name}`
            ) {
              event.preventDefault();
              chooseCommand(commands[commandIndex % commands.length].name);
              return;
            }
            if (
              showCommands &&
              ["ArrowUp", "ArrowDown", "Tab", "Escape"].includes(event.key)
            ) {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") setCommandDismissed(true);
              else if (event.key === "Tab")
                chooseCommand(commands[commandIndex % commands.length].name);
              else
                setCommandIndex(
                  (value) =>
                    (value +
                      (event.key === "ArrowUp" ? -1 : 1) +
                      commands.length) %
                    commands.length,
                );
              return;
            }
            const caret = event.currentTarget.selectionStart ?? 0;
            if (
              event.key === "ArrowUp" &&
              shouldRecallPrevious({
                showCommands,
                browsing: historyIndex !== -1,
                text: props.draft.text,
                caret,
              })
            ) {
              event.preventDefault();
              recallHistory(-1);
              return;
            }
            if (
              event.key === "ArrowDown" &&
              shouldRecallNext({
                showCommands,
                browsing: historyIndex !== -1,
                text: props.draft.text,
                caret,
              })
            ) {
              event.preventDefault();
              recallHistory(1);
              return;
            }
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              if (!draftHasPayload(props.draft)) return;
              const insert = running && (event.ctrlKey || event.metaKey);
              if (insert || !props.busy || compacting)
                sendDraft(insert ? "steer" : "followUp");
            }
          }}
        />
        <div className="flex min-w-0 flex-wrap items-center gap-1 px-2 pb-2">
          <input
            ref={files}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              void addImages([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            title="添加图片"
            aria-label="添加图片"
            disabled={props.disabled}
            onClick={() => files.current?.click()}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={14} />
          </Button>
          <Popover
            open={modelOpen}
            onOpenChange={(value) => {
              setModelOpen(value);
              if (value) props.onLoadModels();
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                className="min-w-0 max-w-[min(240px,50%)] gap-1 text-xs"
                title="选择模型"
              >
                <span className="truncate">
                  {catalogModel?.name || catalogModel?.id || "选择模型"}
                </span>
                <HugeiconsIcon icon={ArrowDown01Icon} size={11} />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-72 max-w-[calc(100vw-2rem)] rounded-xl p-2"
            >
              <Input
                aria-label="搜索模型"
                placeholder="搜索模型"
                value={modelFilter}
                onChange={(event) => setModelFilter(event.target.value)}
                className="mb-2 h-8 rounded-lg text-xs!"
              />
              <div
                ref={modelList}
                className="reader-scrollbar max-h-60 overflow-auto"
              >
                {!catalogModels.length && (
                  <p
                    role="status"
                    className="px-2 py-3 text-xs text-muted-foreground"
                  >
                    {props.view.modelsLoading
                      ? "正在加载模型…"
                      : props.view.error
                        ? "模型加载失败，请查看下方提示"
                        : "暂无可用模型"}
                  </p>
                )}
                {catalogModels
                  .filter((model) =>
                    `${model.provider}/${model.id} ${model.name ?? ""}`
                      .toLowerCase()
                      .includes(modelFilter.toLowerCase()),
                  )
                  .map((model) => {
                    const selected =
                      `${model.provider}/${model.id}` === selectedModelKey;
                    const title = modelTitle(model);
                    const showId =
                      repeatedTitles.has(title) || title !== model.id;
                    return (
                      <Button
                        key={`${model.provider}/${model.id}`}
                        variant="ghost"
                        aria-current={selected ? "true" : undefined}
                        className={cn(
                          "h-auto w-full justify-start gap-2 rounded-lg py-2 text-left",
                          selected && "bg-accent text-accent-foreground",
                        )}
                        onClick={() => {
                          props.onModel(model.provider, model.id);
                          setModelOpen(false);
                        }}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs">
                            {showId ? `${title} · ${model.id}` : title}
                          </span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {model.provider} / {model.id}
                          </span>
                        </span>
                        {selected && (
                          <HugeiconsIcon
                            icon={Tick02Icon}
                            size={14}
                            className="shrink-0"
                          />
                        )}
                      </Button>
                    );
                  })}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 w-full border-t border-border text-xs"
                onClick={() => {
                  setModelOpen(false);
                  props.onSettings();
                }}
              >
                编辑 models.json
              </Button>
            </PopoverContent>
          </Popover>
          {props.view.thinkingLevels.length > 1 && (
            <Select
              value={props.view.thinkingLevel}
              onValueChange={props.onThinking}
              disabled={props.disabled}
            >
              <SelectTrigger
                size="sm"
                className="h-6 max-w-24 bg-transparent px-1 text-[11px]"
                aria-label="思考等级"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                position="popper"
                side="top"
                align="start"
                collisionPadding={8}
                className="rounded-xl"
              >
                {props.view.thinkingLevels.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {props.view.contextTokens == null &&
              props.view.compaction?.status === "done" && (
                <span
                  className="text-[10px] text-muted-foreground"
                  title="Pi 会在下一次模型回复后更新实际上下文用量"
                >
                  已压缩 · 用量待更新
                </span>
              )}
            {props.view.contextPercent != null && (
              <span
                className="px-1 text-[10px] text-muted-foreground"
                title={`${props.view.contextTokens == null ? "" : `${props.view.contextTokens.toLocaleString()} tokens · `}上下文 ${props.view.contextPercent.toFixed(1)}%`}
              >
                {`${Math.round(props.view.contextPercent)}%`}
              </span>
            )}
            {running && !compacting && (
              <Button
                variant="secondary"
                size="icon-sm"
                className="rounded-full"
                title="停止生成"
                aria-label="停止生成"
                onClick={props.onStop}
              >
                <span className="size-2.5 rounded-xs bg-current" />
              </Button>
            )}
            {running && !compacting && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-full"
                title="当前步骤完成后继续"
                aria-label="当前步骤完成后继续"
                disabled={props.disabled || !draftHasPayload(props.draft)}
                onClick={() => sendDraft("followUp")}
              >
                <HugeiconsIcon icon={ArrowDown01Icon} size={17} />
              </Button>
            )}
            <Button
              size="icon-sm"
              className="rounded-full"
              title={running ? "安排为下一步" : "发送"}
              aria-label={running ? "安排为下一步" : "发送"}
              disabled={
                props.disabled ||
                (!running && props.busy && !compacting) ||
                !draftHasPayload(props.draft)
              }
              onClick={() => sendDraft(running ? "steer" : "followUp")}
            >
              <HugeiconsIcon icon={ArrowUp01Icon} size={17} />
            </Button>
          </div>
        </div>
      </div>
      <div className="mx-auto mt-1.5 flex max-w-3xl items-center gap-2 px-1 text-[10px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={props.project}>
          {props.project || "请添加项目"}
        </span>
        {running ? (
          <span className="shrink-0">Enter 随后 · Ctrl/Cmd + Enter 下一步</span>
        ) : (
          <span className="shrink-0">Shift + Enter 换行</span>
        )}
      </div>
    </footer>
  );
}
