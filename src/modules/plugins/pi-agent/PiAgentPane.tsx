import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Search01Icon,
  Settings01Icon,
  LayoutRightIcon,
  GridViewIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  usePluginStore,
  setPiAgentProjects,
  setPiAgentHiddenProjects,
  setPiAgentOrganization,
  setPiAgentLastModel,
  setPiAgentLastThinkingLevel,
  setPiAgentProjectOrder,
  setPiAgentSessionOrder,
} from "../store";
import {
  CATALOG_ADAPT_NOTICE,
  PiWorkspaceClient,
  type PiThread,
} from "./client";
import { INITIAL_PI_VIEW_STATE, objectValue } from "./reducer";
import {
  listPiSessions,
  watchPiSessions,
  probePiAgent,
  sendPiCommand,
  deletePiSession,
  piAgentHomeDir,
} from "./native";
import {
  collectProjects,
  nextDraftKey,
  pathKey,
  projectName,
  sessionIdentity,
  visiblePiProjects,
  withArchivedPath,
} from "./organization";
import { notifyFinishedProjects } from "./piNotify";
import { projectActivity, type ProjectActivity } from "./projectActivity";
import { adoptOrderIds, prependOrderId } from "./sidebarOrder";
import { PiSidebar, type SidebarThread } from "./PiSidebar";
import { PiComposer, EMPTY_DRAFT, type PiDraft } from "./PiComposer";
import {
  addPathAttachments,
  draftHasPayload,
  isImagePath,
  readPathImage,
  withAttachmentPrompt,
} from "./piAttachments";
import { usePiComposerNativeDrop } from "./piComposerDrop";
import { usePiComposerDropStore } from "./piComposerDropStore";
import { PiTranscript } from "./PiTranscript";
import { PiSettings } from "./PiSettings";
import { plainStatusText } from "./statusText";
import type { PiMessageItem, PiModel, PiSessionSummary } from "./types";
import { localCommand } from "./commands";
import { editableLastUser } from "./editLastUser";
import { toast } from "sonner";
import { MAX_PI_VIEWPORTS, placePiSession } from "./viewportLayout";
import "./pi-agent.css";

type ExtensionRequest = { key: string; event: Record<string, unknown> };

function latestAssistantSummary(thread?: PiThread): string | null {
  const items = thread?.view.items ?? [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (
      item.kind === "message" &&
      item.role === "assistant" &&
      item.text.trim()
    )
      return item.text;
  }
  return null;
}

/** 插件入口只协调原生会话与 Codev 组件，不接管外部文件树或终端。 */
export function PiAgentPane({
  active,
  onOpenFile,
}: {
  active: boolean;
  onOpenFile?: (path: string) => void;
}) {
  const [initialized, setInitialized] = useState(false);
  const client = useRef<PiWorkspaceClient | null>(null);
  const activityRef = useRef(new Map<string, ProjectActivity>());
  const [threads, setThreads] = useState<PiThread[]>([]);
  const [sessions, setSessions] = useState<PiSessionSummary[]>([]);
  const [sessionsReady, setSessionsReady] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewportKeys, setViewportKeys] = useState<(string | null)[]>([]);
  const [activeViewport, setActiveViewport] = useState(0);
  const [dropViewport, setDropViewport] = useState<number | null>(null);
  /** 将选中的会话放入目标视口；已有会话可直接切焦点或交换位置。 */
  const activateThread = (key: string | null, target?: number) => {
    if (viewportKeys.length) {
      const existing = key === null ? -1 : viewportKeys.indexOf(key);
      const index = target ?? (existing >= 0 ? existing : activeViewport);
      setActiveViewport(index);
      setViewportKeys((slots) => placePiSession(slots, index, key));
    }
    setSelected(key);
  };
  /** 退出并行模式保留当前会话，隐藏视口不停止后台任务。 */
  const toggleViewports = () => {
    setViewportKeys(viewportKeys.length ? [] : [selected, null]);
    setActiveViewport(0);
    setDropViewport(null);
  };
  /** 追加空视口，最多六个，等待用户放入会话。 */
  const addViewport = () => {
    if (viewportKeys.length >= MAX_PI_VIEWPORTS) {
      toast.info("最多支持 6 个 Pi 会话视口，可替换现有视口中的会话。");
      return;
    }
    setViewportKeys((slots) => [...slots, null]);
  };
  /** 仅关闭展示卡片；移除当前卡片后聚焦仍保留的会话。 */
  const closeViewport = (index: number) => {
    const next = viewportKeys.filter((_, position) => position !== index);
    const focus =
      index < activeViewport
        ? activeViewport - 1
        : Math.min(activeViewport, next.length - 1);
    setSelected(next[focus] ?? null);
    setActiveViewport(Math.max(0, focus));
    setViewportKeys(next.length > 1 ? next : []);
  };
  /** 根据指针命中读取视口序号，供侧栏 pointer 拖拽使用。 */
  const viewportAtPoint = (x: number, y: number): number | null => {
    const element = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-pi-viewport-index]");
    return element ? Number(element.dataset.piViewportIndex) : null;
  };
  const [revealThreadKey, setRevealThreadKey] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [piHome, setPiHome] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<PiModel[]>([]);
  const [drafts, setDrafts] = useState<Record<string, PiDraft>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [operations, setOperations] = useState<Record<string, string>>({});
  const operationKeys = useRef(new Set<string>());
  const [focusRevisions, setFocusRevisions] = useState<Record<string, number>>(
    {},
  );
  const [deleteTarget, setDeleteTarget] = useState<SidebarThread | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(236);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [sendRevisions, setSendRevisions] = useState<Record<string, number>>(
    {},
  );
  const [probe, setProbe] = useState<Awaited<
    ReturnType<typeof probePiAgent>
  > | null>(null);
  const pinnedDrafts = useRef(new Set<string>());
  const [rename, setRename] = useState<{
    thread: SidebarThread;
    name: string;
  } | null>(null);
  const [viewportRename, setViewportRename] = useState<{
    thread: SidebarThread;
    name: string;
  } | null>(null);
  const [requests, setRequests] = useState<ExtensionRequest[]>([]);
  const [answer, setAnswer] = useState("");
  const [extensionStatus, setExtensionStatus] = useState<
    Record<string, Record<string, string>>
  >({});
  const pluginProjects = usePluginStore((state) => state.piAgentProjects);
  const hiddenProjects = usePluginStore((state) => state.piAgentHiddenProjects);
  const organization = usePluginStore((state) => state.piAgentOrganization);
  const hydrated = usePluginStore((state) => state.hydrated);
  const lastModel = usePluginStore((state) => state.piAgentLastModel);
  const lastThinkingLevel = usePluginStore(
    (state) => state.piAgentLastThinkingLevel,
  );
  const projectOrder = usePluginStore((state) => state.piAgentProjectOrder);
  const sessionOrder = usePluginStore((state) => state.piAgentSessionOrder);
  const activeThread = threads.find((thread) => thread.key === selected);
  const view = activeThread?.view ?? INITIAL_PI_VIEW_STATE;
  const activeCwd = activeThread?.cwd ?? project;
  const draftKey = selected ?? "";
  const draft = drafts[draftKey] ?? EMPTY_DRAFT;
  /** 将提示绑定到操作发起时的线程，异步返回不污染后来选中的线程。 */
  const setNotice = (message: string, key = draftKey) =>
    setNotices((current) => ({ ...current, [key]: message }));
  const projects = useMemo(
    () =>
      visiblePiProjects(
        collectProjects(
          [...pluginProjects, ...threads.map((item) => item.cwd)],
          sessions,
          hiddenProjects,
        ),
        piHome,
      ),
    [pluginProjects, threads, sessions, hiddenProjects, piHome],
  );
  const selectedProjectRef = useRef(project);
  selectedProjectRef.current = project;
  /** 仅读取用户选择的项目目录，合并到已访问项目缓存。 */
  const refreshSessions = useCallback(async (cwd?: string) => {
    const target = cwd ?? selectedProjectRef.current;
    if (!target) return;
    const result = await listPiSessions(target);
    setSessions(current => [...current.filter(item => pathKey(item.cwd) !== pathKey(target)), ...result]);
    setSessionsReady(true);
  }, []);
  /** 选择项目后才监听该项目的会话文件，连续写入合并为一次刷新。 */
  useEffect(() => {
    if (!initialized || !project) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let dirty = false;
    const schedule = () => {
      dirty = true;
      if (disposed || timer || reading) return;
      timer = setTimeout(async () => {
        timer = undefined;
        reading = true;
        dirty = false;
        try { await refreshSessions(project); }
        catch (error) { if (!disposed) setNotice(String(error)); }
        finally { reading = false; if (dirty && !disposed) schedule(); }
      }, 1500);
    };
    const stop = watchPiSessions(schedule, project);
    void stop.catch(error => { if (!disposed) setNotice(String(error)); });
    return () => {
      disposed = true;
      clearTimeout(timer);
      void stop.then(cleanup => cleanup()).catch(() => {});
    };
  }, [initialized, project, refreshSessions]);
  useEffect(() => {
    if (!active) return;
    setInitialized(true);
  }, [active]);
  useEffect(() => {
    if (!initialized) return;
    let disposed = false;
    const runtime = new PiWorkspaceClient(
      () => {
        if (!disposed) setThreads([...runtime.threads.values()]);
      },
      (key, event) => {
        if (
          ["select", "confirm", "input", "editor"].includes(
            String(event.method),
          )
        )
          setRequests((value) => [...value, { key, event }]);
        if (event.method === "set_editor_text")
          setDrafts((value) => ({
            ...value,
            [key]: {
              ...(value[key] ?? EMPTY_DRAFT),
              text: String(event.text ?? ""),
            },
          }));
        if (event.method === "error")
          setNotice(String(event.message ?? ""), key);
        if (event.method === "setStatus")
          setExtensionStatus((value) => ({
            ...value,
            [key]: {
              ...value[key],
              [String(event.statusKey)]: String(event.statusText ?? ""),
            },
          }));
      },
    );
    client.current = runtime;
    void probePiAgent()
      .then((result) => {
        if (!disposed) setProbe(result);
      })
      .catch((error) => {
        if (!disposed) setNotice(String(error));
      });
    void piAgentHomeDir()
      .then((path) => {
        if (!disposed && path) setPiHome(path);
      })
      .catch((error) => {
        if (!disposed) setNotice(String(error));
      });
    void runtime
      .loadCatalog()
      .then((models) => {
        if (!disposed) setCatalog(models);
      })
      .catch((error) => {
        if (!disposed) setNotice(String(error));
      });
    return () => {
      disposed = true;
      runtime.dispose();
      if (client.current === runtime) client.current = null;
    };
  }, [initialized, refreshSessions]);
  const previousIdentities = useRef(new Map<string, string>());
  const rows = useMemo<SidebarThread[]>(() => {
    const result: SidebarThread[] = sessions
      .filter((session) => session.path)
      .map((session) => ({
        ...session,
        key: session.path,
      }));
    for (const thread of threads) {
      const path = thread.view.sessionFile ?? "";
      const index = result.findIndex(
        (row) =>
          row.key === thread.key ||
          (path && pathKey(row.path) === pathKey(path)),
      );
      const old = index >= 0 ? result[index] : null;
      const first = thread.view.items.find(
        (item) => item.kind === "message" && item.role === "user",
      );
      const row: SidebarThread = {
        id: old?.id ?? thread.key,
        path: path || old?.path || "",
        key: thread.key,
        cwd: thread.cwd,
        name: thread.view.sessionName ?? old?.name ?? null,
        preview:
          old?.preview ??
          (first && first.kind === "message" ? first.text.slice(0, 80) : null),
        createdAt: old?.createdAt ?? "",
        updatedAt: old?.updatedAt ?? Date.now(),
        messageCount: thread.view.items.length || old?.messageCount || 0,
        status:
          thread.view.compaction?.status === "running"
            ? "running"
            : thread.view.status,
        waiting: requests.some((request) => request.key === thread.key),
      };
      if (index >= 0) result[index] = row;
      else if (thread.view.items.length || path || thread.key === selected)
        result.unshift(row);
    }
    return result;
  }, [sessions, threads, requests, selected]);
  useEffect(() => {
    const replacements: Array<[string, string]> = [];
    for (const row of rows) {
      const previous = previousIdentities.current.get(row.key);
      const next = sessionIdentity(row.path, row.key);
      if (previous && previous !== next) replacements.push([previous, next]);
      previousIdentities.current.set(row.key, next);
    }
    if (!replacements.length) return;
    void setPiAgentSessionOrder((current) =>
      adoptOrderIds(current, replacements),
    );
  }, [rows]);
  useEffect(() => {
    const notificationThreads = rows.map((row) => ({
      ...row,
      summary: latestAssistantSummary(
        threads.find((thread) => thread.key === row.key),
      ),
    }));
    const previous = activityRef.current;
    const current = projectActivity(notificationThreads);
    // 先消费状态变化，窗口和权限查询期间的 render 不会重复发送。
    activityRef.current = current;
    void notifyFinishedProjects({
      previous,
      current,
      threads: notificationThreads,
      piActive: active,
    });
  }, [rows, active, threads]);
  /** 用统一提示处理操作异常，避免无响应按钮。 */
  const run = (operation: Promise<unknown>, key = draftKey) => {
    void operation.catch((error) => setNotice(String(error), key));
  };
  /** 获取指定会话的进程，操作始终指向右键目标。 */
  const ensure = async (
    thread?: SidebarThread,
    key = selected,
  ): Promise<PiThread> => {
    const runtime = client.current;
    const targetCwd =
      thread?.cwd ??
      runtime?.threads.get(key ?? "")?.cwd ??
      activeCwd ??
      piHome;
    if (!runtime || !targetCwd) throw new Error("请先等待 Pi 初始化");
    return runtime.open(
      thread?.key ?? key ?? "",
      targetCwd,
      thread?.path || undefined,
    );
  };
  /** 新线程建立后绑定该项目，其他线程的进程继续运行。 */
  const create = async (path: string) => {
    setProject(path);
    const key = nextDraftKey(path);
    if (!pinnedDrafts.current.has(key)) {
      pinnedDrafts.current.add(key);
      void setPiAgentSessionOrder((current) => prependOrderId(current, key));
    }
    activateThread(key);
    setRevealThreadKey(key);
    setSearchOpen(false);
    const target = await client.current!.open(key, path);
    client.current!.applyCatalogModel(target, lastModel);
    target.view = { ...target.view, thinkingLevel: lastThinkingLevel };
    setThreads([...client.current!.threads.values()]);
  };
  /** 用户选择项目才读取历史；空项目等待用户点击新建。 */
  const selectProject = async (cwd: string) => {
    setProject(cwd);
    await refreshSessions(cwd);
  };
  /** 首次选择读取历史，后续复用内存中的会话和已加载分页。 */
  const select = async (thread: SidebarThread, targetIndex?: number) => {
    setProject(thread.cwd);
    activateThread(thread.key, targetIndex);
    setSearchOpen(false);
    const target = await ensure(thread);
    if (
      target.runtimeId !== null ||
      target.loadingHistory ||
      target.view.historyOffset !== null ||
      target.view.items.length > 0
    )
      return;
    await client.current!.hydrateFromDisk(target, lastModel);
  };
  /** 添加原生目录并选择项目，空文件夹也可直接开始任务。 */
  const addProject = async () => {
    const result = await open({
      directory: true,
      multiple: false,
      title: "选择 Pi 项目",
    });
    if (typeof result !== "string") return;
    await setPiAgentProjects([...pluginProjects, result]);
    await setPiAgentHiddenProjects(
      hiddenProjects.filter((item) => pathKey(item) !== pathKey(result)),
    );
    await selectProject(result);
    setSidebarOpen(true);
  };
  /** 从插件列表移除项目，磁盘文件与会话保持原样。 */
  const removeProject = async (path: string) => {
    await setPiAgentProjects(
      pluginProjects.filter((item) => pathKey(item) !== pathKey(path)),
    );
    await setPiAgentHiddenProjects([...hiddenProjects, path]);
    if (pathKey(activeCwd ?? "") === pathKey(path)) {
      setProject(
        projects.find((item) => pathKey(item) !== pathKey(path)) ?? null,
      );
      activateThread(null);
    }
  };
  const ingestDroppedPaths = useCallback(
    (
      items: Array<{ path: string; kind: "file" | "dir" }>,
      targetKey = draftKey,
    ) => {
      void (async () => {
        const images: typeof draft.images = [];
        const files: Array<{ path: string; kind: "file" | "dir" }> = [];
        for (const item of items) {
          if (item.kind === "file" && isImagePath(item.path)) {
            try {
              images.push(await readPathImage(item.path));
            } catch {
              files.push(item);
            }
          } else files.push(item);
        }
        setDrafts((value) => {
          const current = value[targetKey] ?? EMPTY_DRAFT;
          return {
            ...value,
            [targetKey]: {
              ...current,
              images: [...current.images, ...images],
              files: addPathAttachments(current.files, files),
            },
          };
        });
      })().catch((error) => setNotice(String(error), targetKey));
    },
    [draftKey],
  );
  useEffect(() => {
    const store = usePiComposerDropStore.getState();
    store.setActive(active);
    store.setDrop(ingestDroppedPaths);
    return () => {
      store.setActive(false);
      store.setDrop(null);
      store.setHover(false);
    };
  }, [active, ingestDroppedPaths]);
  usePiComposerNativeDrop({
    active: () => active && usePiComposerDropStore.getState().active,
    onDrop: ingestDroppedPaths,
    onHover: (hover, key) =>
      usePiComposerDropStore.getState().setHover(hover, key),
  });
  /** 待 Pi 确认接受后清除当前草稿，失败时原输入仍可编辑重发。 */
  const submit = async (
    behavior: "steer" | "followUp",
    targetKey = selected,
  ) => {
    const selected = targetKey;
    const draftKey = targetKey ?? "";
    const draft = drafts[draftKey] ?? EMPTY_DRAFT;
    const activeThread = threads.find((thread) => thread.key === targetKey);
    const text = withAttachmentPrompt(draft.text, draft.files);
    if (activeThread?.view.compaction?.status === "running") {
      if (!draftHasPayload(draft)) return;
      client.current!.enqueue(activeThread, text, draft.images, behavior);
      setDrafts((value) => ({ ...value, [draftKey]: EMPTY_DRAFT }));
      return;
    }
    if (operationKeys.current.has(draftKey)) return;
    const command = localCommand(draft.text);
    if (command) {
      if (draft.images.length || draft.files.length)
        throw new Error("请先移除附件再执行会话命令");
      const thread = await ensure(
        rows.find((row) => row.key === selected),
        selected,
      );
      if (command.name === "fork") {
        const target = rows.find((row) => row.key === thread.key);
        if (!target) throw new Error("当前线程尚未建立，无法分叉");
        await forkThread(target);
      } else
        await operate(thread, "正在压缩上下文…", async () => {
          setDrafts((value) => ({
            ...value,
            [draftKey]:
              value[draftKey] === draft ? EMPTY_DRAFT : value[draftKey],
          }));
          await client.current!.compact(thread, command.argument);
        });
      setDrafts((value) => ({
        ...value,
        [draftKey]: value[draftKey] === draft ? EMPTY_DRAFT : value[draftKey],
      }));
      return;
    }
    if (!draftHasPayload(draft)) return;
    const alreadySending = pending.has(draftKey);
    const sourceKey = draftKey;
    let runtimeKey = sourceKey;
    setPending((value) => new Set([...value, sourceKey]));
    try {
      const thread = await ensure(
        rows.find((row) => row.key === selected),
        selected,
      );
      runtimeKey = thread.key;
      const queued =
        alreadySending ||
        thread.view.status === "running" ||
        thread.view.status === "stopping";
      setPending((value) => new Set([...value, runtimeKey]));
      setSelected((current) => (current === selected ? thread.key : current));
      const adapted = queued
        ? false
        : await client.current!.prepareCatalogRuntime(thread);
      setNotice(adapted ? CATALOG_ADAPT_NOTICE : "", thread.key);
      setSendRevisions((value) => ({
        ...value,
        [thread.key]: (value[thread.key] ?? 0) + 1,
      }));
      client.current!.beginPrompt(thread, text, draft.images, queued);
      setDrafts((value) => ({
        ...value,
        [sourceKey]: EMPTY_DRAFT,
        [thread.key]: EMPTY_DRAFT,
      }));
      await client.current!.request(
        thread,
        queued
          ? {
              type: behavior === "steer" ? "steer" : "follow_up",
              message: text,
              ...(draft.images.length ? { images: draft.images } : {}),
            }
          : {
              type: "prompt",
              message: text,
              ...(draft.images.length ? { images: draft.images } : {}),
            },
      );
      await client.current!.refreshState(thread);
    } catch (error) {
      setDrafts((value) => ({
        ...value,
        [sourceKey]:
          value[sourceKey] === EMPTY_DRAFT ? draft : value[sourceKey],
      }));
      throw error;
    } finally {
      setPending((value) => {
        const next = new Set(value);
        next.delete(sourceKey);
        next.delete(runtimeKey);
        return next;
      });
    }
  };
  /** 串行执行同一线程的会话操作，状态提示与异步结果留在原线程。 */
  const operate = async (
    thread: PiThread,
    label: string,
    operation: () => Promise<void>,
  ) => {
    const key = thread.key;
    if (operationKeys.current.has(key)) return;
    operationKeys.current.add(key);
    setOperations((value) => ({ ...value, [key]: label }));
    try {
      await operation();
    } finally {
      operationKeys.current.delete(key);
      setOperations((value) => ({ ...value, [key]: "" }));
    }
  };
  /** 停止运行并将未执行的队列文字恢复到原线程草稿。 */
  const stopThread = async (thread: PiThread) => {
    await operate(thread, "正在停止…", async () => {
      const key = thread.key;
      /** 保留停止期间输入的新草稿，并恢复取回的文字和附件。 */
      const restore = (texts: string[]) => {
        setDrafts((value) => {
          const current = value[key] ?? EMPTY_DRAFT;
          return {
            ...value,
            [key]: {
              text: [...texts, current.text].filter(Boolean).join("\n\n"),
              images: current.images,
              files: current.files,
            },
          };
        });
        setFocusRevisions((value) => ({
          ...value,
          [key]: (value[key] ?? 0) + 1,
        }));
      };
      if (thread.view.status === "running" || thread.view.status === "stopping")
        await client.current!.stopAndRestore(thread, restore);
      else throw new Error("只有运行中的回复可以停止");
    });
  };
  /** 原位编辑已结束或主动终止的最后一轮，并通过 Pi 分叉重新执行。 */
  const editLastUser = async (
    thread: PiThread,
    item: PiMessageItem,
    text: string,
  ): Promise<boolean> => {
    const key = thread.key;
    if (operationKeys.current.has(key)) return false;
    if (editableLastUser(thread.view)?.id !== item.id)
      throw new Error("请等待运行结束后编辑最后一条输入");
    operationKeys.current.add(key);
    setOperations((value) => ({ ...value, [key]: "正在重新执行…" }));
    try {
      const accepted = await client.current!.editLastUser(
        thread,
        text,
        item.images ?? [],
      );
      if (accepted) {
        setSendRevisions((value) => ({
          ...value,
          [key]: (value[key] ?? 0) + 1,
        }));
        await refreshSessions();
      }
      return accepted;
    } finally {
      operationKeys.current.delete(key);
      setOperations((value) => ({ ...value, [key]: "" }));
    }
  };
  /** 确认后关闭目标进程并删除对应原生会话文件，同步清理侧栏记录。 */
  const deleteThread = async () => {
    if (!deleteTarget || !client.current || deleting) return;
    setDeleting(true);
    try {
      const target = deleteTarget;
      const matches = [...client.current.threads.values()].filter(
        (thread) =>
          thread.key === target.key ||
          pathKey(thread.view.sessionFile ?? "") === pathKey(target.path),
      );
      for (const thread of matches) await client.current.close(thread.key);
      await deletePiSession(target.path);
      for (const thread of matches) client.current.threads.delete(thread.key);
      setThreads(
        [...client.current.threads.values()].map((thread) => ({ ...thread })),
      );
      setSessions((value) =>
        value.filter(
          (session) => pathKey(session.path) !== pathKey(target.path),
        ),
      );
      const keys = new Set([
        target.key,
        ...matches.map((thread) => thread.key),
      ]);
      setDrafts((value) =>
        Object.fromEntries(
          Object.entries(value).filter(([key]) => !keys.has(key)),
        ),
      );
      setRequests((value) => value.filter((request) => !keys.has(request.key)));
      setViewportKeys((slots) =>
        slots.map((key) => (key && keys.has(key) ? null : key)),
      );
      if (selected && keys.has(selected)) {
        const fallback = rows.find((row) => !keys.has(row.key));
        activateThread(fallback?.key ?? null);
        if (fallback) setProject(fallback.cwd);
      }
      await setPiAgentOrganization({
        ...organization,
        archived: withArchivedPath(organization.archived, target.path, false),
      });
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };
  /** 无确认创建同名序号分叉，复制会话文件，不启动 runtime。 */
  const forkThread = async (target: SidebarThread) => {
    const source = await ensure(target);
    const base = target.name || target.preview || projectName(target.cwd);
    const used = new Set(
      rows
        .filter((row) => pathKey(row.cwd) === pathKey(target.cwd))
        .map((row) => row.name || row.preview || ""),
    );
    let index = 1;
    let name = `${base} · 分叉 ${index}`;
    while (used.has(name)) name = `${base} · 分叉 ${++index}`;
    const result = await client.current!.branch(source, name);
    const identity = sessionIdentity(
      result.thread.view.sessionFile ?? "",
      result.thread.key,
    );
    void setPiAgentSessionOrder((current) => prependOrderId(current, identity));
    setProject(result.thread.cwd);
    activateThread(result.thread.key);
    setRevealThreadKey(result.thread.key);
    await refreshSessions();
  };
  /** 导出明确目标的原生 HTML，由用户选择输出文件路径。 */
  const exportThread = async (target: SidebarThread) => {
    const outputPath = await save({
      title: "导出 Pi 会话",
      defaultPath: "Pi-session.html",
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (!outputPath) return;
    const thread = await ensure(target);
    const result = objectValue(
      await client.current!.request(thread, {
        type: "export_html",
        outputPath,
      }),
    );
    setNotice(`已导出：${result?.path ?? outputPath}`, target.key);
  };
  /** 重命名指定会话并回读名称，不依赖当前选中的会话。 */
  const commitRename = async (target: SidebarThread, name: string) => {
    const thread = await ensure(target);
    await client.current!.rename(thread, name);
    await refreshSessions();
  };
  /** 提交视口标题编辑，复用原生会话改名并同步侧栏。 */
  const commitViewportRename = () => {
    if (!viewportRename) return;
    const { thread, name } = viewportRename;
    setViewportRename(null);
    if (name.trim()) run(commitRename(thread, name.trim()), thread.key);
  };
  const renameThread = async () => {
    if (!rename?.name.trim()) return;
    await commitRename(rename.thread, rename.name.trim());
    setRename(null);
  };
  const request = requests.find((item) => item.key === selected);
  useEffect(() => {
    setAnswer(String(request?.event.prefill ?? ""));
  }, [request?.event.id]);
  /** 将用户对扩展弹窗的回答交回 Pi 原生 UI 子协议。 */
  const respond = async (fields: Record<string, unknown>) => {
    if (!request) return;
    const thread = client.current?.threads.get(request.key);
    if (thread?.runtimeId == null) throw new Error("Pi 会话已结束");
    await sendPiCommand(thread.runtimeId, {
      type: "extension_ui_response",
      id: request.event.id,
      ...fields,
    });
    setRequests((value) => value.filter((item) => item !== request));
  };
  const selectedKey = selected;
  return (
    <section
      data-testid="pi-agent"
      className="pi-agent @container flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground"
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          event.stopPropagation();
          setSearchOpen(true);
        }
      }}
    >
      <header className="flex h-10 shrink-0 items-center border-b border-border px-2">
        <div className="order-3 flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={viewportKeys.length ? "退出多视口" : "多视口"}
            title={viewportKeys.length ? "退出多视口" : "多视口"}
            aria-pressed={!!viewportKeys.length}
            onClick={toggleViewports}
          >
            <HugeiconsIcon icon={GridViewIcon} size={14} />
          </Button>
          {viewportKeys.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              aria-label="增加 Pi 视口"
              title="增加 Pi 视口"
              className="h-6 px-2.5 text-xs font-normal text-foreground"
              onClick={addViewport}
            >
              + {viewportKeys.length}/6
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={sidebarOpen ? "收起线程栏" : "展开线程栏"}
            title={sidebarOpen ? "收起线程栏" : "展开线程栏"}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <HugeiconsIcon icon={LayoutRightIcon} size={16} />
          </Button>
        </div>
        <div
          data-testid="pi-thread-title"
          className="order-1 min-w-0 flex-1 truncate px-3 text-xs font-medium"
        >
          {view.sessionName ||
            rows.find((row) => row.key === selected)?.name ||
            rows.find((row) => row.key === selected)?.preview ||
            (activeCwd ? projectName(activeCwd) : "Pi Agent")}
          {activeCwd ? ` (${projectName(activeCwd)})` : ""}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="order-0"
          title="搜索当前线程"
          aria-label="搜索当前线程按钮"
          onClick={() => setSearchOpen(!searchOpen)}
        >
          <HugeiconsIcon icon={Search01Icon} size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="order-4"
          title="Pi 设置"
          aria-label="Pi 设置"
          onClick={() => setSettingsOpen(true)}
        >
          <HugeiconsIcon icon={Settings01Icon} size={15} />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {sidebarOpen && (
          <PiSidebar
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
            projects={projects}
            threads={rows}
            selectedKey={selected}
            viewportDrop={
              viewportKeys.length
                ? {
                    hover: (x, y) => {
                      const index = viewportAtPoint(x, y);
                      setDropViewport(index);
                      return index !== null;
                    },
                    clear: () => setDropViewport(null),
                    drop: (thread, x, y) => {
                      const index = viewportAtPoint(x, y);
                      if (index === null) return false;
                      run(select(thread, index), thread.key);
                      return true;
                    },
                  }
                : undefined
            }
            revealThreadKey={revealThreadKey}
            selectedProject={activeCwd}
            organization={organization}
            organizationReady={hydrated && sessionsReady}
            onOrganize={(next) => run(setPiAgentOrganization(next))}
            onSelectProject={(cwd) => run(selectProject(cwd))}
            onAddProject={() => run(addProject())}
            onRemoveProject={(path) => run(removeProject(path))}
            onNew={(path) => run(create(path))}
            onSelect={(thread) => run(select(thread), thread.key)}
            onCommitRename={(thread, name) =>
              run(commitRename(thread, name), thread.key)
            }
            onRename={(thread) =>
              setRename({ thread, name: thread.name || thread.preview || "" })
            }
            onFork={(thread) => run(forkThread(thread), thread.key)}
            onExport={(thread) => run(exportThread(thread), thread.key)}
            onClose={setDeleteTarget}
            onCopyPath={(path) => run(writeText(path))}
            projectOrder={projectOrder}
            sessionOrder={sessionOrder}
            onProjectOrder={(order) => run(setPiAgentProjectOrder(order))}
            onSessionOrder={(order) => run(setPiAgentSessionOrder(order))}
            temporaryHome={piHome}
          />
        )}
        <div
          className="order-first grid min-h-0 min-w-0 flex-1 gap-1 overflow-hidden"
          style={{
            gridTemplateColumns: `repeat(${viewportKeys.length > 4 ? 3 : viewportKeys.length > 1 ? 2 : 1}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${viewportKeys.length > 4 ? 2 : viewportKeys.length > 2 ? 2 : 1}, minmax(0, 1fr))`,
          }}
        >
          {(viewportKeys.length ? viewportKeys : [selected]).map(
            (paneKey, paneIndex) => {
              const selected = paneKey;
              const draftKey = paneKey ?? "";
              const activeThread = threads.find(
                (thread) => thread.key === paneKey,
              );
              const view = activeThread?.view ?? INITIAL_PI_VIEW_STATE;
              const activeCwd =
                activeThread?.cwd ??
                rows.find((row) => row.key === paneKey)?.cwd ??
                project;
              const draft = drafts[draftKey] ?? EMPTY_DRAFT;
              const notice = notices[draftKey] ?? "";
              const canEditLastUser =
                !!activeThread &&
                !operations[draftKey] &&
                !!editableLastUser(view);
              /** 将当前视口的异步错误写回对应会话。 */
              const run = (operation: Promise<unknown>, key = draftKey) => {
                void operation.catch((error) => setNotice(String(error), key));
              };
              if (viewportKeys.length && !paneKey)
                return (
                  <div
                    key={`empty-${paneIndex}`}
                    data-pi-viewport-index={paneIndex}
                    className={`flex min-h-0 flex-col rounded-md border border-dashed ${dropViewport === paneIndex ? "border-primary bg-accent/40" : "border-border"}`}
                  >
                    <div className="flex h-7 items-center justify-between px-2 text-[11px] text-muted-foreground">
                      视口 {paneIndex + 1}
                      <button
                        type="button"
                        aria-label={`关闭视口 ${paneIndex + 1}`}
                        onClick={() => closeViewport(paneIndex)}
                      >
                        ×
                      </button>
                    </div>
                    <button
                      type="button"
                      className="min-h-0 flex-1 px-3 text-xs text-muted-foreground"
                      onClick={() => {
                        setActiveViewport(paneIndex);
                        setSelected(null);
                      }}
                    >
                      从右侧拖入会话
                      <br />
                      或点击此处后在侧栏选择
                    </button>
                  </div>
                );
              return (
                <main
                  key={
                    viewportKeys.length
                      ? (paneKey ?? `empty-${paneIndex}`)
                      : "single"
                  }
                  data-pi-viewport-key={paneKey ?? ""}
                  data-pi-viewport-index={
                    viewportKeys.length ? paneIndex : undefined
                  }
                  className={`@container relative flex min-h-0 min-w-0 flex-col overflow-hidden ${viewportKeys.length ? "rounded-md border" : ""} ${dropViewport === paneIndex ? "border-primary ring-2 ring-primary/40" : paneKey === selectedKey ? "border-primary/50" : "border-border"}`}
                  onPointerDownCapture={() => {
                    if (paneKey !== selectedKey) {
                      setActiveViewport(paneIndex);
                      setSelected(paneKey);
                    }
                  }}
                  onFocusCapture={() => {
                    if (paneKey !== selectedKey) {
                      setActiveViewport(paneIndex);
                      setSelected(paneKey);
                    }
                  }}
                >
                  {viewportKeys.length > 0 && (
                    <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border/60 bg-muted/30 px-2 text-[11px]">
                      {viewportRename?.thread.key === paneKey ? (
                        <input
                          autoFocus
                          aria-label="重命名 Pi 视口"
                          className="h-5 min-w-0 flex-1 rounded-sm border border-border bg-background px-1 text-[11px] outline-none focus:border-primary/60"
                          value={viewportRename.name}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) =>
                            setViewportRename({
                              thread: viewportRename.thread,
                              name: event.target.value,
                            })
                          }
                          onBlur={commitViewportRename}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") {
                              event.preventDefault();
                              event.currentTarget.blur();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              setViewportRename(null);
                            }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left"
                          title="双击重命名会话"
                          onDoubleClick={() => {
                            const thread = rows.find(
                              (row) => row.key === paneKey,
                            );
                            if (thread)
                              setViewportRename({
                                thread,
                                name: thread.name || thread.preview || "",
                              });
                          }}
                        >
                          {view.sessionName ||
                            rows.find((row) => row.key === paneKey)?.name ||
                            rows.find((row) => row.key === paneKey)?.preview ||
                            `视口 ${paneIndex + 1}`}
                          {activeCwd ? ` (${projectName(activeCwd)})` : ""}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`关闭视口 ${paneIndex + 1}`}
                        title="关闭视口，任务继续运行"
                        onClick={() => closeViewport(paneIndex)}
                        className="size-5 shrink-0 rounded hover:bg-accent"
                      >
                        ×
                      </button>
                    </div>
                  )}
                  <PiTranscript
                    cwd={activeCwd ?? ""}
                    view={view}
                    sendRevision={sendRevisions[draftKey] ?? 0}
                    loading={activeThread?.loadingHistory ?? false}
                    threadKey={draftKey}
                    active={active}
                    searchOpen={searchOpen && paneKey === selectedKey}
                    onCloseSearch={() => setSearchOpen(false)}
                    onOpenFile={onOpenFile}
                    onCopy={(text) => run(writeText(text))}
                    onEdit={async (item, text) => {
                      if (!activeThread) throw new Error("当前没有活动线程");
                      try {
                        return await editLastUser(activeThread, item, text);
                      } catch (error) {
                        setNotice(String(error), activeThread.key);
                        throw error;
                      }
                    }}
                    onFork={() => {
                      const target = rows.find((row) => row.key === selected);
                      if (target) run(forkThread(target), target.key);
                    }}
                    canEditLastUser={canEditLastUser}
                    onLoadOlder={() => {
                      if (activeThread)
                        run(
                          client.current!.loadOlderHistory(activeThread),
                          activeThread.key,
                        );
                    }}
                  />
                  <PiComposer
                    key={draftKey}
                    threadKey={draftKey}
                    focused={paneKey === selectedKey}
                    draft={draft}
                    onChange={(value) =>
                      setDrafts((current) => ({
                        ...current,
                        [draftKey]: value,
                      }))
                    }
                    view={view}
                    notice={plainStatusText(
                      notice ||
                        view.error ||
                        (probe?.available === false
                          ? (probe.error ?? "Pi 不可用")
                          : ""),
                    )}
                    onDismissNotice={() => {
                      setNotice("", draftKey);
                      if (activeThread)
                        client.current?.error(activeThread.key, "");
                    }}
                    status={
                      operations[draftKey] ||
                      Object.values(
                        extensionStatus[activeThread?.key ?? draftKey] ?? {},
                      )
                        .map(plainStatusText)
                        .filter(Boolean)
                        .join(" · ")
                    }
                    onLoadModels={() =>
                      run(
                        (async () => {
                          const models =
                            await client.current!.loadCatalog(true);
                          setCatalog(models);
                          const thread = await ensure(
                            rows.find((row) => row.key === selected),
                            selected,
                          );
                          await client.current!.loadModels(thread, true);
                        })(),
                      )
                    }
                    onLoadCommands={async () => {
                      const thread = await ensure(
                        rows.find((row) => row.key === selected),
                        selected,
                      );
                      await client.current!.loadCommands(thread);
                    }}
                    onSend={(behavior) =>
                      run(submit(behavior, paneKey), draftKey)
                    }
                    onLocalQueueAction={(id, action) => {
                      if (!activeThread) return;
                      const item = client.current!.removeQueued(
                        activeThread,
                        id,
                      );
                      if (item && action === "edit") {
                        setDrafts((value) => {
                          const current = value[draftKey] ?? EMPTY_DRAFT;
                          return {
                            ...value,
                            [draftKey]: {
                              text: [item.text, current.text]
                                .filter(Boolean)
                                .join("\n\n"),
                              images: [...item.images, ...current.images],
                              files: current.files,
                            },
                          };
                        });
                        setFocusRevisions((value) => ({
                          ...value,
                          [draftKey]: (value[draftKey] ?? 0) + 1,
                        }));
                      }
                    }}
                    onRetryQueue={() => {
                      if (activeThread)
                        run(
                          client.current!.drainQueue(activeThread),
                          activeThread.key,
                        );
                    }}
                    onQueueAction={(kind, index, text, action) => {
                      if (!activeThread) return;
                      const thread = activeThread;
                      const label =
                        action === "steer"
                          ? "正在安排为下一步…"
                          : action === "edit"
                            ? "正在退回输入框…"
                            : "正在删除排队消息…";
                      run(
                        operate(thread, label, () =>
                          client.current!.updateQueuedMessage(
                            thread,
                            kind,
                            index,
                            text,
                            action,
                            (texts) => {
                              setDrafts((value) => {
                                const current =
                                  value[thread.key] ?? EMPTY_DRAFT;
                                return {
                                  ...value,
                                  [thread.key]: {
                                    ...current,
                                    text: [...texts, current.text]
                                      .filter(Boolean)
                                      .join("\n\n"),
                                  },
                                };
                              });
                              setFocusRevisions((value) => ({
                                ...value,
                                [thread.key]: (value[thread.key] ?? 0) + 1,
                              }));
                            },
                          ),
                        ),
                        thread.key,
                      );
                    }}
                    onStop={() => {
                      if (activeThread) run(stopThread(activeThread), draftKey);
                    }}
                    onModel={(provider, modelId) =>
                      run(
                        ensure(
                          rows.find((row) => row.key === selected),
                          selected,
                        ).then(async (thread) => {
                          const name = (
                            view.models.length ? view.models : catalog
                          ).find(
                            (model) =>
                              model.provider === provider &&
                              model.id === modelId,
                          )?.name;
                          await client.current!.setModel(
                            thread,
                            provider,
                            modelId,
                            name,
                          );
                          await setPiAgentLastModel({
                            provider,
                            id: modelId,
                            name,
                          });
                        }),
                      )
                    }
                    onThinking={(level) =>
                      run(
                        ensure(
                          rows.find((row) => row.key === selected),
                          selected,
                        ).then(async (thread) => {
                          await client.current!.setThinkingLevel(thread, level);
                          await setPiAgentLastThinkingLevel(level);
                        }),
                      )
                    }
                    onSettings={() => setSettingsOpen(true)}
                    onError={(error) => setNotice(String(error), draftKey)}
                    busy={
                      pending.has(draftKey) ||
                      !!operations[draftKey] ||
                      view.status === "starting"
                    }
                    focusRevision={focusRevisions[draftKey] ?? 0}
                    disabled={
                      (!activeCwd && !piHome) || probe?.available === false
                    }
                    project={activeCwd ?? piHome ?? ""}
                    catalogModel={lastModel}
                    catalogModels={catalog}
                  />
                </main>
              );
            },
          )}
        </div>
      </div>
      <PiSettings
        open={settingsOpen && active}
        onClose={() => setSettingsOpen(false)}
        onModelsChanged={() => {
          void client.current
            ?.reloadCatalog()
            .then((models) => setCatalog(models))
            .catch((error) => {
              setNotice(String(error));
            });
        }}
      />
      <Dialog
        open={!!deleteTarget && active}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogTitle>彻底删除线程？</DialogTitle>
          <DialogDescription>
            将停止此线程并永久删除其会话文件，无法恢复。项目文件及其他线程保留。
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={deleting}
              onClick={() => setDeleteTarget(null)}
            >
              取消
            </Button>
            <Button
              disabled={deleting}
              onClick={() => run(deleteThread(), deleteTarget?.key)}
            >
              {deleting ? "删除中…" : "彻底删除"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!rename && active}
        onOpenChange={(value) => {
          if (!value) setRename(null);
        }}
      >
        <DialogContent className="rounded-2xl" showCloseButton={false}>
          <DialogTitle>重命名线程</DialogTitle>
          <DialogDescription>保存到该线程的 Pi 原生会话。</DialogDescription>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              run(renameThread(), rename?.thread.key);
            }}
          >
            <Input
              aria-label="线程名称"
              autoFocus
              value={rename?.name ?? ""}
              onChange={(event) =>
                setRename((value) =>
                  value ? { ...value, name: event.target.value } : null,
                )
              }
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRename(null)}
              >
                取消
              </Button>
              <Button type="submit" disabled={!rename?.name.trim()}>
                保存
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!request && active}
        onOpenChange={(value) => {
          if (!value) run(respond({ cancelled: true }));
        }}
      >
        <DialogContent
          className="max-h-[80vh] overflow-auto rounded-2xl"
          showCloseButton={false}
        >
          <DialogTitle>
            {String(request?.event.title ?? "Pi 需要你的输入")}
          </DialogTitle>
          <DialogDescription>
            {String(request?.event.message ?? "此请求来自当前 Pi 扩展。")}
          </DialogDescription>
          {request?.event.method === "select" ? (
            <div className="space-y-1">
              {(Array.isArray(request.event.options)
                ? request.event.options
                : []
              ).map((option, index) => (
                <Button
                  key={index}
                  variant="outline"
                  className="h-auto w-full justify-start whitespace-normal rounded-lg py-2"
                  onClick={() => run(respond({ value: option }))}
                >
                  {String(option)}
                </Button>
              ))}
            </div>
          ) : (
            request?.event.method !== "confirm" && (
              <Textarea
                aria-label="扩展输入"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
              />
            )
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => run(respond({ cancelled: true }))}
            >
              取消
            </Button>
            {request?.event.method !== "select" && (
              <Button
                onClick={() =>
                  run(
                    respond(
                      request?.event.method === "confirm"
                        ? { confirmed: true }
                        : { value: answer },
                    ),
                  )
                }
              >
                确认
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
