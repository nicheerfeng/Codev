import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
} from "@hugeicons/core-free-icons";
import type { PiImage, PiViewState } from "./types";
import { PI_LOCAL_COMMANDS } from "./commands";

export type PiDraft = { text: string; images: PiImage[] };
export const EMPTY_DRAFT: PiDraft = { text: "", images: [] };
type Props = {
  draft: PiDraft;
  onChange: (value: PiDraft) => void;
  view: PiViewState;
  onSend: (behavior: "steer" | "followUp") => void;
  onStop: () => void;
  onModel: (provider: string, id: string) => void;
  onLoadModels: () => void;
  onThinking: (level: string) => void;
  onSettings: () => void;
  onError: (error: unknown) => void;
  busy: boolean;
  disabled: boolean;
  project: string;
  status?: string;
  notice?: string;
  onDismissNotice?: () => void;
  focusRevision?: number;
};

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
  const input = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const draftRef = useRef(props.draft);
  draftRef.current = props.draft;
  const [modelFilter, setModelFilter] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const commandList = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    commandList.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [commandIndex]);
  const [commandDismissed, setCommandDismissed] = useState(false);
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
    commands.length > 0;
  /** 选择命令后保留输入焦点，允许补写参数再发送。 */
  const chooseCommand = (name: string) => {
    props.onChange({ ...props.draft, text: `/${name} ` });
    setCommandIndex(0);
    input.current?.focus();
  };
  useLayoutEffect(() => {
    if (props.focusRevision) input.current?.focus();
  }, [props.focusRevision]);
  const running =
    props.view.status === "running" || props.view.status === "stopping";
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(180, Math.max(72, node.scrollHeight))}px`;
  }, [props.draft.text]);
  /** 保留读取期间新输入的文字，追加图片后聚焦原输入框。 */
  const addImages = async (selected: File[]) => {
    try {
      const images = await Promise.all(
        selected
          .filter((file) => file.type.startsWith("image/"))
          .map(readImage),
      );
      props.onChange({
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
      {props.status && (
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
          {props.view.queue.steering.map((text, index) => (
            <div
              className="pi-queue-item"
              key={`steer-${index}-${text}`}
            >
              <span className="pi-queue-mode">插入</span>
              <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {text}
              </span>
            </div>
          ))}
          {props.view.queue.followUp.map((text, index) => (
            <div
              className="pi-queue-item"
              key={`follow-up-${index}-${text}`}
            >
              <span className="pi-queue-mode">排队</span>
              <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {text}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="relative mx-auto w-full max-w-3xl rounded-2xl border border-border bg-card shadow-sm focus-within:border-ring/60">
        {showCommands && (
          <div
            ref={commandList}
            role="listbox"
            aria-label="Pi 命令"
            className="reader-scrollbar absolute bottom-full z-20 mb-2 max-h-52 w-full overflow-auto rounded-xl border border-border bg-popover p-1 shadow-md"
          >
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
        {!!props.draft.images.length && (
          <div className="flex max-h-28 flex-wrap gap-2 overflow-auto px-3 pt-3">
            {props.draft.images.map((item, index) => (
              <div
                key={`${index}-${item.data.slice(-16)}`}
                className="relative"
              >
                <img
                  className="h-16 max-w-24 rounded-lg object-cover"
                  src={`data:${item.mimeType};base64,${item.data}`}
                  alt={`待发送图片 ${index + 1}`}
                />
                <Button
                  variant="secondary"
                  size="icon-xs"
                  className="absolute -top-1 -right-1"
                  aria-label={`移除图片 ${index + 1}`}
                  onClick={() =>
                    props.onChange({
                      ...props.draft,
                      images: props.draft.images.filter((_, i) => i !== index),
                    })
                  }
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
          onChange={(event) => {
            setCommandIndex(0);
            setCommandDismissed(false);
            props.onChange({ ...props.draft, text: event.target.value });
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
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              if (
                !props.busy &&
                (props.draft.text.trim() || props.draft.images.length)
              )
                props.onSend(
                  running && (event.ctrlKey || event.metaKey)
                    ? "steer"
                    : "followUp",
                );
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
                  {props.view.model?.name || props.view.model?.id || "选择模型"}
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
              <div className="reader-scrollbar max-h-60 overflow-auto">
                {!props.view.models.length && (
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
                {props.view.models
                  .filter((model) =>
                    `${model.provider}/${model.id} ${model.name ?? ""}`
                      .toLowerCase()
                      .includes(modelFilter.toLowerCase()),
                  )
                  .map((model) => (
                    <Button
                      key={`${model.provider}/${model.id}`}
                      variant="ghost"
                      className="h-auto w-full justify-start rounded-lg py-2 text-left"
                      onClick={() => {
                        props.onModel(model.provider, model.id);
                        setModelOpen(false);
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs">
                          {model.name || model.id}
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {model.provider} / {model.id}
                        </span>
                      </span>
                    </Button>
                  ))}
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
              <SelectContent className="rounded-xl">
                {props.view.thinkingLevels.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {props.view.contextPercent !== null && (
              <span
                className="px-1 text-[10px] text-muted-foreground"
                title={`${props.view.contextTokens?.toLocaleString() ?? "—"} tokens · 上下文 ${props.view.contextPercent.toFixed(1)}%`}
              >
                {Math.round(props.view.contextPercent)}%
              </span>
            )}
            {running && (
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
            <Button
              size="icon-sm"
              className="rounded-full"
              title={running ? "排队发送" : "发送"}
              aria-label={running ? "排队发送" : "发送"}
              disabled={
                props.disabled ||
                props.busy ||
                (!props.draft.text.trim() && !props.draft.images.length)
              }
              onClick={() => props.onSend("followUp")}
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
          <span className="shrink-0">Enter 排队 · Ctrl/Cmd + Enter 插入</span>
        ) : (
          <span className="shrink-0">Shift + Enter 换行</span>
        )}
      </div>
    </footer>
  );
}
