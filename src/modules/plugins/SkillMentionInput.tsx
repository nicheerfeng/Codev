import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import {
  type ComponentProps,
  type PointerEvent,
  type RefObject,
  type UIEvent,
  useLayoutEffect,
  useRef,
} from "react";
import { skillHighlightSegments, type SkillRef } from "./skillMention";
import {
  applyComposerHeight,
  composerHeight,
  composerMaxHeight,
  resetComposerHeight,
  rememberComposer,
  restoreComposer,
  recallComposer,
} from "./composerCaret";

type Props = Omit<ComponentProps<"textarea">, "value" | "children"> & {
  value: string;
  skills: SkillRef[];
  composerKey?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
};

const TYPEFACE =
  "whitespace-pre-wrap break-words px-3 py-3 text-[13px]! leading-[1.5] [overflow-wrap:anywhere]";

/** 把高亮层锁到原生输入的可视盒，避免它自己折行或滚动。 */
function syncOverlay(textarea: HTMLTextAreaElement, overlay: HTMLDivElement) {
  const style = getComputedStyle(textarea);
  overlay.style.boxSizing = "border-box";
  overlay.style.font = style.font;
  overlay.style.letterSpacing = style.letterSpacing;
  overlay.style.wordSpacing = style.wordSpacing;
  overlay.style.tabSize = style.getPropertyValue("tab-size");
  overlay.style.whiteSpace = style.whiteSpace;
  overlay.style.wordBreak = style.wordBreak;
  overlay.style.overflowWrap = style.overflowWrap;
  overlay.style.padding = style.padding;
  overlay.style.width = `${textarea.clientWidth}px`;
  overlay.style.height = `${textarea.clientHeight}px`;
  overlay.scrollTop = textarea.scrollTop;
  overlay.scrollLeft = textarea.scrollLeft;
}

/** 输入行只显示 $name，已绑定技能用蓝色底标出，路径不进输入框。 */
export function SkillMentionInput({
  value,
  skills,
  composerKey = "",
  textareaRef,
  className,
  onScroll,
  onSelect,
  placeholder,
  ...props
}: Props) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const sizing = useRef(false);
  const restoring = useRef(false);
  const previousDraft = useRef({ composerKey, value });
  const segments = skillHighlightSegments(value, skills);
  const highlighted = segments.some((part) => part.skill);

  const setTextareaRef = (node: HTMLTextAreaElement | null) => {
    localRef.current = node;
    if (textareaRef) textareaRef.current = node;
  };

  const remember = (node = localRef.current) => {
    if (sizing.current || restoring.current || !node || !composerKey) return;
    if (!node.isConnected || !node.clientHeight) return;
    rememberComposer(composerKey, node);
  };

  useLayoutEffect(() => {
    const textarea = localRef.current;
    if (!textarea) return;
    // Portal 的父容器可能尚未挂到页面，先保留快照，等布局有效后恢复。
    const saved = recallComposer(composerKey);
    restoring.current = true;
    let frame = 0;
    let applied = false;
    const visible = () => textarea.isConnected && textarea.clientHeight > 0;
    const save = () => {
      if (composerKey && visible()) rememberComposer(composerKey, textarea);
    };
    const finish = () => {
      cancelAnimationFrame(frame);
      restoring.current = false;
      save();
    };
    const restore = () => {
      frame = 0;
      if (!restoring.current || !visible()) return;
      applied = true;
      restoreComposer(textarea, saved);
      const overlay = overlayRef.current;
      if (overlay) syncOverlay(textarea, overlay);
      // 覆盖本次挂载/聚焦产生的异步滚动事件，再开放记忆写入。
      frame = requestAnimationFrame(finish);
    };
    const schedule = () => {
      if (restoring.current && !applied && !frame)
        frame = requestAnimationFrame(restore);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(textarea);
    window.addEventListener("resize", schedule);
    // 用户已经开始操作时，取消待恢复任务，不能再覆盖新位置。
    const interactions = [
      "pointerdown",
      "keydown",
      "beforeinput",
      "wheel",
    ] as const;
    for (const event of interactions) textarea.addEventListener(event, finish);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      for (const event of interactions)
        textarea.removeEventListener(event, finish);
      // 已移出 Portal 的节点尺寸不可信，保留最近一次有效事件的记忆。
      if (!restoring.current) save();
      restoring.current = false;
    };
  }, [composerKey]);

  useLayoutEffect(() => {
    const textarea = localRef.current;
    if (!textarea) return;
    sizing.current = true;
    const previous = previousDraft.current;
    if (previous.composerKey === composerKey && previous.value && !value)
      resetComposerHeight(composerKey);
    previousDraft.current = { composerKey, value };
    applyComposerHeight(textarea, composerHeight(composerKey));
    sizing.current = false;
    const overlay = overlayRef.current;
    if (overlay) syncOverlay(textarea, overlay);
    const observer = new ResizeObserver(() => {
      const next = overlayRef.current;
      if (next) syncOverlay(textarea, next);
    });
    observer.observe(textarea);
    const onResize = () => {
      sizing.current = true;
      applyComposerHeight(textarea, composerHeight(composerKey));
      sizing.current = false;
    };
    window.addEventListener("resize", onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [highlighted, value, composerKey]);

  const syncScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const overlay = overlayRef.current;
    if (overlay) {
      overlay.scrollTop = event.currentTarget.scrollTop;
      overlay.scrollLeft = event.currentTarget.scrollLeft;
    }
    remember(event.currentTarget);
    onScroll?.(event);
  };

  const startResize = (event: PointerEvent<HTMLButtonElement>) => {
    const textarea = localRef.current;
    if (!textarea || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, height: textarea.clientHeight };
  };
  const moveResize = (event: PointerEvent<HTMLButtonElement>) => {
    const textarea = localRef.current;
    const start = drag.current;
    if (!textarea || !start) return;
    const next = start.height + (start.y - event.clientY);
    sizing.current = true;
    applyComposerHeight(textarea, Math.min(next, composerMaxHeight()));
    sizing.current = false;
    rememberComposer(composerKey, textarea, textarea.clientHeight);
  };
  const stopResize = () => {
    drag.current = null;
    remember();
  };

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="调整输入框高度"
        title="向上拖动加高输入框"
        className="absolute top-0 right-0 left-0 z-20 h-2 cursor-ns-resize rounded-t-2xl border-0 bg-transparent"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
      />
      {highlighted ? (
        <div
          ref={overlayRef}
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-0 left-0 overflow-hidden text-transparent",
            TYPEFACE,
          )}
        >
          {segments.map((part, index) =>
            part.skill ? (
              <span key={index} className="rounded-sm bg-sky-500/15">
                {part.text}
              </span>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )}
          {value.endsWith("\n") ? "\n" : null}
        </div>
      ) : null}
      <Textarea
        {...props}
        ref={setTextareaRef}
        value={value}
        placeholder={placeholder}
        className={cn(
          "relative z-10 min-h-24 bg-transparent! caret-sky-600",
          TYPEFACE,
          className,
        )}
        onScroll={syncScroll}
        onChange={(event) => {
          remember(event.currentTarget);
          props.onChange?.(event);
        }}
        onSelect={(event) => {
          remember(event.currentTarget);
          onSelect?.(event);
        }}
        onBlur={(event) => {
          remember(event.currentTarget);
          props.onBlur?.(event);
        }}
      />
    </div>
  );
}
