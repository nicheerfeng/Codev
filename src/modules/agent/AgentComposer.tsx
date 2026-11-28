import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VoiceInputButton } from "@/modules/voice/VoiceInputButton";
import { SkillMentionInput } from "@/modules/agent/SkillMentionInput";
import { ZoomableImage } from "@/modules/reader/ZoomableImage";
import { draftHasPayload, withAttachmentPrompt } from "./attachments";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUp01Icon,
  Delete02Icon,
  PencilEdit01Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { useAgentStore, type Draft } from "./store";
import { ContextViz } from "./ContextViz";
import { BranchDropdown } from "@/modules/vcs/BranchDropdown";
import { choices, isBusy, type AgentImage, type SessionView } from "./types";

type Skill = {
  name: string;
  path: string;
  source?: string;
  description?: string;
};
type Invocation = {
  token: string;
  label: string;
  description?: string;
  group: "命令" | "技能";
  source: string;
  local?: "compact" | "fork";
};
type InvocationTrigger = {
  prefix: "/" | "$";
  start: number;
  end: number;
  query: string;
};

function invocationTrigger(
  text: string,
  cursor: number,
): InvocationTrigger | null {
  const before = text.slice(0, cursor);
  const slash = before.match(/^\/([^\s/]*)$/u);
  if (slash) return { prefix: "/", start: 0, end: cursor, query: slash[1] };
  const dollar = before.match(/(?:^|\s)\$([^\s$]*)$/u);
  if (dollar)
    return {
      prefix: "$",
      start: cursor - dollar[1].length - 1,
      end: cursor,
      query: dollar[1],
    };
  return null;
}

const EMPTY: Draft = {
  text: "",
  images: [] as AgentImage[],
  files: [] as Array<{ kind: "file" | "dir"; path: string; name: string }>,
  localCommand: null,
};

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
  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
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
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [trigger, setTrigger] = useState<InvocationTrigger | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const historyIndex = useRef(-1);
  const historyDraft = useRef<typeof EMPTY | null>(null);

  useEffect(() => {
    setSkills([]);
    setSkillsLoading(false);
    if (
      !connected ||
      !session.workspaceId ||
      session.harnessId !== "acp:antigravity"
    )
      return;
    let cancelled = false;
    setSkillsLoading(true);
    void useAgentStore
      .getState()
      .command<{ skills?: Skill[] }>(
        "workspace.skills",
        {
          workspaceId: session.workspaceId,
          harnessId: session.harnessId,
        },
        session.id,
      )
      .then((res) => {
        if (!cancelled && Array.isArray(res?.skills)) setSkills(res.skills);
      })
      .catch((error) => {
        if (!cancelled) useAgentStore.getState().report(error);
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    connected,
    session.id,
    session.instanceId,
    session.harnessId,
    session.workspaceId,
  ]);

  const readHistory = () => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`codev.agent.prompts:${session.id}`) ?? "[]",
      );
      return Array.isArray(saved)
        ? saved
            .filter(
              (item): item is string =>
                typeof item === "string" && !!item.trim(),
            )
            .slice(0, 50)
        : [];
    } catch {
      return [];
    }
  };
  const recordPrompt = (text: string) => {
    const value = text.trim();
    if (!value) return;
    try {
      const next = [
        value,
        ...readHistory().filter((item) => item !== value),
      ].slice(0, 50);
      localStorage.setItem(
        `codev.agent.prompts:${session.id}`,
        JSON.stringify(next),
      );
    } catch {
      /* optional prompt history */
    }
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
          localCommand: draft.localCommand ?? null,
        };
      update({
        text: prompts[next],
        images: [],
        files: [],
        localCommand: null,
      });
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
  const configDisabled = !connected || !session.instanceId || session.readOnly;
  const deferHint = busy ? "（运行中修改将在下回合生效）" : "";
  const update = (patch: Partial<typeof draft>) =>
    useAgentStore.getState().setDraft(session.id, patch);
  const report = useAgentStore.getState().report;
  const action = (operation: string, payload: unknown = {}) =>
    useAgentStore
      .getState()
      .command(operation, payload, session.id)
      .catch(report);
  const nativeCommands = (session.commands ?? []).filter(
    (command) =>
      command.name &&
      !(
        session.harnessId === "pi" &&
        ["picot-config", "picot-custom-ui", "llama"].includes(command.name)
      ),
  );
  const entries: Invocation[] = nativeCommands.map((command) => {
    const name = command.name.replace(/^\//u, "");
    const skill =
      name.startsWith("$") ||
      command.source === "skill" ||
      name.startsWith("skill:");
    return {
      token: name.startsWith("$") ? name : `/${name}`,
      label: name.startsWith("$") ? name : `/${name}`,
      description: command.description || command.input?.hint,
      group: skill ? "技能" : "命令",
      source:
        session.harnessId === "pi"
          ? "Pi"
          : session.harnessId === "acp:codex"
            ? "Codex"
            : "Antigravity",
    };
  });
  if (session.harnessId === "acp:antigravity") {
    const existing = new Set(entries.map((entry) => entry.token.toLowerCase()));
    for (const skill of skills) {
      const token = `/${skill.name}`;
      if (!existing.has(token.toLowerCase())) {
        entries.push({
          token,
          label: token,
          description: skill.description,
          group: "技能",
          source: skill.source || "Antigravity",
        });
        existing.add(token.toLowerCase());
      }
    }
  }
  if (session.harnessId === "pi") {
    if (session.capabilities.supportsCompaction)
      entries.push({
        token: "/compact",
        label: "/compact",
        description: "压缩上下文",
        group: "命令",
        source: "Codev",
        local: "compact",
      });
    if (session.capabilities.supportsFork)
      entries.push({
        token: "/fork",
        label: "/fork",
        description: "分叉当前线程",
        group: "命令",
        source: "Codev",
        local: "fork",
      });
  }
  const matches = trigger
    ? entries
        .filter((entry) => trigger.prefix === "/" || entry.group === "技能")
        .filter((entry) =>
          `${entry.label} ${entry.description ?? ""} ${entry.source}`
            .toLowerCase()
            .includes(trigger.query.toLowerCase()),
        )
        .sort((a, b) => Number(a.group === "技能") - Number(b.group === "技能"))
    : [];
  const chooseInvocation = (entry: Invocation) => {
    if (!trigger || (entry.local && busy)) return;
    let before = draft.text.slice(0, trigger.start);
    const after = draft.text.slice(trigger.end);
    if (entry.group === "技能" && session.harnessId !== "acp:codex") {
      const existing = before.match(/^(\/[^\s]+)\s*/u);
      if (
        existing &&
        entries.some(
          (item) => item.group === "技能" && item.token === existing[1],
        )
      )
        before = before.slice(existing[0].length);
      const body = `${before}${after}`.trimStart();
      update({ text: `${entry.token} ${body}`, localCommand: null });
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.setSelectionRange(
          entry.token.length + 1,
          entry.token.length + 1,
        );
      });
    } else {
      const text = `${before}${entry.token} ${after.replace(/^\s+/u, "")}`;
      update({ text, localCommand: entry.local ?? null });
      const caret = before.length + entry.token.length + 1;
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.setSelectionRange(caret, caret);
      });
    }
    setTrigger(null);
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
    if (sending || !connected || session.readOnly || !draftHasPayload(draft))
      return;
    const original = {
      text: draft.text,
      images: [...draft.images],
      files: [...(draft.files ?? [])],
    };
    const localMatch = draft.text
      .trim()
      .match(/^\/(compact|fork)(?:\s+([\s\S]*))?$/u);
    const nativeCollision =
      localMatch &&
      nativeCommands.some(
        (command) => command.name.replace(/^\//u, "") === localMatch[1],
      );
    const localSupported =
      localMatch?.[1] === "compact"
        ? session.capabilities.supportsCompaction
        : session.capabilities.supportsFork;
    const local =
      session.harnessId === "pi" &&
      localSupported &&
      localMatch &&
      (draft.localCommand === localMatch[1] ||
        (!draft.localCommand && !nativeCollision))
        ? localMatch[1]
        : null;
    if (local) {
      if (busy) {
        report(new Error("当前会话正在运行，请稍后执行命令"));
        return;
      }
      if (original.images.length || original.files.length) {
        report(new Error("请先移除附件再执行会话命令"));
        return;
      }
      setSending(true);
      try {
        if (local === "compact") {
          await useAgentStore
            .getState()
            .command(
              "session.compact",
              { instructions: localMatch?.[2] ?? "" },
              session.id,
            );
        } else {
          if (localMatch?.[2]?.trim()) throw new Error("分叉命令不接受参数");
          const state = useAgentStore.getState();
          if (state.slots.length > 1 && !state.slots.includes(null))
            throw new Error("视口已满，请先新增或清空视口");
          const view = await state.command<SessionView>(
            "session.fork",
            {},
            session.id,
          );
          useAgentStore.setState((current) => ({
            sessions: { ...current.sessions, [view.id]: view },
            views: { ...current.views, [view.id]: view },
          }));
          await useAgentStore.getState().select(view.id);
        }
        recordPrompt(original.text);
        if (useAgentStore.getState().drafts[session.id]?.text === original.text)
          update({ ...EMPTY, localCommand: null });
        setTrigger(null);
      } catch (error) {
        report(error);
      } finally {
        setSending(false);
      }
      return;
    }
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
      const current = useAgentStore.getState().drafts[session.id];
      if (
        current?.text === original.text &&
        current.images.length === original.images.length &&
        (current.files?.length ?? 0) === original.files.length
      )
        update({ ...EMPTY, localCommand: null });
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
        <div className="agent-compacting" role="status">
          <span className="agent-state-dot is-working" />
          正在压缩上下文…
        </div>
      )}
      {!!session.queue.length && (
        <div className="agent-queue-card" data-testid="agent-queue-card">
          <div className="agent-queue-head">
            <span>待发送 · {session.queue.length}</span>
            <div className="agent-queue-head-actions">
              {!busy && (
                <button
                  type="button"
                  className="agent-queue-head-btn"
                  onClick={() => void action("session.queue.flush")}
                >
                  继续发送
                </button>
              )}
              <button
                type="button"
                className="agent-queue-head-btn"
                onClick={() => void action("session.queue.clear")}
              >
                清空
              </button>
            </div>
          </div>
          {session.queue.map((item, idx) => {
            const firstImage = item.images?.[0];
            return (
              <div
                className="agent-queue-row"
                key={item.id || `${idx}:${item.text.slice(0, 80)}`}
              >
                {firstImage?.data && firstImage?.mimeType && (
                  <img
                    className="agent-queue-thumb"
                    src={`data:${firstImage.mimeType};base64,${firstImage.data}`}
                    alt="待发送图片"
                  />
                )}
                <div className="agent-queue-text">
                  {item.steer && (
                    <span className="agent-queue-badge">插队</span>
                  )}
                  <span>
                    {item.text ||
                      (item.imageCount ? `图片附件 (${item.imageCount})` : "")}
                  </span>
                </div>
                <div className="agent-queue-actions">
                  <button
                    type="button"
                    title="插队优先发送"
                    aria-label="插队优先发送"
                    disabled={Boolean(item.steer && idx === 0 && !busy)}
                    onClick={() =>
                      void action("session.queue.steer", {
                        id: item.id,
                        index: idx,
                      })
                    }
                  >
                    <HugeiconsIcon icon={ArrowUp01Icon} size={13} />
                  </button>
                  <button
                    type="button"
                    title="退回输入框编辑"
                    aria-label="退回输入框编辑"
                    onClick={() => {
                      update({
                        text: draft.text
                          ? `${draft.text}\n${item.text}`
                          : item.text,
                        images: item.images?.length
                          ? [...draft.images, ...item.images]
                          : draft.images,
                      });
                      void action("session.queue.remove", {
                        id: item.id,
                        index: idx,
                      });
                      input.current?.focus();
                    }}
                  >
                    <HugeiconsIcon icon={PencilEdit01Icon} size={13} />
                  </button>
                  <button
                    type="button"
                    title="删除待发送消息"
                    aria-label="删除待发送消息"
                    onClick={() =>
                      void action("session.queue.remove", {
                        id: item.id,
                        index: idx,
                      })
                    }
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="agent-composer" data-agent-composer={session.id}>
        {!!draft.images.length && (
          <div className="agent-images">
            {draft.images.map((image, index) => (
              <div
                key={image.id ?? `${image.mimeType}:${image.data.slice(-24)}`}
              >
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
              <span
                key={item.path}
                className="agent-draft-file-chip"
                title={item.path}
              >
                <span className="opacity-65">
                  {item.kind === "dir" ? "目录" : "文件"}
                </span>
                <span className="max-w-44 truncate">{item.name}</span>
                <button
                  type="button"
                  aria-label={`移除 ${item.name}`}
                  onClick={() =>
                    update({
                      files: (draft.files ?? []).filter(
                        (f) => f.path !== item.path,
                      ),
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
          skills={[]}
          aria-label="给当前代理发送任务"
          placeholder={
            session.readOnly
              ? "这份原生历史当前只读"
              : session.instanceId
                ? "输入任务；输入 / 查看命令与技能…"
                : "输入任务，发送时连接原生代理…"
          }
          className="agent-prompt reader-scrollbar min-h-24 rounded-none border-0! bg-transparent! px-3 py-3 text-[13px]! shadow-none! outline-none! ring-0! focus-visible:border-0! focus-visible:ring-0! [field-sizing:fixed]"
          value={draft.text}
          disabled={session.readOnly || !connected}
          onChange={(e) => {
            const text = e.target.value;
            const localCommand =
              draft.localCommand &&
              new RegExp(`^/${draft.localCommand}(?:\\s|$)`).test(text)
                ? draft.localCommand
                : null;
            update({ text, localCommand });
            setTrigger(
              invocationTrigger(text, e.target.selectionStart ?? text.length),
            );
            setMenuIndex(0);
          }}
          onCompositionStart={() => setIme(true)}
          onCompositionEnd={() => setIme(false)}
          onKeyDown={(e) => {
            if (trigger && !ime && !e.nativeEvent.isComposing) {
              if (e.key === "Escape") {
                e.preventDefault();
                setTrigger(null);
                return;
              }
              if (
                (e.key === "ArrowDown" || e.key === "ArrowUp") &&
                matches.length
              ) {
                e.preventDefault();
                const direction = e.key === "ArrowDown" ? 1 : -1;
                setMenuIndex(
                  (index) =>
                    (index + direction + matches.length) % matches.length,
                );
                return;
              }
              if ((e.key === "Enter" || e.key === "Tab") && matches.length) {
                e.preventDefault();
                chooseInvocation(matches[menuIndex % matches.length]);
                return;
              }
            }
            if (
              (e.key === "ArrowUp" || e.key === "ArrowDown") &&
              !e.shiftKey &&
              !e.altKey &&
              !e.ctrlKey &&
              !e.metaKey &&
              !ime &&
              !e.nativeEvent.isComposing
            ) {
              const node = e.currentTarget;
              const atStart =
                node.selectionStart === 0 && node.selectionEnd === 0;
              const atEnd =
                node.selectionStart === node.value.length &&
                node.selectionEnd === node.value.length;
              if (
                (e.key === "ArrowUp" && atStart) ||
                (e.key === "ArrowDown" && atEnd)
              ) {
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
        {trigger && (
          <div
            className="agent-invocation-menu reader-scrollbar"
            role="listbox"
            aria-label={trigger.prefix === "$" ? "技能" : "命令与技能"}
          >
            {session.state === "starting" || skillsLoading ? (
              <div className="agent-invocation-empty">正在加载…</div>
            ) : !session.instanceId ? (
              <div className="agent-invocation-empty">代理未连接</div>
            ) : matches.length === 0 ? (
              <div className="agent-invocation-empty">
                没有匹配的{trigger.prefix === "$" ? "技能" : "命令或技能"}
              </div>
            ) : (
              matches.map((entry, index) => (
                <button
                  key={`${entry.source}:${entry.token}`}
                  type="button"
                  role="option"
                  aria-selected={index === menuIndex % matches.length}
                  disabled={!!entry.local && busy}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setMenuIndex(index)}
                  onClick={() => chooseInvocation(entry)}
                >
                  <span className="agent-invocation-name">{entry.label}</span>
                  <span className="agent-invocation-description">
                    {entry.description}
                  </span>
                  <span className="agent-invocation-source">
                    {entry.local
                      ? "Codev"
                      : entry.group === "技能"
                        ? `${entry.source} · 技能`
                        : entry.source}
                  </span>
                </button>
              ))
            )}
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
                    (session.model
                      ? `${session.model.provider ?? ""} / ${session.model.id}`
                      : "选择当前代理的模型") + deferHint
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
            <Select
              disabled={configDisabled}
              value={session.thinkingLevel || undefined}
              onValueChange={(level) =>
                void action("session.thinking", { level })
              }
            >
              <SelectTrigger
                size="sm"
                className="agent-composer-select"
                aria-label="思考等级"
                title={`思考等级${deferHint}`}
              >
                <SelectValue placeholder="思考等级" />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {session.thinkingLevels.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {session.configOptions
            .filter(
              (o) =>
                o.category !== "model" &&
                o.category !== "thought_level" &&
                o.category !== "thinking" &&
                !o.id.includes("thinking") &&
                o.id !== "model" &&
                !(
                  session.harnessId === "acp:codex" &&
                  (o.id === "collaboration_mode" || o.id === "fast-mode")
                ),
            )
            .map((option) => {
              const optionChoices = choices(option);
              if (option.type === "boolean") {
                const checked = option.currentValue === "true";
                return (
                  <label
                    key={option.id}
                    className="agent-setting-pill cursor-pointer"
                    title={`${option.name}${deferHint}`}
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
                    <span className="agent-setting-pill-label">
                      {option.name}
                    </span>
                  </label>
                );
              }
              const selectableChoices = optionChoices.filter(
                (choice) => choice.value,
              );
              if (!selectableChoices.length) return null;
              return (
                <Select
                  key={option.id}
                  disabled={configDisabled}
                  value={option.currentValue || undefined}
                  onValueChange={(value) =>
                    void action("session.config", {
                      configId: option.id,
                      value,
                    })
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="agent-composer-select"
                    aria-label={option.name}
                    title={`${option.name}${deferHint}`}
                  >
                    <SelectValue placeholder={option.name} />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    {selectableChoices.map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>
                        {choice.name || choice.label || choice.value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
      <BranchDropdown
        cwd={cwd}
        harnessId={session.harnessId}
        disabled={mobile}
      />
    </footer>
  );
}
