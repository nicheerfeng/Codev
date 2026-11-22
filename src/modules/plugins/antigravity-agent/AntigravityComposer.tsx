import { useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUp01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { AntigravityConfigOption, AntigravityImage } from "./native";
import { useAntigravityComposerDropStore } from "./antigravityComposerDropStore";

const VISIBLE_CATEGORIES = new Set(["model", "thought_level", "mode"]);
const MAX_IMAGES = 4;

function flatten(
  option: AntigravityConfigOption,
): Array<{ value: string; name: string }> {
  return (option.options ?? []).flatMap((item) =>
    "options" in item ? item.options : [item],
  );
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** 输入区版式与 Pi 对齐；图片入口只在 CLI 声明能力时出现。 */
export function AntigravityComposer({
  sessionId,
  draft,
  busy,
  configs,
  project,
  images,
  imageEnabled,
  onDraft,
  onImages,
  onConfig,
  onSend,
  onCancel,
}: {
  sessionId: string;
  draft: string;
  busy: boolean;
  configs: AntigravityConfigOption[];
  project: string;
  images: AntigravityImage[];
  imageEnabled: boolean;
  onDraft: (text: string) => void;
  onImages: (images: AntigravityImage[]) => void;
  onConfig: (configId: string, value: string | boolean) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  const filePicker = useRef<HTMLInputElement>(null);
  const dropHover = useAntigravityComposerDropStore(
    (state) => state.hoverKey === sessionId,
  );
  const selects = configs.filter(
    (option) =>
      option.type === "select" &&
      typeof option.currentValue === "string" &&
      (VISIBLE_CATEGORIES.has(option.category ?? "") ||
        option.id === "model"),
  );
  const canSend = !busy && (draft.trim().length > 0 || images.length > 0);

  /** 只接受图片，转成 ACP 需要的 base64 数据块。 */
  const addFiles = async (files: File[]) => {
    const next = [...images];
    for (const file of files) {
      if (!file.type.startsWith("image/") || next.length >= MAX_IMAGES) break;
      try {
        const dataUrl = await readAsBase64(file);
        const comma = dataUrl.indexOf(",");
        if (comma < 0) continue;
        next.push({
          data: dataUrl.slice(comma + 1),
          mimeType: file.type || "image/png",
        });
      } catch {
        // 读取失败时跳过该图片，不影响文本草稿。
      }
    }
    onImages(next);
  };

  return (
    <footer className="shrink-0 px-3 pt-2 pb-3 @min-[700px]:px-5">
      <div
        data-antigravity-composer-drop=""
        data-antigravity-key={sessionId}
        className={cn(
          "relative mx-auto w-full max-w-3xl rounded-2xl border border-border bg-card shadow-sm focus-within:border-ring/60",
          dropHover && "border-ring ring-2 ring-primary/30",
        )}
      >
        <textarea
          aria-label="发送给 Antigravity"
          className="reader-scrollbar block max-h-40 min-h-18 w-full resize-none rounded-none border-0 bg-transparent px-3 py-3 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-0"
          placeholder="描述任务，或输入 / 命令…"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onPaste={(event) => {
            if (!imageEnabled) return;
            const files = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith("image/"),
            );
            if (!files.length) return;
            event.preventDefault();
            void addFiles(files);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (canSend) onSend();
            }
          }}
        />

        {images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pb-1">
            {images.map((image, index) => (
              <div
                key={`${image.mimeType}-${index}`}
                className="group/ag-image relative size-14 overflow-hidden rounded-lg border border-border"
              >
                <img
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={`待发送图片 ${index + 1}`}
                  className="size-full object-cover"
                />
                <button
                  type="button"
                  aria-label={`移除图片 ${index + 1}`}
                  title="移除图片"
                  className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-background/90 text-[10px] text-muted-foreground opacity-0 shadow group-hover/ag-image:opacity-100 focus-visible:opacity-100"
                  onClick={() =>
                    onImages(images.filter((_, item) => item !== index))
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex min-w-0 flex-wrap items-center gap-1 px-2 pb-2">
          {imageEnabled && (
            <>
              <input
                ref={filePicker}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => {
                  void addFiles([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
              />
              <Button
                variant="ghost"
                size="icon-xs"
                title="添加图片"
                aria-label="添加图片"
                disabled={busy || images.length >= MAX_IMAGES}
                onClick={() => filePicker.current?.click()}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={14} />
              </Button>
            </>
          )}
          {selects.map((option, index) => (
            <Select
              key={option.id}
              value={String(option.currentValue)}
              onValueChange={(value) => onConfig(option.id, value)}
            >
              <SelectTrigger
                size="sm"
                className={
                  index === 0
                    ? "h-6 max-w-40 gap-1 bg-transparent px-1 text-xs"
                    : "h-6 max-w-24 bg-transparent px-1 text-[11px] text-muted-foreground"
                }
                aria-label={option.name}
                title={option.name}
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
                {flatten(option).map((value) => (
                  <SelectItem
                    key={value.value}
                    value={value.value}
                    className="py-1.5 text-xs"
                  >
                    {value.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {busy && (
              <Button
                variant="secondary"
                size="icon-sm"
                className="rounded-full"
                title="停止生成"
                aria-label="停止生成"
                onClick={onCancel}
              >
                <span className="size-2.5 rounded-xs bg-current" />
              </Button>
            )}
            <Button
              size="icon-sm"
              className="rounded-full"
              title="发送"
              aria-label="发送"
              disabled={!canSend}
              onClick={onSend}
            >
              <HugeiconsIcon icon={ArrowUp01Icon} size={17} />
            </Button>
          </div>
        </div>
      </div>
      <div className="mx-auto mt-1.5 flex max-w-3xl items-center gap-2 px-1 text-[10px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={project}>
          {project || "请添加项目"}
        </span>
        <span className="shrink-0">
          {busy ? "Enter 随后" : "Shift + Enter 换行"}
        </span>
      </div>
    </footer>
  );
}
