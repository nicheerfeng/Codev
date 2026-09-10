import { Input } from "@/components/ui/input";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Streamdown } from "streamdown";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Search01Icon,
  Download01Icon,
  Settings01Icon,
  PlusSignIcon,
  Cancel01Icon,
  Folder01Icon,
  Edit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  closePiAgent,
  listAllPiSessions,
  listenPiEvents,
  probePiAgent,
  readPiModels,
  sendPiCommand,
  startPiAgent,
  writePiModels,
} from "./native";
import { INITIAL_PI_VIEW_STATE, piViewReducer } from "./reducer";
import type { PiSessionSummary, PiTranscriptItem } from "./types";
import {
  setPiAgentHiddenProjects,
  setPiAgentProjects,
  usePluginStore,
} from "../store";

type Props = { cwd: string | null; active: boolean };
type Project = { cwd: string; sessions: PiSessionSummary[] };

/** 返回路径末级目录名作为 Pi 项目标题。 */
function projectName(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() || clean;
}

/** 返回当前 Pi 运行状态的中文标签。 */
function statusLabel(status: typeof INITIAL_PI_VIEW_STATE.status): string {
  return {
    starting: "启动中",
    running: "运行中",
    stopping: "停止中",
    idle: "就绪",
    failed: "异常",
    stopped: "未启动",
  }[status];
}

/** 渲染一条用户、助手或工具记录。 */
function TranscriptItem({ item }: { item: PiTranscriptItem }) {
  if (item.kind === "tool")
    return (
      <details
        className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-[11px]"
        open={item.status === "running"}
      >
        <summary className="cursor-pointer select-none text-muted-foreground">
          {item.status === "running"
            ? "执行中"
            : item.status === "error"
              ? "执行失败"
              : "已完成"}{" "}
          · {item.name}
        </summary>
        {item.output ? (
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-border/50 pt-1">
            {item.output.length > 8000
              ? `${item.output.slice(0, 8000)}\n…输出已截断`
              : item.output}
          </pre>
        ) : null}
      </details>
    );
  return (
    <article
      className={
        item.role === "user"
          ? "ml-8 rounded-lg bg-accent/60 px-3 py-2 text-[12px]"
          : "mr-2 px-1 py-2 text-[12px]"
      }
    >
      {item.thinking ? (
        <details className="mb-2 rounded-md border border-border/50 bg-muted/20 px-2 py-1 text-muted-foreground">
          <summary className="cursor-pointer text-[10px]">思考过程</summary>
          <div className="mt-1 whitespace-pre-wrap">{item.thinking}</div>
        </details>
      ) : null}
      <div className="select-text break-words leading-5 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap">
        <Streamdown>{item.text || (item.streaming ? "…" : "")}</Streamdown>
      </div>
    </article>
  );
}

/** 渲染右侧 Dock 内独立的 Pi Agent 插件页面。 */
export function PiAgentPane({ cwd, active }: Props) {
  const [view, dispatch] = useReducer(piViewReducer, INITIAL_PI_VIEW_STATE);
  const [probe, setProbe] = useState<Awaited<
    ReturnType<typeof probePiAgent>
  > | null>(null);
  const [sessions, setSessions] = useState<PiSessionSummary[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(cwd);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [popup, setPopup] = useState<"search" | "export" | "settings" | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [modelsPath, setModelsPath] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [modelsMessage, setModelsMessage] = useState("");
  const [exportMessage, setExportMessage] = useState("");
  const [threadMenu, setThreadMenu] = useState<{
    path: string;
    x: number;
    y: number;
  } | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const runtimeRef = useRef<number | null>(null);
  const listenerReady = useRef(false);
  const requestRef = useRef(1);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const refreshSessionsRef = useRef<() => void>(() => undefined);
  const pluginProjects = usePluginStore((state) => state.piAgentProjects);
  const hiddenProjects = usePluginStore((state) => state.piAgentHiddenProjects);
  const virtualizer = useVirtualizer({
    count: view.items.length,
    getScrollElement: () => transcriptRef.current,
    estimateSize: () => 88,
    overscan: 6,
  });

  /** 刷新全部 Pi 会话，并把发现的 cwd 合并为项目分组。 */
  const refreshSessions = useCallback(async () => {
    const next = await listAllPiSessions().catch(() => []);
    setSessions(next);
    setProjects((current) => [
      ...new Set([
        ...current,
        ...(cwd ? [cwd] : []),
        ...pluginProjects,
        ...next.map((item) => item.cwd),
      ]),
    ]);
  }, [cwd, pluginProjects]);
  refreshSessionsRef.current = () => {
    void refreshSessions();
  };
  useEffect(() => {
    if (!active) return;
    void probePiAgent()
      .then(setProbe)
      .catch((error) =>
        setProbe({
          available: false,
          path: null,
          version: null,
          error: String(error),
        }),
      );
    void refreshSessions();
  }, [active, refreshSessions]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void listenPiEvents((payload) => {
      if (payload.sessionId !== runtimeRef.current) return;
      dispatch({ type: "event", payload });
      if (payload.event.type === "process_exit") runtimeRef.current = null;
      if (payload.event.type === "agent_settled") refreshSessionsRef.current();
      if (
        payload.event.type === "response" &&
        payload.event.command === "export_html"
      ) {
        const data = payload.event.data;
        const path =
          typeof data === "object" && data !== null && "path" in data
            ? String(data.path)
            : "";
        setExportMessage(path ? `已导出：${path}` : "导出完成");
      }
    }).then((stop) => {
      if (disposed) stop();
      else listenerReady.current = true;
    });
    return () => {
      disposed = true;
      const id = runtimeRef.current;
      runtimeRef.current = null;
      if (id !== null) void closePiAgent(id);
    };
  }, [active]);
  useEffect(() => {
    setProjects((current) => [
      ...new Set([...current, ...(cwd ? [cwd] : []), ...pluginProjects]),
    ]);
    if (selectedProject === null && cwd) setSelectedProject(cwd);
  }, [cwd, pluginProjects, selectedProject]);
  useEffect(() => {
    if (!nearBottomRef.current || !view.items.length) return;
    virtualizer.scrollToIndex(view.items.length - 1, { align: "end" });
  }, [virtualizer, view.items.length]);

  const groups = useMemo<Project[]>(
    () =>
      projects
        .filter((path) => !hiddenProjects.includes(path))
        .map((path) => ({
          cwd: path,
          sessions: sessions.filter(
            (item) =>
              item.cwd.replace(/\\/g, "/").toLowerCase() ===
              path.replace(/\\/g, "/").toLowerCase(),
          ),
        }))
        .filter((group) => !hiddenProjects.includes(group.cwd)),
    [cwd, hiddenProjects, pluginProjects, projects, sessions],
  );
  const selectedSession = selectedPath
    ? (sessions.find((item) => item.path === selectedPath) ?? null)
    : null;
  const activeProjectCwd = selectedSession?.cwd ?? selectedProject ?? cwd;
  const openRuntime = useCallback(
    async (sessionPath?: string, sessionCwd = cwd) => {
      if (!sessionCwd || !probe?.available || !listenerReady.current)
        throw new Error("Pi 尚未就绪");
      if (runtimeRef.current !== null) await closePiAgent(runtimeRef.current);
      dispatch({ type: "reset", status: "starting" });
      const result = await startPiAgent(sessionCwd, sessionPath);
      runtimeRef.current = result.sessionId;
      for (const type of [
        "get_messages",
        "get_state",
        "get_available_models",
        "get_available_thinking_levels",
        "get_session_stats",
      ])
        await sendPiCommand(result.sessionId, {
          id: `codev-${requestRef.current++}`,
          type,
        });
    },
    [cwd, probe],
  );
  const selectSession = useCallback(
    (session: PiSessionSummary) => {
      setSelectedPath(session.path);
      setSelectedProject(session.cwd);
      void openRuntime(session.path, session.cwd).catch((error) =>
        dispatch({ type: "error", message: String(error) }),
      );
    },
    [openRuntime],
  );
  const createSession = useCallback(() => {
    setSelectedPath(null);
    void openRuntime(undefined, activeProjectCwd).catch((error) =>
      dispatch({ type: "error", message: String(error) }),
    );
  }, [activeProjectCwd, openRuntime]);
  const addProject = useCallback(async () => {
    const result = await open({
      directory: true,
      multiple: false,
      title: "选择 Pi 项目",
    });
    if (typeof result !== "string") return;
    const path = result.replace(/\\/g, "/");
    const next = [...new Set([...projects, path])];
    setProjects(next);
    await setPiAgentProjects(next);
    await setPiAgentHiddenProjects(
      hiddenProjects.filter((item) => item !== path),
    );
  }, [hiddenProjects, projects]);
  const removeProject = useCallback(
    async (path: string) => {
      const next = projects.filter((item) => item !== path);
      setProjects(next);
      await setPiAgentProjects(next);
      await setPiAgentHiddenProjects([...hiddenProjects, path]);
      if (selectedProject === path) {
        setSelectedProject(cwd);
        setSelectedPath(null);
      }
    },
    [cwd, hiddenProjects, projects, selectedProject],
  );
  const renameSession = useCallback(async () => {
    const value = editingName.trim();
    if (!runtimeRef.current || !value) return;
    await sendPiCommand(runtimeRef.current, {
      type: "set_session_name",
      name: value,
    });
    setEditingPath(null);
    await refreshSessions();
  }, [editingName, refreshSessions]);
  const submit = useCallback(async () => {
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    dispatch({
      type: "optimistic_user",
      id: `local-user-${requestRef.current++}`,
      text: message,
    });
    try {
      let id = runtimeRef.current;
      if (id === null) {
        await openRuntime(undefined, activeProjectCwd);
        id = runtimeRef.current;
      }
      if (id === null) throw new Error("Pi 会话未启动");
      await sendPiCommand(id, {
        id: `codev-${requestRef.current++}`,
        type: "prompt",
        message,
        ...(view.status === "running" ? { streamingBehavior: "steer" } : {}),
      });
    } catch (error) {
      dispatch({ type: "error", message: String(error) });
      setDraft(message);
    }
  }, [activeProjectCwd, draft, openRuntime, view.status]);
  const exportSession = useCallback(async () => {
    setExportMessage("");
    if (runtimeRef.current)
      await sendPiCommand(runtimeRef.current, {
        id: `codev-${requestRef.current++}`,
        type: "export_html",
      });
    setPopup(null);
  }, []);

  /** 复制线程文件路径，便于在文件树或资源管理器中定位会话。 */
  const copyThreadPath = useCallback(async (path: string) => {
    await navigator.clipboard.writeText(path).catch(() => undefined);
    setThreadMenu(null);
  }, []);

  /** 关闭当前 Pi RPC 进程并保留线程文件。 */
  const closeRuntime = useCallback(() => {
    const id = runtimeRef.current;
    runtimeRef.current = null;
    if (id !== null) void closePiAgent(id);
    dispatch({ type: "reset" });
    setThreadMenu(null);
  }, []);
  const saveModels = useCallback(async () => {
    try {
      await writePiModels(modelsText);
      setModelsMessage("已保存");
    } catch (error) {
      setModelsMessage(String(error));
    }
  }, [modelsText]);
  const openSettings = useCallback(async () => {
    setPopup("settings");
    try {
      const file = await readPiModels();
      setModelsPath(file.path);
      setModelsText(file.content);
      setModelsMessage("");
    } catch (error) {
      setModelsMessage(String(error));
    }
  }, []);
  const searchItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? view.items.flatMap((item, index) =>
          item.kind === "message" &&
          item.text.toLocaleLowerCase().includes(needle)
            ? [{ item, index }]
            : [],
        )
      : [];
  }, [query, view.items]);
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter(
        (session) =>
          !query.trim() ||
          `${session.name ?? ""} ${session.preview ?? ""}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
      ),
    }))
    .filter((group) => group.sessions.length || group.cwd === cwd);
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit();
    }
  };
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => setSidebarOpen((value) => !value)}
          title={sidebarOpen ? "收起线程栏" : "展开线程栏"}
          aria-label={sidebarOpen ? "收起线程栏" : "展开线程栏"}
        >
          <span className="flex flex-col gap-0.5" aria-hidden="true">
            <span className="h-px w-3 bg-current" />
            <span className="h-px w-3 bg-current" />
            <span className="h-px w-3 bg-current" />
          </span>
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
          {view.sessionName ||
            selectedSession?.name ||
            selectedSession?.preview ||
            "Pi Agent"}
        </span>
        <span
          className={
            view.status === "running"
              ? "text-[9px] text-[#7894b0]"
              : "text-[9px] text-muted-foreground"
          }
        >
          {statusLabel(view.status)}
        </span>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted"
          title="搜索"
          onClick={() => setPopup(popup === "search" ? null : "search")}
        >
          <HugeiconsIcon icon={Search01Icon} size={13} />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted"
          title="导出当前线程"
          onClick={() => setPopup(popup === "export" ? null : "export")}
        >
          <HugeiconsIcon icon={Download01Icon} size={13} />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted"
          title="Pi 设置"
          onClick={() => void openSettings()}
        >
          <HugeiconsIcon icon={Settings01Icon} size={13} />
        </button>
      </header>
      <div className="relative flex min-h-0 flex-1">
        {sidebarOpen ? (
          <aside className="flex w-52 shrink-0 flex-col border-r border-border/60 bg-card">
            <div className="flex shrink-0 gap-1 border-b border-border/50 p-1.5">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1 rounded-md bg-accent px-2 py-1.5 text-left text-[11px] hover:bg-accent/80"
                onClick={createSession}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={13} />
                新建线程
              </button>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                onClick={() => void addProject()}
                title="添加项目"
              >
                <HugeiconsIcon icon={Folder01Icon} size={13} />
              </button>
            </div>
            <div className="reader-scrollbar min-h-0 flex-1 overflow-y-auto p-1">
              {visibleGroups.map((group) => (
                <div key={group.cwd} className="mb-2">
                  <div
                    className={`group flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium ${selectedProject === group.cwd ? "bg-muted/70 text-foreground" : "text-muted-foreground"}`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left"
                      title={group.cwd}
                      onClick={() => {
                        setSelectedProject(group.cwd);
                        setSelectedPath(null);
                      }}
                    >
                      {projectName(group.cwd)}
                    </button>
                    <button
                      type="button"
                      className="hidden rounded p-0.5 text-muted-foreground hover:bg-muted group-hover:block"
                      onClick={() => void removeProject(group.cwd)}
                      title="删除项目"
                    >
                      <HugeiconsIcon icon={Cancel01Icon} size={11} />
                    </button>
                  </div>
                  {group.sessions.map((session) =>
                    editingPath === session.path ? (
                      <div
                        key={session.path}
                        className="mb-0.5 flex items-center gap-1 rounded-md bg-accent p-1"
                      >
                        <Input
                          autoFocus
                          value={editingName}
                          className="h-6 text-[10px]!"
                          onChange={(event) =>
                            setEditingName(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void renameSession();
                            if (event.key === "Escape") setEditingPath(null);
                          }}
                        />
                        <button
                          type="button"
                          className="rounded p-1 hover:bg-muted"
                          onClick={() => void renameSession()}
                        >
                          保存
                        </button>
                      </div>
                    ) : (
                      <div
                        key={session.path}
                        className={`group/session mb-0.5 flex items-start rounded-md ${selectedPath === session.path ? "bg-accent text-foreground" : "hover:bg-muted"}`}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setThreadMenu({ path: session.path, x: event.clientX, y: event.clientY });
                        }}
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 px-2 py-1.5 text-left"
                          onClick={() => selectSession(session)}
                        >
                          <span className="flex items-center gap-1">
                            <span
                              className={`size-1.5 shrink-0 rounded-full ${selectedPath === session.path && view.status === "running" ? "bg-[#7894b0]" : "bg-muted-foreground/35"}`}
                            />
                            <span className="truncate text-[11px] font-medium">
                              {session.name || session.preview || "未命名线程"}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate pl-2.5 text-[9px] text-muted-foreground">
                            {session.messageCount} 条消息 ·{" "}
                            {new Date(session.updatedAt).toLocaleString()}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="mt-1 hidden rounded p-1 text-muted-foreground hover:bg-muted group-hover/session:block"
                          title="重命名"
                          onClick={() => {
                            if (selectedPath !== session.path)
                              selectSession(session);
                            setEditingPath(session.path);
                            setEditingName(
                              session.name || session.preview || "",
                            );
                          }}
                        >
                          <HugeiconsIcon icon={Edit01Icon} size={11} />
                        </button>
                      </div>
                    ),
                  )}
                </div>
              ))}
            </div>
          </aside>
        ) : null}
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {popup === "search" ? (
            <div className="absolute right-2 top-2 z-20 w-[min(360px,calc(100%-1rem))] rounded-md border border-border bg-popover p-2 shadow-lg">
              <Input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索当前线程"
                className="h-7 text-[11px]!"
              />
              {searchItems.length ? (
                <div className="reader-scrollbar mt-1 max-h-48 overflow-y-auto">
                  {searchItems.map(({ item, index }) => (
                    <button
                      type="button"
                      key={item.id}
                      className="block w-full truncate px-2 py-1 text-left text-[11px] hover:bg-accent"
                      onClick={() =>
                        virtualizer.scrollToIndex(index, { align: "center" })
                      }
                    >
                      {item.text}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {popup === "export" ? (
            <div className="absolute right-2 top-2 z-20 rounded-md border border-border bg-popover p-1 shadow-lg">
              <button
                type="button"
                className="flex items-center gap-2 rounded px-2 py-1.5 text-[11px] hover:bg-accent"
                onClick={() => void exportSession()}
              >
                <HugeiconsIcon icon={Download01Icon} size={12} />
                导出当前线程 HTML
              </button>
              {exportMessage ? <div className="max-w-72 px-2 py-1 text-[10px] text-muted-foreground">{exportMessage}</div> : null}
            </div>
          ) : null}
          {popup === "settings" ? (
            <div className="absolute right-2 top-2 z-20 flex w-[min(440px,calc(100%-1rem))] flex-col gap-2 rounded-md border border-border bg-popover p-2 shadow-lg">
              <div className="flex items-center text-[11px] font-medium">
                <span className="flex-1">Pi 设置</span>
                <button type="button" onClick={() => setPopup(null)}>
                  <HugeiconsIcon icon={Cancel01Icon} size={12} />
                </button>
              </div>
              <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
                <label className="text-[10px] text-muted-foreground">
                  模型
                </label>
                <select
                  className="h-7 min-w-0 bg-transparent text-[11px]"
                  value={
                    view.model ? `${view.model.provider}\0${view.model.id}` : ""
                  }
                  onChange={(event) => {
                    const [provider, modelId] = event.target.value.split("\0");
                    if (runtimeRef.current)
                      void sendPiCommand(runtimeRef.current, {
                        type: "set_model",
                        provider,
                        modelId,
                      });
                  }}
                >
                  {view.models.map((model) => (
                    <option
                      key={`${model.provider}/${model.id}`}
                      value={`${model.provider}\0${model.id}`}
                    >
                      {model.name || `${model.provider}/${model.id}`}
                    </option>
                  ))}
                </select>
                <label className="text-[10px] text-muted-foreground">
                  思考等级
                </label>
                <select
                  className="h-7 bg-transparent text-[11px]"
                  value={view.thinkingLevel}
                  onChange={(event) =>
                    runtimeRef.current &&
                    void sendPiCommand(runtimeRef.current, {
                      type: "set_thinking_level",
                      level: event.target.value,
                    })
                  }
                >
                  {view.thinkingLevels.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </div>
              <div
                className="truncate border-t border-border/50 pt-2 text-[10px] text-muted-foreground"
                title={modelsPath}
              >
                {modelsPath}
              </div>
              <textarea
                value={modelsText}
                onChange={(event) => setModelsText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.ctrlKey && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    void saveModels();
                  }
                }}
                className="reader-scrollbar min-h-40 resize-y rounded border border-border bg-background p-2 font-mono text-[10px] outline-none"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded bg-primary px-2 py-1 text-[10px] text-primary-foreground"
                  onClick={() => void saveModels()}
                >
                  保存 models.json
                </button>
                <span className="text-[10px] text-muted-foreground">
                  {modelsMessage}
                </span>
              </div>
            </div>
          ) : null}
          {threadMenu ? (
            <div
              className="fixed z-50 min-w-36 rounded-md border border-border bg-popover p-1 shadow-lg"
              style={{ left: threadMenu.x, top: threadMenu.y }}
              onMouseLeave={() => setThreadMenu(null)}
            >
              <button type="button" className="block w-full rounded px-2 py-1.5 text-left text-[11px] hover:bg-accent" onClick={() => { const session = sessions.find((item) => item.path === threadMenu.path); if (session) { setSelectedProject(session.cwd); setSelectedPath(session.path); setEditingPath(session.path); setEditingName(session.name || session.preview || ""); } setThreadMenu(null); }}>重命名</button>
              <button type="button" className="block w-full rounded px-2 py-1.5 text-left text-[11px] hover:bg-accent" onClick={() => void copyThreadPath(threadMenu.path)}>复制会话路径</button>
              <button type="button" className="block w-full rounded px-2 py-1.5 text-left text-[11px] hover:bg-accent" onClick={() => { setSelectedPath(threadMenu.path); setPopup("export"); setThreadMenu(null); }}>导出当前线程</button>
              <button type="button" className="block w-full rounded px-2 py-1.5 text-left text-[11px] hover:bg-accent" onClick={closeRuntime}>关闭线程</button>
            </div>
          ) : null}
          <div
            ref={transcriptRef}
            className="reader-scrollbar min-h-0 flex-1 overflow-y-auto"
            onScroll={(event) => {
              const node = event.currentTarget;
              nearBottomRef.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            }}
          >
            {view.items.length ? (
              <div
                className="relative w-full"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualItems.map((virtualItem) => (
                  <div
                    key={view.items[virtualItem.index].id}
                    ref={virtualizer.measureElement}
                    data-index={virtualItem.index}
                    className="absolute left-0 top-0 w-full px-2"
                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                  >
                    <TranscriptItem item={view.items[virtualItem.index]} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-muted-foreground">
                {cwd
                  ? probe?.available === false
                    ? probe.error
                    : "输入任务，开始当前工作区的 Pi 会话"
                  : "请先选择工作区根目录"}
              </div>
            )}
          </div>
          {view.error ? (
            <div className="border-t border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
              {view.error}
            </div>
          ) : null}
          <footer className="shrink-0 border-t border-border/60 bg-background p-2">
            <textarea
              value={draft}
              rows={3}
              placeholder="向 Pi 发送任务，Shift+Enter 换行"
              className="reader-scrollbar max-h-40 min-h-16 w-full resize-none rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-[12px] outline-none focus:border-muted-foreground/60"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={keyDown}
              disabled={!cwd || probe?.available === false}
            />
            <div className="mt-1 flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-[9px] text-muted-foreground">
                {probe?.available
                  ? `Pi ${probe.version ?? ""}`
                  : "正在探测 Pi…"}
                {view.contextPercent !== null
                  ? ` · 上下文 ${Math.round(view.contextPercent)}%`
                  : ""}
              </span>
              {view.status === "running" || view.status === "stopping" ? (
                <button
                  type="button"
                  className="h-7 rounded border border-border px-2 text-[11px]"
                  onClick={() =>
                    runtimeRef.current &&
                    void sendPiCommand(runtimeRef.current, { type: "abort" })
                  }
                >
                  停止
                </button>
              ) : null}
              <button
                type="button"
                className="h-7 rounded bg-primary px-3 text-[11px] text-primary-foreground disabled:opacity-40"
                onClick={() => void submit()}
                disabled={!cwd || !draft.trim() || !probe?.available}
              >
                {view.status === "running" ? "追加" : "发送"}
              </button>
            </div>
          </footer>
        </main>
      </div>
    </section>
  );
}
