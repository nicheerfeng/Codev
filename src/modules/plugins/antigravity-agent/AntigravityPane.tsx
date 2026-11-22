import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  GridViewIcon,
  LayoutRightIcon,
  Maximize01Icon,
  Minimize01Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { ResizableViewportGrid } from "@/components/ResizableViewportGrid";
import {
  MAX_VIEWPORTS,
  clearViewportSlot,
  closeViewportSlot,
  focusAfterViewportChange,
  growViewportSlots,
  shrinkViewportSlots,
  swapViewportSlots,
} from "@/lib/viewportSlots";
import { uiState } from "@/lib/uiState";
import { useAgentProjectRequest, finishAgentProjectRequest } from "../agentProjectRequest";
import { setAntigravityProjects, setAntigravitySessions, usePluginStore } from "../store";
import { WorkbenchContent } from "../workbench/WorkbenchContent";
import { useWorkbench } from "../workbench/store";
import { AntigravityComposer } from "./AntigravityComposer";
import { AntigravitySidebar } from "./AntigravitySidebar";
import { AntigravityTranscript } from "./AntigravityTranscript";
import { useAntigravityComposerNativeDrop } from "./antigravityComposerDrop";
import { useAntigravityComposerDropStore } from "./antigravityComposerDropStore";
import { applyAgentEvent } from "./events";
import {
  answerAntigravityPermission,
  cancelAntigravityPrompt,
  closeAllAntigravitySessions,
  closeAntigravitySession,
  listenAntigravityEvents,
  sendAntigravityPrompt,
  setAntigravityConfigOption,
  startAntigravitySession,
  type AntigravityConfigOption,
  type AntigravityEnvelope,
  type AntigravityImage,
  type AntigravityStartResult,
} from "./native";
import {
  projectLabel,
  sessionLabel,
  type AntigravityPermission,
  type AntigravitySession,
  type AntigravityTranscriptItem,
} from "./types";
import "./antigravity.css";

const LEGACY_SESSIONS_KEY = "codev.antigravity.sessions.v1";
const SIDEBAR_WIDTH_KEY = "codev.antigravity.sidebar.width";

function readLegacySessions(): AntigravitySession[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(LEGACY_SESSIONS_KEY) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is AntigravitySession =>
        !!item &&
        typeof item === "object" &&
        typeof (item as AntigravitySession).id === "string" &&
        typeof (item as AntigravitySession).cwd === "string",
    );
  } catch {
    return [];
  }
}

export function AntigravityPane({
  active,
  workspaceRoots = [],
}: {
  active: boolean;
  workspaceRoots?: string[];
}) {
  const enabled = usePluginStore((state) => state.enabled["antigravity-agent"]);
  const storedSessions = usePluginStore((state) => state.antigravitySessions);
  const storedProjects = usePluginStore((state) => state.antigravityProjects);
  const hydrated = usePluginStore((state) => state.hydrated);

  const [sessions, setSessions] = useState<AntigravitySession[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewportKeys, setViewportKeys] = useState<(string | null)[]>([]);
  const [activeViewport, setActiveViewport] = useState(0);
  const [maximizedViewport, setMaximizedViewport] = useState<number | null>(
    null,
  );
  const [messages, setMessages] = useState<
    Record<string, AntigravityTranscriptItem[]>
  >({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [images, setImages] = useState<Record<string, AntigravityImage[]>>({});
  const [imageSupport, setImageSupport] = useState<Record<string, boolean>>(
    {},
  );
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [permissions, setPermissions] = useState<
    Record<string, AntigravityPermission | undefined>
  >({});
  const [configs, setConfigs] = useState<
    Record<string, AntigravityConfigOption[]>
  >({});
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(uiState.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(stored) && stored >= 180 ? stored : 236;
  });

  const connectionId = useRef<number | null>(null);
  const loaded = useRef(new Map<string, number>());
  const hydratedOnce = useRef(false);
  const sessionsRef = useRef<AntigravitySession[]>([]);
  sessionsRef.current = sessions;
  const request = useAgentProjectRequest((state) => state.request);
  const handledRequest = useRef<number | null>(null);

  /** 会话索引写入插件配置，不走 localStorage 平行状态。 */
  const commitSessions = useCallback((next: AntigravitySession[]) => {
    setSessions(next);
    void setAntigravitySessions(next);
  }, []);

  useEffect(() => {
    if (!hydrated || hydratedOnce.current) return;
    hydratedOnce.current = true;
    const legacy = storedSessions.length ? [] : readLegacySessions();
    if (legacy.length) {
      localStorage.removeItem(LEGACY_SESSIONS_KEY);
      commitSessions(legacy);
      setSelected(legacy[0].id);
    } else {
      setSessions(storedSessions);
    }
    setProjects(storedProjects);
    if (!legacy.length) {
      setSelected((current) => current ?? storedSessions[0]?.id ?? null);
    }
  }, [hydrated, storedSessions, storedProjects, commitSessions]);

  useEffect(() => {
    uiState.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenAntigravityEvents((event: AntigravityEnvelope) => {
      if (
        connectionId.current !== null &&
        event.connectionId !== connectionId.current
      )
        return;
      applyAgentEvent(event, {
        setMessages,
        setBusy,
        setPermissions,
        setConfigs,
        setSessions,
        setError,
        loaded,
        connectionId,
      });
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      loaded.current.clear();
      connectionId.current = null;
      void closeAllAntigravitySessions();
      useWorkbench.getState().release("antigravity");
    }
  }, [enabled]);

  /** 会话建立后把执行模式推到限制最少的一档：auto，退化 accept-edits。 */
  const applyLoosestMode = useCallback(
    async (
      connectionId: number,
      sessionId: string,
      options: AntigravityConfigOption[],
    ) => {
      const mode = options.find(
        (option) => option.category === "mode" && option.type === "select",
      );
      if (!mode) return;
      const values = (mode.options ?? []).flatMap((item) =>
        "options" in item ? item.options : [item],
      );
      const target = ["auto", "accept-edits"].find((value) =>
        values.some((item) => item.value === value),
      );
      if (!target || String(mode.currentValue) === target) return;
      try {
        const next = await setAntigravityConfigOption(
          connectionId,
          sessionId,
          mode.id,
          target,
        );
        setConfigs((current) => ({ ...current, [sessionId]: next }));
      } catch (cause) {
        setError(String(cause));
      }
    },
    [],
  );

  const applyStart = useCallback(
    (sessionId: string, result: AntigravityStartResult) => {
      connectionId.current = result.connectionId;
      loaded.current.set(sessionId, result.connectionId);
      setConfigs((current) => ({
        ...current,
        [sessionId]: result.configOptions,
      }));
      setImageSupport((current) => ({
        ...current,
        [sessionId]: result.imageInput,
      }));
      void applyLoosestMode(
        result.connectionId,
        sessionId,
        result.configOptions,
      );
    },
    [applyLoosestMode],
  );

  const ensureLoaded = useCallback(
    async (session: AntigravitySession) => {
      const existing = loaded.current.get(session.id);
      if (existing !== undefined) return existing;
      setError("");
      setMessages((current) => ({ ...current, [session.id]: [] }));
      const result = await startAntigravitySession(session.cwd, session.id);
      applyStart(session.id, result);
      return result.connectionId;
    },
    [applyStart],
  );

  const createSession = useCallback(
    async (cwdOverride?: string) => {
      let cwd = cwdOverride ?? projects[0] ?? workspaceRoots[0] ?? "";
      if (!cwd) {
        const picked = await open({
          directory: true,
          multiple: false,
          title: "选择 Antigravity 项目",
        });
        if (typeof picked !== "string") return;
        cwd = picked.replace(/\\/g, "/");
        const nextProjects = [...new Set([...projects, cwd])];
        setProjects(nextProjects);
        void setAntigravityProjects(nextProjects);
      }
      setError("");
      const result = await startAntigravitySession(cwd);
      applyStart(result.sessionId, result);
      const session: AntigravitySession = {
        id: result.sessionId,
        cwd,
        title: "",
        preview: "",
        updatedAt: Date.now(),
      };
      commitSessions([session, ...sessions.filter((item) => item.id !== session.id)]);
      setMessages((current) => ({ ...current, [session.id]: [] }));
      setSelected(session.id);
      setViewportKeys((current) => {
        if (!current.length) return current;
        const next = [...current];
        const index = next.indexOf(null) >= 0 ? next.indexOf(null) : activeViewport;
        next[index] = session.id;
        setActiveViewport(index);
        return next;
      });
      setMaximizedViewport(null);
      return session;
    },
    [activeViewport, applyStart, commitSessions, projects, sessions, workspaceRoots],
  );

  /** 只注册项目分组，会话等用户在该项目里新建。 */
  const addProject = useCallback(async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "选择 Antigravity 项目",
    });
    if (typeof picked !== "string") return;
    const cwd = picked.replace(/\\/g, "/");
    const next = [...new Set([...projects, cwd])];
    setProjects(next);
    void setAntigravityProjects(next);
  }, [projects]);

  const removeProject = useCallback(
    (cwd: string) => {
      const next = projects.filter((item) => item !== cwd);
      setProjects(next);
      void setAntigravityProjects(next);
    },
    [projects],
  );

  const selectSession = useCallback(
    (session: AntigravitySession) => {
      setSelected(session.id);
      if (viewportKeys.length) {
        const existing = viewportKeys.indexOf(session.id);
        if (existing >= 0) setActiveViewport(existing);
        else {
          const empty = viewportKeys.indexOf(null);
          const index = empty >= 0 ? empty : activeViewport;
          const next = [...viewportKeys];
          next[index] = session.id;
          setViewportKeys(next);
          setActiveViewport(index);
        }
      }
      setError("");
      void ensureLoaded(session).catch((cause) => setError(String(cause)));
    },
    [activeViewport, ensureLoaded, viewportKeys],
  );

  const removeSession = useCallback(
    async (session: AntigravitySession) => {
      const connection = loaded.current.get(session.id);
      if (connection !== undefined) {
        await closeAntigravitySession(connection, session.id).catch((cause) =>
          setError(String(cause)),
        );
        loaded.current.delete(session.id);
      }
      commitSessions(sessions.filter((item) => item.id !== session.id));
      setViewportKeys((current) =>
        current.length
          ? current.map((id) => (id === session.id ? null : id))
          : current,
      );
      setMessages((current) => {
        const next = { ...current };
        delete next[session.id];
        return next;
      });
      setSelected((current) =>
        current === session.id
          ? (sessions.find((item) => item.id !== session.id)?.id ?? null)
          : current,
      );
    },
    [commitSessions, sessions],
  );

  const renameSession = useCallback(
    (id: string, title: string) => {
      commitSessions(
        sessions.map((item) =>
          item.id === id ? { ...item, title, renamed: true } : item,
        ),
      );
    },
    [commitSessions, sessions],
  );

  const send = useCallback(
    async (session: AntigravitySession) => {
      const text = drafts[session.id]?.trim() ?? "";
      const attached = images[session.id] ?? [];
      if ((!text && !attached.length) || busy[session.id]) return;
      try {
        const connection = await ensureLoaded(session);
        setDrafts((current) => ({ ...current, [session.id]: "" }));
        setImages((current) => ({ ...current, [session.id]: [] }));
        setBusy((current) => ({ ...current, [session.id]: true }));
        const next = sessions.map((item) =>
          item.id === session.id
            ? {
                ...item,
                preview: text || `[${attached.length} 张图片]`,
                updatedAt: Date.now(),
              }
            : item,
        );
        commitSessions(next);
        await sendAntigravityPrompt(connection, session.id, text, attached);
      } catch (cause) {
        setBusy((current) => ({ ...current, [session.id]: false }));
        setError(String(cause));
      }
    },
    [busy, commitSessions, drafts, ensureLoaded, images, sessions],
  );

  const cancel = useCallback(
    async (session: AntigravitySession) => {
      const connection = loaded.current.get(session.id);
      if (connection === undefined) return;
      try {
        await cancelAntigravityPrompt(connection, session.id);
        setPermissions((current) => ({ ...current, [session.id]: undefined }));
      } catch (cause) {
        setError(String(cause));
      }
    },
    [],
  );

  const answerPermission = useCallback(
    async (
      session: AntigravitySession,
      permission: AntigravityPermission,
      optionId: string | null,
    ) => {
      const connection = loaded.current.get(session.id);
      if (connection === undefined) return;
      try {
        await answerAntigravityPermission(
          connection,
          permission.requestId,
          optionId,
        );
        setPermissions((current) => ({ ...current, [session.id]: undefined }));
      } catch (cause) {
        setError(String(cause));
      }
    },
    [],
  );

  const changeConfig = useCallback(
    async (
      session: AntigravitySession,
      configId: string,
      value: string | boolean,
    ) => {
      const connection = loaded.current.get(session.id);
      if (connection === undefined) return;
      try {
        const options = await setAntigravityConfigOption(
          connection,
          session.id,
          configId,
          value,
        );
        setConfigs((current) => ({ ...current, [session.id]: options }));
      } catch (cause) {
        setError(String(cause));
      }
    },
    [],
  );

  const addToWorkbench = useCallback(
    async (session: AntigravitySession) => {
      try {
        await ensureLoaded(session);
        useWorkbench.getState().add({
          kind: "antigravity",
          id: session.id,
          title: sessionLabel(session),
        });
      } catch (cause) {
        setError(String(cause));
      }
    },
    [ensureLoaded],
  );

  useEffect(() => {
    if (
      !active ||
      !enabled ||
      request?.target !== "antigravity" ||
      handledRequest.current === request.id
    )
      return;
    handledRequest.current = request.id;
    const cwd = request.cwd.replace(/\\/g, "/");
    const nextProjects = [...new Set([...projects, cwd])];
    setProjects(nextProjects);
    void setAntigravityProjects(nextProjects);
    void createSession(cwd)
      .then(() => toast.success("已在 Antigravity 中打开项目"))
      .catch((cause) => setError(String(cause)))
      .finally(() => finishAgentProjectRequest(request.id));
  }, [active, createSession, enabled, projects, request]);

  /** 刷新后自动恢复选中会话的历史，与 Pi 首次选择一致。 */
  useEffect(() => {
    if (!hydrated || !selected) return;
    const session = sessionsRef.current.find((item) => item.id === selected);
    if (!session || loaded.current.has(session.id)) return;
    void ensureLoaded(session).catch((cause) => setError(String(cause)));
  }, [ensureLoaded, hydrated, selected]);

  /** 拖入的路径只写进草稿，不复制文件、不开选择器。 */
  const appendPaths = useCallback(
    (paths: string[], key?: string) => {
      if (!paths.length) return;
      const target =
        key && sessionsRef.current.some((item) => item.id === key)
          ? key
          : selected;
      if (!target) return;
      const text = paths
        .map((path) => (path.startsWith("@") ? path : `@${path}`))
        .join("\n");
      setDrafts((current) => ({
        ...current,
        [target]: [current[target]?.trim(), text].filter(Boolean).join("\n"),
      }));
    },
    [selected],
  );

  useEffect(() => {
    const store = useAntigravityComposerDropStore.getState();
    store.setActive(active);
    store.setDrop(appendPaths);
    return () => {
      store.setActive(false);
      store.setDrop(null);
      store.setHover(false);
    };
  }, [active, appendPaths]);
  useAntigravityComposerNativeDrop({
    active: () => active,
    onDrop: appendPaths,
    onHover: (hover, key) =>
      useAntigravityComposerDropStore.getState().setHover(hover, key),
  });

  const toggleViewports = () => {
    setMaximizedViewport(null);
    setViewportKeys(viewportKeys.length ? [] : [selected, null]);
    setActiveViewport(0);
  };
  const addViewport = () => {
    if (viewportKeys.length >= MAX_VIEWPORTS) {
      toast.info("最多支持 6 个 Antigravity 视口");
      return;
    }
    setViewportKeys((slots) => growViewportSlots(slots, null, MAX_VIEWPORTS));
  };
  const removeViewport = () => {
    if (viewportKeys.length <= 1) return;
    setMaximizedViewport(null);
    setViewportKeys((slots) => {
      const next = shrinkViewportSlots(slots);
      setActiveViewport((current) => Math.min(current, next.length - 1));
      return next;
    });
  };
  const clearViewport = (index: number) => {
    setMaximizedViewport(null);
    setViewportKeys((slots) => clearViewportSlot(slots, index, null));
  };
  const closeViewport = (index: number) => {
    setMaximizedViewport(null);
    setViewportKeys((slots) => {
      const next = closeViewportSlot(slots, index);
      if (next.length <= 1) {
        setActiveViewport(0);
        return [];
      }
      setActiveViewport((current) =>
        focusAfterViewportChange(current, index, next.length),
      );
      return next;
    });
  };

  const titleDrag = useRef<{
    pointerId: number;
    from: number;
    x: number;
    y: number;
    target: HTMLElement;
  } | null>(null);
  const [titleHover, setTitleHover] = useState<number | null>(null);
  const endTitleDrag = () => {
    const current = titleDrag.current;
    titleDrag.current = null;
    if (current?.target.hasPointerCapture(current.pointerId)) {
      current.target.releasePointerCapture(current.pointerId);
    }
    setTitleHover(null);
  };
  const startTitleDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    from: number,
  ) => {
    if (event.button !== 0 || viewportKeys.length < 2) return;
    titleDrag.current = {
      pointerId: event.pointerId,
      from,
      x: event.clientX,
      y: event.clientY,
      target: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveTitleDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = titleDrag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6)
      return;
    event.preventDefault();
    const node = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-antigravity-viewport-index]");
    setTitleHover(
      node?.dataset.antigravityViewportIndex === undefined
        ? null
        : Number(node.dataset.antigravityViewportIndex),
    );
  };
  const finishTitleDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = titleDrag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const node = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-antigravity-viewport-index]");
    if (node?.dataset.antigravityViewportIndex !== undefined) {
      const to = Number(node.dataset.antigravityViewportIndex);
      if (to !== current.from && to < viewportKeys.length) {
        setViewportKeys((slots) => swapViewportSlots(slots, current.from, to));
        setActiveViewport(to);
      }
    }
    endTitleDrag();
  };

  const selectedSession =
    sessions.find((session) => session.id === selected) ?? null;
  const multi = viewportKeys.length > 0;
  const viewportCount = multi ? viewportKeys.length : 1;
  const columns =
    multi && viewportCount > 1
      ? viewportCount > 4
        ? 3
        : 2
      : 1;
  const rows = Math.ceil(viewportCount / columns);
  const renderKeys: (string | null)[] = multi
    ? viewportKeys
    : [selectedSession?.id ?? null];
  const positions = renderKeys.map((_, index) =>
    maximizedViewport !== null && index !== maximizedViewport
      ? null
      : {
          column: maximizedViewport !== null ? 0 : index % columns,
          row: maximizedViewport !== null ? 0 : Math.floor(index / columns),
        },
  );

  const headerTitle = selectedSession
    ? `${sessionLabel(selectedSession)} (${projectLabel(selectedSession.cwd)})`
    : "Antigravity";

  return (
    <section
      data-testid="antigravity-agent"
      className="antigravity-agent @container flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          title="新建对话"
          aria-label="新建对话"
          onClick={() => void createSession()}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={15} />
        </Button>
        <div className="min-w-0 flex-1 truncate px-2 text-xs font-medium">
          {headerTitle}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          title={multi ? "退出多视口" : "多视口"}
          aria-label={multi ? "退出多视口" : "多视口"}
          aria-pressed={multi}
          onClick={toggleViewports}
        >
          <HugeiconsIcon icon={GridViewIcon} size={14} />
        </Button>
        {multi && viewportCount > 1 && (
          <div className="flex shrink-0 items-center">
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-4"
              title="减少视口"
              aria-label="减少视口"
              disabled={viewportCount <= 1}
              onClick={removeViewport}
            >
              <span className="text-xs leading-none">−</span>
            </Button>
            <span className="min-w-7 text-center text-xs leading-none tabular-nums text-muted-foreground">
              {viewportCount}/{MAX_VIEWPORTS}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-4"
              title="增加视口"
              aria-label="增加视口"
              disabled={viewportCount >= MAX_VIEWPORTS}
              onClick={addViewport}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={10} />
            </Button>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          title={sidebarOpen ? "收起线程栏" : "展开线程栏"}
          aria-label={sidebarOpen ? "收起线程栏" : "展开线程栏"}
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <HugeiconsIcon icon={LayoutRightIcon} size={16} />
        </Button>
      </header>

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-[10px] text-destructive">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button type="button" title="关闭提示" onClick={() => setError("")}>
            <HugeiconsIcon icon={Cancel01Icon} size={12} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ResizableViewportGrid
          className="min-h-0 min-w-0 flex-1"
          columns={columns}
          rows={rows}
          positions={positions}
        >
          {renderKeys.map((sessionId, index) => {
            const session =
              sessions.find((item) => item.id === sessionId) ?? null;
            const highlighted = multi && titleHover === index;
            return (
              <section
                key={session?.id ?? `empty-${index}`}
                data-antigravity-viewport-index={multi ? index : undefined}
                className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden ${
                  multi
                    ? `rounded-md border ${highlighted ? "border-primary ring-1 ring-primary" : activeViewport === index ? "border-primary/50" : "border-border"}`
                    : ""
                }`}
                onPointerDownCapture={() => {
                  if (multi) setActiveViewport(index);
                }}
              >
                {multi && (
                  <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border/60 bg-muted/30 px-2 text-[11px]">
                    <button
                      type="button"
                      className="min-w-0 flex-1 cursor-grab touch-none truncate text-left"
                      title="按住拖到其他视口"
                      onPointerDown={(event) => startTitleDrag(event, index)}
                      onPointerMove={moveTitleDrag}
                      onPointerUp={finishTitleDrag}
                      onPointerCancel={endTitleDrag}
                      onLostPointerCapture={() => {
                        if (titleDrag.current) endTitleDrag();
                      }}
                      onDragStart={(event) => event.preventDefault()}
                    >
                      {session
                        ? `${sessionLabel(session)} (${projectLabel(session.cwd)})`
                        : `视口 ${index + 1}`}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="size-5"
                      title={
                        maximizedViewport === index ? "还原视口" : "放大视口"
                      }
                      aria-label={
                        maximizedViewport === index ? "还原视口" : "放大视口"
                      }
                      onClick={() =>
                        setMaximizedViewport(
                          maximizedViewport === index ? null : index,
                        )
                      }
                    >
                      <HugeiconsIcon
                        icon={
                          maximizedViewport === index
                            ? Minimize01Icon
                            : Maximize01Icon
                        }
                        size={12}
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="size-5"
                      title="清空视口内容"
                      aria-label="清空视口内容"
                      onClick={() => clearViewport(index)}
                    >
                      <HugeiconsIcon icon={Cancel01Icon} size={12} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="size-5"
                      title="关闭格子"
                      aria-label="关闭格子"
                      disabled={viewportKeys.length <= 1}
                      onClick={() => closeViewport(index)}
                    >
                      <HugeiconsIcon icon={Cancel01Icon} size={12} />
                    </Button>
                  </div>
                )}
                <WorkbenchContent
                  source={{
                    kind: "antigravity",
                    id: session?.id ?? `draft-${index}`,
                    title: session ? sessionLabel(session) : "Antigravity",
                  }}
                >
                  <div className="flex h-full min-h-0 flex-col">
                    <AntigravityTranscript
                      session={session}
                      messages={session ? (messages[session.id] ?? []) : []}
                      permission={session ? permissions[session.id] : undefined}
                      busy={session ? !!busy[session.id] : false}
                      onPermission={(request, optionId) => {
                        if (session)
                          void answerPermission(session, request, optionId);
                      }}
                      onStart={() => void createSession(session?.cwd)}
                    />
                    {session && (
                      <AntigravityComposer
                        sessionId={session.id}
                        draft={drafts[session.id] ?? ""}
                        busy={!!busy[session.id]}
                        configs={configs[session.id] ?? []}
                        project={session.cwd}
                        onDraft={(text) =>
                          setDrafts((current) => ({
                            ...current,
                            [session.id]: text,
                          }))
                        }
                        images={images[session.id] ?? []}
                        imageEnabled={!!imageSupport[session.id]}
                        onImages={(next) =>
                          setImages((current) => ({
                            ...current,
                            [session.id]: next,
                          }))
                        }
                        onConfig={(configId, value) =>
                          void changeConfig(session, configId, value)
                        }
                        onSend={() => void send(session)}
                        onCancel={() => void cancel(session)}
                      />
                    )}
                  </div>
                </WorkbenchContent>
              </section>
            );
          })}
        </ResizableViewportGrid>

        {sidebarOpen && (
          <AntigravitySidebar
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
            sessions={sessions}
            projects={projects}
            selectedId={selected}
            viewportIds={viewportKeys.filter(
              (id): id is string => typeof id === "string",
            )}
            busy={busy}
            onSelect={selectSession}
            onNew={(cwd) => void createSession(cwd)}
            onAddProject={() => void addProject()}
            onRemoveProject={removeProject}
            onRename={renameSession}
            onRemove={(session) => void removeSession(session)}
            onAddToWorkbench={(session) => void addToWorkbench(session)}
          />
        )}
      </div>
    </section>
  );
}
