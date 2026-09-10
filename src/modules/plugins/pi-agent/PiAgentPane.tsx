import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Search01Icon,
  Settings01Icon,
  LayoutRightIcon,
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
} from "../store";
import { PiWorkspaceClient, type PiThread } from "./client";
import { INITIAL_PI_VIEW_STATE, objectValue } from "./reducer";
import {
  listAllPiSessions,
  probePiAgent,
  sendPiCommand,
  deletePiSession,
} from "./native";
import { collectProjects, pathKey, projectName } from "./organization";
import { PiSidebar, type SidebarThread } from "./PiSidebar";
import { PiComposer, EMPTY_DRAFT, type PiDraft } from "./PiComposer";
import { PiTranscript } from "./PiTranscript";
import { PiSettings } from "./PiSettings";
import { plainStatusText } from "./statusText";
import type { PiMessageItem, PiSessionSummary } from "./types";
import { localCommand } from "./commands";
import "./pi-agent.css";

type ExtensionRequest = { key: string; event: Record<string, unknown> };

/** 插件入口只协调原生会话与 Codev 组件，不接管外部文件树或终端。 */
export function PiAgentPane({
  cwd,
  active,
}: {
  cwd: string | null;
  active: boolean;
}) {
  const [initialized, setInitialized] = useState(false);
  const client = useRef<PiWorkspaceClient | null>(null);
  const activeRef = useRef(active);
  const [threads, setThreads] = useState<PiThread[]>([]);
  useEffect(() => {
    activeRef.current = active;
    if (active && client.current)
      setThreads(
        [...client.current.threads.values()].map((thread) => ({ ...thread })),
      );
  }, [active]);
  const [sessions, setSessions] = useState<PiSessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(cwd);
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
  const [rename, setRename] = useState<{
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
  const activeThread = threads.find(
    (thread) => thread.key === (selected ?? `draft:${project ?? cwd ?? ""}`),
  );
  const view = activeThread?.view ?? INITIAL_PI_VIEW_STATE;
  const activeCwd = activeThread?.cwd ?? project ?? cwd;
  const draftKey = selected ?? `draft:${activeCwd ?? ""}`;
  const draft = drafts[draftKey] ?? EMPTY_DRAFT;
  const notice = notices[draftKey] ?? "";
  /** 将提示绑定到操作发起时的线程，异步返回不污染后来选中的线程。 */
  const setNotice = (message: string, key = draftKey) =>
    setNotices((current) => ({ ...current, [key]: message }));
  const projects = useMemo(
    () =>
      collectProjects(
        [
          ...(cwd ? [cwd] : []),
          ...pluginProjects,
          ...threads.map((item) => item.cwd),
        ],
        sessions,
        hiddenProjects,
      ),
    [cwd, pluginProjects, threads, sessions, hiddenProjects],
  );
  /** 刷新原生会话目录，只在首次激活和显式文件操作后执行。 */
  const refreshSessions = useCallback(async () => {
    setSessions(await listAllPiSessions());
  }, []);
  useEffect(() => {
    if (!active) return;
    setInitialized(true);
  }, [active]);
  useEffect(() => {
    if (!initialized) return;
    let disposed = false;
    const runtime = new PiWorkspaceClient(
      () => {
        if (!disposed && activeRef.current)
          setThreads(
            [...runtime.threads.values()].map((thread) => ({ ...thread })),
          );
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
        if (event.method === "notify")
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
    void refreshSessions().catch((error) => {
      if (!disposed) setNotice(String(error));
    });
    return () => {
      disposed = true;
      runtime.dispose();
      if (client.current === runtime) client.current = null;
    };
  }, [initialized, refreshSessions]);
  useEffect(() => {
    if (!project && cwd) setProject(cwd);
  }, [cwd, project]);
  useEffect(() => {
    if (!initialized || !active || !activeCwd || selected || !client.current)
      return;
    const key = `draft:${activeCwd}`;
    void client.current
      .open(key, activeCwd)
      .catch((error) => setNotice(String(error), key));
  }, [initialized, active, activeCwd, selected]);
  const rows = useMemo<SidebarThread[]>(() => {
    const result: SidebarThread[] = sessions.map((session) => ({
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
        path,
        key: thread.key,
        cwd: thread.cwd,
        name: thread.view.sessionName ?? old?.name ?? null,
        preview:
          old?.preview ??
          (first && first.kind === "message" ? first.text.slice(0, 80) : null),
        createdAt: old?.createdAt ?? "",
        updatedAt: old?.updatedAt ?? Date.now(),
        messageCount: thread.view.items.length,
        status: thread.view.status,
        waiting: requests.some((request) => request.key === thread.key),
      };
      if (index >= 0) result[index] = row;
      else result.unshift(row);
    }
    return result;
  }, [sessions, threads, requests]);
  /** 用统一提示处理操作异常，避免无响应按钮。 */
  const run = (operation: Promise<unknown>, key = draftKey) => {
    void operation.catch((error) => setNotice(String(error), key));
  };
  /** 获取指定会话的进程，操作始终指向右键目标。 */
  const ensure = async (thread?: SidebarThread): Promise<PiThread> => {
    const runtime = client.current;
    const targetCwd = thread?.cwd ?? activeCwd;
    if (!runtime || !targetCwd) throw new Error("请先添加项目，等待 Pi 初始化");
    return runtime.open(
      thread?.key ?? selected ?? draftKey,
      targetCwd,
      thread?.path || undefined,
    );
  };
  /** 新线程建立后绑定该项目，其他线程的进程继续运行。 */
  const create = async (path: string) => {
    const key = crypto.randomUUID();
    setProject(path);
    setSelected(key);
    setSearchOpen(false);
    if (!client.current) throw new Error("Pi 尚未就绪");
    try {
      await client.current.open(key, path);
    } catch (error) {
      setNotice(String(error), key);
    }
  };
  /** 选择已有线程，恢复时保留另一线程的草稿与运行状态。 */
  const select = async (thread: SidebarThread) => {
    setProject(thread.cwd);
    setSelected(thread.key);
    setSearchOpen(false);
    await ensure(thread);
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
    setProject(result);
    setSelected(null);
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
      setSelected(null);
    }
  };
  /** 待 Pi 确认接受后清除当前草稿，失败时原输入仍可编辑重发。 */
  const submit = async (behavior: "steer" | "followUp") => {
    if (operationKeys.current.has(draftKey)) return;
    const command = localCommand(draft.text);
    if (command) {
      if (draft.images.length) throw new Error("请先移除附件再执行会话命令");
      const thread = await ensure(rows.find((row) => row.key === selected));
      if (command.name === "fork") await cloneThread(thread);
      else
        await operate(thread, "正在压缩上下文…", async () => {
          if (thread.view.status !== "idle")
            throw new Error("请先停止当前任务再压缩上下文");
          await client.current!.request(thread, {
            type: "compact",
            ...(command.argument
              ? { customInstructions: command.argument }
              : {}),
          });
          await client.current!.request(thread, { type: "get_messages" });
          await client.current!.refreshState(thread);
        });
      setDrafts((value) => ({
        ...value,
        [draftKey]: value[draftKey] === draft ? EMPTY_DRAFT : value[draftKey],
      }));
      return;
    }
    if (pending.has(draftKey) || (!draft.text.trim() && !draft.images.length))
      return;
    const sourceKey = draftKey;
    let runtimeKey = sourceKey;
    setPending((value) => new Set([...value, sourceKey]));
    try {
      const thread = await ensure(rows.find((row) => row.key === selected));
      runtimeKey = thread.key;
      setPending((value) => new Set([...value, runtimeKey]));
      setSelected((current) => (current === selected ? thread.key : current));
      setDrafts((value) => ({
        ...value,
        [thread.key]: value[sourceKey] ?? draft,
      }));
      setNotice("", thread.key);
      setSendRevisions((value) => ({
        ...value,
        [thread.key]: (value[thread.key] ?? 0) + 1,
      }));
      await client.current!.request(thread, {
        type: "prompt",
        message: draft.text,
        ...(draft.images.length ? { images: draft.images } : {}),
        ...(thread.view.status === "running"
          ? { streamingBehavior: behavior }
          : {}),
      });
      setDrafts((value) => ({
        ...value,
        [sourceKey]:
          value[sourceKey] === draft ? EMPTY_DRAFT : value[sourceKey],
        [thread.key]:
          value[thread.key] === draft ? EMPTY_DRAFT : value[thread.key],
      }));
      await client.current!.refreshState(thread);
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
  /** 停止时取回排队内容；编辑最后输入时将原文与附件放回输入框。 */
  const stopEditing = async (thread: PiThread, item?: PiMessageItem) => {
    await operate(thread, "正在停止…", async () => {
      const key = thread.key;
      /** 保留停止期间输入的新草稿，并恢复取回的文字和附件。 */
      const restore = (texts: string[]) => {
        setDrafts((value) => {
          const current = value[key] ?? EMPTY_DRAFT;
          return {
            ...value,
            [key]: {
              text: [item?.text, ...texts, current.text]
                .filter(Boolean)
                .join("\n\n"),
              images: [...(item?.images ?? []), ...current.images],
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
      else restore([]);
    });
  };
  /** 分叉和克隆完成后选中新会话，原会话继续保留在侧栏中。 */
  const cloneThread = async (thread: PiThread) => {
    await operate(thread, "正在创建分叉…", async () => {
      const oldKey = thread.key;
      const row = rows.find((row) => row.key === oldKey);
      const base = (
        thread.view.sessionName ||
        row?.name ||
        row?.preview ||
        "新线程"
      ).replace(/ · 分叉 \d+$/, "");
      const names = new Set(rows.map((row) => row.name));
      let suffix = 1;
      while (names.has(`${base} · 分叉 ${suffix}`)) suffix++;
      const result = await client.current!.branch(thread);
      if (!result) throw new Error("Pi 扩展取消了本次操作");
      await client.current!.request(result.thread, {
        type: "set_session_name",
        name: `${base} · 分叉 ${suffix}`,
      });
      await client.current!.refreshState(result.thread);
      setDrafts((value) => ({
        ...value,
        [result.thread.key]: { text: result.text, images: [] },
      }));
      setSelected(result.thread.key);
      setProject(result.thread.cwd);
      await refreshSessions();
    });
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
      if (selected && keys.has(selected)) setSelected(null);
      await setPiAgentOrganization({
        ...organization,
        archived: organization.archived.filter(
          (path) => pathKey(path) !== pathKey(target.path),
        ),
      });
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };
  /** 模型和思考设置发送到原生 Pi，成功后读取实际状态。 */
  const configure = async (command: Record<string, unknown>) => {
    const thread = await ensure(rows.find((row) => row.key === selected));
    setSelected(thread.key);
    await client.current!.request(thread, command);
    await Promise.all([
      client.current!.refreshState(thread),
      client.current!.request(thread, {
        type: "get_available_thinking_levels",
      }),
    ]);
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
  const renameThread = async () => {
    if (!rename?.name.trim()) return;
    const thread = await ensure(rename.thread);
    await client.current!.request(thread, {
      type: "set_session_name",
      name: rename.name.trim(),
    });
    await client.current!.refreshState(thread);
    setRename(null);
    await refreshSessions();
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
        <div
          className="shrink-0"
        >
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
            rows.find((row) => row.key === selected)?.preview ||
            (activeCwd ? projectName(activeCwd) : "Pi Agent")}
        </div>
        {view.status === "running" && (
          <span className="order-2 truncate text-[11px] text-[#8eacc9]">
            {view.phase || "运行中"}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          title="搜索当前线程"
          aria-label="搜索当前线程按钮"
          onClick={() => setSearchOpen(!searchOpen)}
        >
          <HugeiconsIcon icon={Search01Icon} size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
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
            selectedProject={activeCwd}
            organization={organization}
            onOrganize={(next) => run(setPiAgentOrganization(next))}
            onAddProject={() => run(addProject())}
            onRemoveProject={(path) => run(removeProject(path))}
            onNew={(path) => run(create(path))}
            onSelect={(thread) => run(select(thread), thread.key)}
            onRename={(thread) =>
              setRename({ thread, name: thread.name || thread.preview || "" })
            }
            onExport={(thread) => run(exportThread(thread), thread.key)}
            onClose={setDeleteTarget}
            onCopyPath={(path) => run(writeText(path))}
            onClone={(target) =>
              run(
                ensure(target).then((thread) => cloneThread(thread)),
                target.key,
              )
            }
          />
        )}
        <main className="relative order-first flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <PiTranscript
            view={view}
            sendRevision={sendRevisions[draftKey] ?? 0}
            loading={activeThread?.loadingHistory ?? false}
            threadKey={draftKey}
            active={active}
            searchOpen={searchOpen}
            onCloseSearch={() => setSearchOpen(false)}
            onCopy={(text) => run(writeText(text))}
            onEdit={(item) => {
              if (activeThread) run(stopEditing(activeThread, item));
            }}
            onFork={() => {
              if (activeThread) run(cloneThread(activeThread));
            }}
          />
          <PiComposer
            key={draftKey}
            draft={draft}
            onChange={(value) =>
              setDrafts((current) => ({ ...current, [draftKey]: value }))
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
              setNotice("");
              if (activeThread) client.current?.error(activeThread.key, "");
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
            onLoadModels={() => {
              if (!view.models.length && activeCwd)
                run(ensure().then(() => undefined));
            }}
            onSend={(behavior) => run(submit(behavior))}
            onStop={() => {
              if (activeThread) run(stopEditing(activeThread));
            }}
            onModel={(provider, modelId) =>
              run(configure({ type: "set_model", provider, modelId }))
            }
            onThinking={(level) =>
              run(configure({ type: "set_thinking_level", level }))
            }
            onSettings={() => setSettingsOpen(true)}
            onError={(error) => setNotice(String(error))}
            busy={
              pending.has(draftKey) ||
              !!operations[draftKey] ||
              view.status === "starting"
            }
            focusRevision={focusRevisions[draftKey] ?? 0}
            disabled={!activeCwd || probe?.available === false}
            project={activeCwd ?? ""}
          />
        </main>
      </div>
      <PiSettings
        open={settingsOpen && active}
        onClose={() => setSettingsOpen(false)}
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
