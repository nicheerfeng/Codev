import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VoiceInputButton } from "@/modules/voice/VoiceInputButton";
import { SkillMentionInput } from "@/modules/plugins/SkillMentionInput";
import type { SkillRef } from "@/modules/plugins/skillMention";
import { ZoomableImage } from "@/modules/reader/ZoomableImage";
import {
  addPathAttachments,
  draftHasPayload,
  withAttachmentPrompt,
} from "@/modules/plugins/pi-agent/piAttachments";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUp01Icon, StopIcon } from "@hugeicons/core-free-icons";
import { useAgentStore } from "./store";
import { ContextViz } from "./ContextViz";
import { choices, isBusy, type AgentImage, type SessionView } from "./types";

const EMPTY = {
  text: "",
  images: [] as AgentImage[],
  files: [] as Array<{ kind: "file" | "dir"; path: string; name: string }>,
};

type MentionTrigger = { kind: "file"; start: number; end: number; query: string };

function detectTrigger(text: string, cursor: number): MentionTrigger | null {
  const before = text.slice(0, cursor);
  const fileMatch = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (fileMatch) {
    const query = fileMatch[1] ?? "";
    return {
      kind: "file",
      start: cursor - query.length - 1,
      end: cursor,
      query,
    };
  }
  return null;
}

async function readImage(file: File): Promise<AgentImage> {
  if (
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
      file.type,
    ) ||
    file.size > 3.5 * 1024 * 1024
  )
    throw new Error("请选择不超过 3.5 MiB 的 PNG、JPEG、WebP 或 GIF 图片");
  const data = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < data.length; i += 8192)
    binary += String.fromCharCode(...data.subarray(i, i + 8192));
  const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { type: "image", id, data: btoa(binary), mimeType: file.type };
}
export function AgentComposer({ session }: { session: SessionView }) {
  const draft = useAgentStore((s) => s.drafts[session.id] ?? EMPTY);
  const connected = useAgentStore((s) => s.connection === "connected");
  const mobile = useAgentStore((s) => s.mobile);
  const cwd = useAgentStore(
    (s) => s.workspaces.find((w) => w.id === session.workspaceId)?.cwd ?? "",
  );
  const input = useRef<HTMLTextAreaElement>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [sending, setSending] = useState(false);
  const [ime, setIme] = useState(false);
  const [skills, setSkills] = useState<SkillRef[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<
    Array<{ path: string; isDir: boolean }>
  >([]);
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [editingQueueIdx, setEditingQueueIdx] = useState<number | null>(null);
  const [editingQueueText, setEditingQueueText] = useState("");
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const historyIndex = useRef(-1);
  const historyDraft = useRef<typeof EMPTY | null>(null);

  useEffect(() => {
    if (!connected || !session.workspaceId) return;
    let cancelled = false;
    void useAgentStore
      .getState()
      .command<{ skills?: SkillRef[] }>("workspace.skills", {
        workspaceId: session.workspaceId,
      })
      .then((res) => {
        if (!cancelled && Array.isArray(res?.skills)) setSkills(res.skills);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connected, session.workspaceId]);

  useEffect(() => {
    if (!connected || trigger?.kind !== "file" || !session.workspaceId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void useAgentStore
        .getState()
        .command<{ files?: Array<{ path: string; isDir: boolean }> }>(
          "workspace.files",
          { workspaceId: session.workspaceId, query: trigger.query },
        )
        .then((res) => {
          if (!cancelled && Array.isArray(res?.files)) {
            setWorkspaceFiles(res.files);
          }
        })
        .catch(() => undefined);
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connected, session.workspaceId, trigger?.kind, trigger?.query]);
  const readHistory = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(`codev.agent.prompts:${session.id}`) ?? "[]");
      return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, 50) : [];
    } catch { return []; }
  };
  const recordPrompt = (text: string) => {
    const value = text.trim();
    if (!value) return;
    try {
      const next = [value, ...readHistory().filter((item) => item !== value)].slice(0, 50);
      localStorage.setItem(`codev.agent.prompts:${session.id}`, JSON.stringify(next));
    } catch { /* optional prompt history */ }
    historyIndex.current = -1;
    historyDraft.current = null;
  };
  const recall = (direction: -1 | 1) => {
    const prompts = readHistory();
    if (!prompts.length) return;
    const next = historyIndex.current + direction;
    if (next < -1 || next >= prompts.length) return;
    if (next === -1) {
      update(historyDraft.current ?? EMPTY);
      historyDraft.current = null;
    } else {
      if (historyIndex.current === -1)
        historyDraft.current = {
          text: draft.text,
          images: [...draft.images],
          files: [...(draft.files ?? [])],
        };
      update({ text: prompts[next], images: [], files: [] });
    }
    historyIndex.current = next;
    requestAnimationFrame(() => {
      const node = input.current;
      if (!node) return;
      const position = direction === -1 ? node.value.length : 0;
      node.setSelectionRange(position, position);
    });
  };
  const busy = isBusy(session);
  const configDisabled =
    busy || !connected || !session.instanceId || session.readOnly;
  const update = (patch: Partial<typeof draft>) =>
    useAgentStore.getState().setDraft(session.id, patch);
  const report = useAgentStore.getState().report;
  const action = (operation: string, payload: unknown = {}) =>
    useAgentStore
      .getState()
      .command(operation, payload, session.id)
      .catch(report);
  const visibleFiles =
    trigger?.kind === "file" ? workspaceFiles.slice(0, 30) : [];

  const applyFileSuggestion = (item: { path: string; isDir: boolean }) => {
    if (!trigger || trigger.kind !== "file") return;
    const before = draft.text.slice(0, trigger.start).replace(/\s+$/u, "");
    const after = draft.text.slice(trigger.end).replace(/^\s+/u, "");
    const joined = [before, after].filter(Boolean).join(" ");
    const fullPath = cwd ? `${cwd.replace(/[\\/]+$/, "")}/${item.path}` : item.path;
    const nextFiles = addPathAttachments(draft.files ?? [], [
      { path: fullPath, kind: item.isDir ? "dir" : "file" },
    ]);
    update({ text: joined ? `${joined} ` : "", files: nextFiles });
    setTrigger(null);
    input.current?.focus();
  };
  const addImages = async (files: File[]) => {
    try {
      const images = await Promise.all(files.map(readImage));
      const current = useAgentStore.getState().drafts[session.id] ?? EMPTY;
      if (current.images.length + images.length > 4)
        throw new Error("每条消息最多 4 张图片");
      if (
        [...current.images, ...images].reduce(
          (sum, image) => sum + image.data.length,
          0,
        ) >
        12 * 1024 * 1024
      )
        throw new Error("图片合计过大，请减少图片后发送");
      update({ images: [...current.images, ...images] });
    } catch (error) {
      report(error);
    }
  };
  const send = async (steer = false) => {
    if (
      sending ||
      !connected ||
      session.readOnly ||
      !draftHasPayload(draft)
    )
      return;
    const original = {
      text: draft.text,
      images: [...draft.images],
      files: [...(draft.files ?? [])],
    };
    const finalText = withAttachmentPrompt(original.text, original.files);
    setSending(true);
    try {
      await useAgentStore.getState().command(
        "session.prompt",
        {
          text: finalText,
          images: original.images,
          queue: busy && !steer,
          steer: busy && steer,
        },
        session.id,
      );
      recordPrompt(original.text);
      setPasteNotice(null);
      setTrigger(null);
      const current = useAgentStore.getState().drafts[session.id];
      if (
        current?.text === original.text &&
        current.images.length === original.images.length &&
        (current.files?.length ?? 0) === original.files.length
      )
        update(EMPTY);
      input.current?.focus();
    } catch (error) {
      report(error);
    } finally {
      setSending(false);
    }
  };
  return (
    <footer className="agent-composer-wrap">
      {session.state === "compacting" && (
        <div className="agent-compacting" role="status"><span className="agent-state-dot is-working" />正在压缩上下文…</div>
      )}
      {!!session.queue.length && (
        <div className="agent-queue-list">
          {session.queue.slice(0, 6).map((item, idx) => (
            <div className="agent-queue" key={item.id || `${idx}:${item.text.slice(0, 80)}`}>
              <span className="shrink-0">
                {item.imageCount ? `图片 ${item.imageCount}` : `#${idx + 1}`}
              </span>
              {editingQueueIdx === idx ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action("session.queue.update", {
                      id: item.id,
                      index: idx,
                      text: editingQueueText,
                    });
                    setEditingQueueIdx(null);
                  }}
                >
                  <Input
                    autoFocus
                    className="h-6 flex-1 text-xs!"
                    value={editingQueueText}
                    onChange={(e) => setEditingQueueText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditingQueueIdx(null);
                    }}
                  />
                  <button type="submit">保存</button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate">{item.text}</span>
                  <button
                    type="button"
                    title="立即插队发送给当前代理"
                    onClick={() =>
                      void action("session.queue.steer", { id: item.id, index: idx })
                    }
                  >
                    插队
                  </button>
                  <button
                    type="button"
                    title="编辑排队内容"
                    onClick={() => {
                      setEditingQueueIdx(idx);
                      setEditingQueueText(item.text);
                    }}
                  >
                    编辑
                  </button>
                  {idx > 0 && (
                    <button
                      type="button"
                      title="上移"
                      onClick={() =>
                        void action("session.queue.move", { from: idx, to: idx - 1 })
                      }
                    >
                      ↑
                    </button>
                  )}
                  <button
                    type="button"
                    title="移除此条排队消息"
                    onClick={() =>
                      void action("session.queue.remove", { id: item.id, index: idx })
                    }
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          ))}
          <div className="agent-queue">
            <span>共 {session.queue.length} 条待发送</span>
            <span className="min-w-0 flex-1" />
            <button type="button" onClick={() => void action("session.queue.clear")}>清空队列</button>
          </div>
        </div>
      )}
      <div className="agent-composer" data-agent-composer={session.id}>
        {!!draft.images.length && (
          <div className="agent-images">
            {draft.images.map((image, index) => (
              <div key={image.id ?? `${image.mimeType}:${image.data.slice(-24)}`}>
                <ZoomableImage
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={`待发送图片 ${index + 1}`}
                />
                <button
                  type="button"
                  aria-label={`移除图片 ${index + 1}`}
                  onClick={() =>
                    update({
                      images: draft.images.filter((_, i) => i !== index),
                    })
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {!!draft.files?.length && (
          <div className="agent-draft-files">
            {draft.files.map((item) => (
              <span key={item.path} className="agent-draft-file-chip" title={item.path}>
                <span className="opacity-65">{item.kind === "dir" ? "目录" : "文件"}</span>
                <span className="max-w-44 truncate">{item.name}</span>
                <button
                  type="button"
                  aria-label={`移除 ${item.name}`}
                  onClick={() =>
                    update({
                      files: (draft.files ?? []).filter((f) => f.path !== item.path),
                    })
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {pasteNotice && (
          <div className="flex items-center justify-between px-3 pt-1.5 text-[10px] text-muted-foreground">
            <span>{pasteNotice}</span>
            <button type="button" onClick={() => setPasteNotice(null)}>
              ×
            </button>
          </div>
        )}
        <SkillMentionInput
          textareaRef={input}
          composerKey={session.id}
          skills={skills}
          aria-label="给当前代理发送任务"
          placeholder={
            session.readOnly
              ? "这份原生历史当前只读"
              : session.instanceId
                ? "输入任务；支持 @ 文件引用、$ 技能、拖拽文件或粘贴图片…"
                : "输入任务，发送时连接原生代理…"
          }
          className="agent-prompt reader-scrollbar min-h-18 rounded-none border-0! bg-transparent! px-3 py-3 text-[13px]! shadow-none! outline-none! ring-0! focus-visible:border-0! focus-visible:ring-0! [field-sizing:fixed]"
          value={draft.text}
          disabled={session.readOnly || !connected}
          onChange={(e) => {
            const val = e.target.value;
            const pos = e.target.selectionStart ?? val.length;
            update({ text: val });
            const nextTrigger = detectTrigger(val, pos);
            setTrigger(nextTrigger);
            setMenuIndex(0);
          }}
          onCompositionStart={() => setIme(true)}
          onCompositionEnd={() => setIme(false)}
          onKeyDown={(e) => {
            const listCount = trigger?.kind === "file" ? visibleFiles.length : 0;
            if (listCount > 0 && trigger?.kind === "file") {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMenuIndex((i) => (i + 1) % listCount);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMenuIndex((i) => (i - 1 + listCount) % listCount);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setTrigger(null);
                return;
              }
              if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && !ime && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const chosen = visibleFiles[menuIndex % listCount];
                if (chosen) applyFileSuggestion(chosen);
                return;
              }
            }
            if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !ime && !e.nativeEvent.isComposing) {
              const node = e.currentTarget;
              const atStart = node.selectionStart === 0 && node.selectionEnd === 0;
              const atEnd = node.selectionStart === node.value.length && node.selectionEnd === node.value.length;
              if ((e.key === "ArrowUp" && atStart) || (e.key === "ArrowDown" && atEnd)) {
                e.preventDefault();
                recall(e.key === "ArrowUp" ? 1 : -1);
                return;
              }
            }
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !ime &&
              !e.nativeEvent.isComposing &&
              !mobile
            ) {
              e.preventDefault();
              void send(e.ctrlKey || e.metaKey);
            }
          }}
          onPaste={(e) => {
            const txt = e.clipboardData.getData("text");
            if (txt.length > 8000) {
              setPasteNotice(`已粘贴长文本（${txt.length} 字符）`);
            }
            if (!session.capabilities.supportsImages) return;
            const images = Array.from(e.clipboardData.files).filter((f) =>
              f.type.startsWith("image/"),
            );
            if (images.length) {
              e.preventDefault();
              void addImages(images);
            }
          }}
        />
        {visibleFiles.length > 0 && trigger?.kind === "file" && (
          <div className="agent-command-list reader-scrollbar">
            {visibleFiles.map((item, idx) => (
              <button
                type="button"
                key={item.path}
                className={idx === menuIndex % visibleFiles.length ? "is-active" : ""}
                onClick={() => applyFileSuggestion(item)}
              >
                <span className="flex items-center gap-2">
                  <span className="agent-cmd-tag">{item.isDir ? "目录" : "文件"}</span>
                  <span>{item.path}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="agent-composer-controls">
          {session.capabilities.supportsModelSelection && (
            <Popover open={modelOpen} onOpenChange={setModelOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={configDisabled}
                  className="agent-model-trigger"
                  title={
                    session.model
                      ? `${session.model.provider ?? ""} / ${session.model.id}`
                      : "选择当前代理的模型"
                  }
                >
                  {session.model?.name || session.model?.id || "选择模型"}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 max-w-[90vw] p-2">
                <Input
                  autoFocus
                  placeholder="搜索当前代理模型"
                  aria-label="搜索当前代理模型"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="mb-2 h-8 text-xs!"
                />
                <div className="reader-scrollbar max-h-64 overflow-y-auto">
                  {session.models
                    .filter((m) =>
                      `${m.provider ?? ""} ${m.name ?? ""} ${m.id}`
                        .toLowerCase()
                        .includes(filter.toLowerCase()),
                    )
                    .map((model) => (
                      <button
                        key={`${model.provider}:${model.id}`}
                        className="agent-model-option"
                        type="button"
                        aria-current={
                          model.id === session.model?.id &&
                          model.provider === session.model?.provider
                        }
                        onClick={() => {
                          setModelOpen(false);
                          void action("session.model", {
                            provider: model.provider,
                            modelId: model.id,
                          });
                        }}
                      >
                        <span>{model.name || model.id}</span>
                        <small>
                          {model.provider ? `${model.provider} / ` : ""}
                          {model.id}
                        </small>
                      </button>
                    ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
          {session.capabilities.supportsThinking && (
            <label className="agent-setting-pill" title="调节模型推理深度">
              <span className="agent-setting-pill-label">思考</span>
              <select
                aria-label="思考等级"
                disabled={configDisabled}
                value={session.thinkingLevel}
                onChange={(e) =>
                  void action("session.thinking", { level: e.target.value })
                }
              >
                {session.thinkingLevels.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
          )}
          {session.configOptions
            .filter(
              (o) =>
                o.category !== "model" &&
                o.category !== "thought_level" &&
                o.category !== "thinking" &&
                !o.id.includes("thinking") &&
                o.id !== "model",
            )
            .map((option) => {
              const optionChoices = choices(option);
              if (option.type === "boolean") {
                const checked = option.currentValue === "true";
                return (
                  <label
                    key={option.id}
                    className="agent-setting-pill cursor-pointer"
                    title={option.name}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={configDisabled}
                      onChange={(e) =>
                        void action("session.config", {
                          configId: option.id,
                          value: e.target.checked ? "true" : "false",
                        })
                      }
                    />
                    <span className="agent-setting-pill-label">{option.name}</span>
                  </label>
                );
              }
              if (!optionChoices.length) return null;
              return (
                <label
                  key={option.id}
                  className="agent-setting-pill"
                  title={option.name}
                >
                  <span className="agent-setting-pill-label">{option.name}</span>
                  <select
                    aria-label={option.name}
                    disabled={configDisabled}
                    value={option.currentValue}
                    onChange={(e) =>
                      void action("session.config", {
                        configId: option.id,
                        value: e.target.value,
                      })
                    }
                  >
                    {optionChoices.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.name || choice.label || choice.value}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          {!mobile && (
            <VoiceInputButton
              disabled={!connected || session.readOnly}
              onText={(text) => {
                const current =
                  useAgentStore.getState().drafts[session.id]?.text ?? "";
                update({
                  text: `${current}${current && !/\s$/.test(current) ? " " : ""}${text}`,
                });
                input.current?.focus();
              }}
            />
          )}
          <span className="flex-1" />
          <ContextViz
            session={session}
            onCompact={() => void action("session.compact")}
          />
          {busy && (
            <Button
              size="icon-sm"
              variant="secondary"
              className="rounded-full"
              title="停止当前任务"
              aria-label="停止当前任务"
              disabled={!connected || session.state === "stopping"}
              onClick={() => void action("session.cancel")}
            >
              <HugeiconsIcon icon={StopIcon} size={14} />
            </Button>
          )}
          {(!busy || session.capabilities.supportsQueue) && (
            <Button
              size="icon-sm"
              className="rounded-full"
              title={busy ? "加入发送队列" : "发送"}
              aria-label={busy ? "加入发送队列" : "发送"}
              disabled={
                sending ||
                !connected ||
                session.readOnly ||
                !draftHasPayload(draft)
              }
              onClick={() => void send(false)}
            >
              <HugeiconsIcon icon={ArrowUp01Icon} size={16} />
            </Button>
          )}
        </div>
      </div>
      <div className="agent-composer-note">
        <span title={cwd}>{cwd}</span>
        <span>
          {session.readOnly
            ? "原生历史 · 只读"
            : mobile
              ? "点击箭头发送"
              : busy
                ? "Enter 排队 · Ctrl+Enter 插队 · 顶边可调高"
                : "Shift+Enter 换行 · @ 文件 · 顶边可调高"}
        </span>
      </div>
    </footer>
  );
}
