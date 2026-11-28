import { create } from "zustand";
import { agentClient, type ConnectionOptions } from "./client";
import { emitHostEvent } from "./hostEvents";
import {
  isBusy,
  type AgentImage,
  type AgentMessage,
  type Frame,
  type Harness,
  type HostSnapshot,
  type SessionSummary,
  type SessionView,
  type Workspace,
} from "./types";
import {
  markTaskRead,
  markUnreadTask,
} from "@/modules/plugins/taskbar-unread/unreadTasks";

import type { PiPathAttachment } from "./attachments";

export type Draft = {
  text: string;
  images: AgentImage[];
  files?: PiPathAttachment[];
  localCommand?: "compact" | "fork" | null;
};
type State = {
  connection: string;
  error: string;
  serverId: string | null;
  mobile: boolean;
  workspaces: Workspace[];
  sessions: Record<string, SessionSummary>;
  views: Record<string, SessionView>;
  harnesses: Harness[];
  selected: string | null;
  workspaceId: string | null;
  harnessId: string;
  slots: Array<string | null>;
  activeViewport: number;
  opened: string[];
  drafts: Record<string, Draft>;
  sendRevisions: Record<string, number>;
  temporarySessions: string[];
  projectHarnesses: Record<string, string[]>;
  unread: string[];
  initDesktop: () => Promise<void>;
  connectRemote: (options: ConnectionOptions) => void;
  select: (id: string, viewport?: number) => Promise<void>;
  createSession: (workspaceId?: string, harnessId?: string) => Promise<void>;
  setProjectHarnesses: (
    workspaceId: string,
    harnessIds: string[],
  ) => Promise<void>;
  addWorkspace: (cwd: string) => Promise<void>;
  setWorkspace: (id: string) => void;
  setHarness: (id: string) => void;
  setDraft: (id: string, draft: Partial<Draft>) => void;
  bumpSend: (id: string) => void;
  setSlots: (slots: Array<string | null>) => void;
  focusViewport: (index: number) => void;
  command: <T = unknown>(
    operation: string,
    payload?: unknown,
    id?: string,
  ) => Promise<T>;
  report: (error: unknown) => void;
};
let desktopInit: Promise<void> | null = null;
let stopReady: (() => void) | null = null;
const readLocal = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const saveLocal = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* optional UI persistence */
  }
};

function readStored<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(readLocal(key) ?? "") as T;
  } catch {
    return fallback;
  }
}

function discardEmptySession(
  id: string | null,
  remainingSlots: Array<string | null>,
) {
  if (!id || remainingSlots.includes(id)) return;
  const state = useAgentStore.getState();
  const draft = state.drafts[id];
  const view = state.views[id];
  if (
    !state.temporarySessions.includes(id) ||
    state.mobile ||
    draft?.text.trim() ||
    draft?.images.length ||
    draft?.files?.length ||
    view?.messages.some((message) => message.role === "user") ||
    isBusy(view)
  )
    return;
  void state
    .command("session.discard_empty", {}, id)
    .then(() => {
      const current = useAgentStore.getState();
      const temporarySessions = current.temporarySessions.filter(
        (item) => item !== id,
      );
      saveLocal(
        "codev.agent.temporarySessions",
        JSON.stringify(temporarySessions),
      );
      useAgentStore.setState({ temporarySessions });
    })
    .catch(state.report);
}

export function shareMessage(
  previous: AgentMessage | undefined,
  next: AgentMessage,
): AgentMessage {
  return previous &&
    previous.text === next.text &&
    previous.thinking === next.thinking &&
    previous.status === next.status &&
    previous.streaming === next.streaming &&
    previous.toolName === next.toolName &&
    previous.toolKind === next.toolKind &&
    previous.isError === next.isError &&
    previous.sourceEventId === next.sourceEventId &&
    previous.kind === next.kind &&
    JSON.stringify(previous.arguments) === JSON.stringify(next.arguments) &&
    JSON.stringify(previous.diff) === JSON.stringify(next.diff) &&
    JSON.stringify(previous.locations) === JSON.stringify(next.locations) &&
    JSON.stringify(previous.images) === JSON.stringify(next.images)
    ? previous
    : next;
}
export function mergeView(
  previous: SessionView | undefined,
  incoming: SessionView,
): SessionView {
  if (!previous) return incoming;
  const old = new Map(previous.messages.map((m) => [m.id, m]));
  if (
    previous.instanceId === incoming.instanceId &&
    (previous.revision ?? 0) > (incoming.revision ?? 0)
  ) {
    const fill = new Map(incoming.messages.map((m) => [m.id, m]));
    return {
      ...previous,
      messages: (previous._messageOrder ?? previous.messages.map((m) => m.id))
        .map((id) => old.get(id) ?? fill.get(id))
        .filter((m): m is AgentMessage => !!m),
    };
  }
  return {
    ...incoming,
    messages: incoming.messages.map((m) => shareMessage(old.get(m.id), m)),
  };
}
function storeView(incoming: SessionView) {
  useAgentStore.setState((state) => {
    const view = mergeView(state.views[incoming.id], incoming);
    return {
      views: { ...state.views, [view.id]: view },
      sessions: { ...state.sessions, [view.id]: view },
    };
  });
}
async function openSession(id: string) {
  const view = await agentClient.request<SessionView>("session.open", {}, id);
  storeView(view);
  if (view.readOnly || view.instanceId) return;
  try {
    const connected = await agentClient.request<SessionView>(
      "session.connect",
      {},
      id,
    );
    storeView(connected);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useAgentStore.setState((state) => ({
      views: { ...state.views, [id]: { ...state.views[id], error: message } },
      sessions: {
        ...state.sessions,
        [id]: { ...state.sessions[id], error: message },
      },
    }));
  }
}
export function focusAgentSession(id: string) {
  const state = useAgentStore.getState();
  markTaskRead(`agent:${id}`);
  saveLocal("codev.agent.selected", id);
  useAgentStore.setState({
    selected: id,
    activeViewport: Math.max(0, state.slots.indexOf(id)),
    workspaceId: state.sessions[id]?.workspaceId ?? state.workspaceId,
    unread: state.unread.filter((v) => v !== id),
  });
}
export function consumeFrameForTest(frame: Frame) {
  consume(frame);
}
function restore(snapshot: HostSnapshot) {
  const previous = useAgentStore.getState();
  const sessions = Object.fromEntries(
    snapshot.sessions.map((session) => [session.id, session]),
  );
  const sameHost = previous.serverId === snapshot.serverId;
  const views = Object.fromEntries(
    Object.entries(previous.views).filter(
      ([id, view]) => sameHost && sessions[id]?.instanceId === view.instanceId,
    ),
  );
  const saved = readLocal("codev.agent.selected");
  const preferred =
    previous.selected && sessions[previous.selected]
      ? previous.selected
      : saved && sessions[saved]
        ? saved
        : null;
  let savedSlots: Array<string | null> | null = null;
  if (!previous.slots.some(Boolean)) {
    try {
      const raw = readLocal("codev.agent.slots");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          savedSlots = parsed
            .slice(0, 6)
            .map((id) => (typeof id === "string" && sessions[id] ? id : null));
        }
      }
    } catch {
      savedSlots = null;
    }
  }
  const baseSlots = (savedSlots ?? previous.slots).map((id) =>
    id && sessions[id] ? id : null,
  );
  const nextSlots = baseSlots.length ? baseSlots : [null];
  if (preferred && !nextSlots.some(Boolean) && nextSlots.length === 1)
    nextSlots[0] = preferred;
  const preserveEmptyFocus =
    sameHost &&
    previous.selected === null &&
    nextSlots[previous.activeViewport] === null;
  const selected = preserveEmptyFocus
    ? null
    : preferred && nextSlots.includes(preferred)
      ? preferred
      : (nextSlots.find(Boolean) ?? null);
  const nextOpened = [
    ...new Set([
      ...previous.opened.filter((id) => !!sessions[id]),
      ...nextSlots.filter((id): id is string => !!id),
    ]),
  ];
  const workspaceId =
    previous.workspaceId &&
    snapshot.workspaces.some((w) => w.id === previous.workspaceId)
      ? previous.workspaceId
      : ((selected
          ? sessions[selected]?.workspaceId
          : snapshot.workspaces[0]?.id) ?? null);
  useAgentStore.setState({
    serverId: snapshot.serverId,
    workspaces: snapshot.workspaces,
    sessions,
    views,
    harnesses: snapshot.harnesses,
    selected,
    workspaceId,
    slots: nextSlots,
    activeViewport: preserveEmptyFocus
      ? previous.activeViewport
      : Math.max(0, nextSlots.indexOf(selected)),
    opened: nextOpened,
  });
  if (snapshot.vcsSnapshots?.length || snapshot.forgeInboxes?.length) {
    emitHostEvent("host.snapshot", {
      vcsSnapshots: snapshot.vcsSnapshots,
      forgeInboxes: snapshot.forgeInboxes,
    });
  }
}
function consume(frame: Frame) {
  if (frame.type === "snapshot" || frame.type === "resync") {
    restore(frame.snapshot);
    return;
  }
  if (frame.type !== "event") return;
  const event = frame.event;
  if (event.kind === "vcs.changed") {
    const snap = (
      event.payload as { snapshot?: import("@/modules/vcs/types").VcsSnapshot }
    )?.snapshot;
    if (snap) {
      emitHostEvent("vcs.changed", { snapshot: snap });
    }
    return;
  }
  if (event.kind === "forge.updated") {
    const inbox = (
      event.payload as {
        inbox?: import("@/modules/vcs/types").ForgeInboxSnapshot;
      }
    )?.inbox;
    if (inbox) {
      emitHostEvent("forge.updated", { inbox });
    }
    return;
  }
  if (event.kind === "host.changed") {
    const value = event.payload as Pick<
      HostSnapshot,
      "workspaces" | "sessions" | "harnesses"
    >;
    useAgentStore.setState((s) => {
      const nextSessions = Object.fromEntries(
        value.sessions.map((v) => {
          const prevSummary = s.sessions[v.id];
          const prevView = s.views[v.id];
          const merged = prevSummary ? { ...prevSummary, ...v } : v;
          if (
            prevView &&
            prevView.instanceId === v.instanceId &&
            (prevView.revision ?? 0) > (v.revision ?? 0)
          ) {
            return [
              v.id,
              {
                ...merged,
                state: prevView.state,
                revision: prevView.revision,
              },
            ];
          }
          return [v.id, merged];
        }),
      );
      const nextViews = Object.fromEntries(
        Object.entries(s.views).filter(([id]) => !!nextSessions[id]),
      );
      const nextSlots = s.slots.map((id) =>
        id && nextSessions[id] ? id : null,
      );
      return {
        workspaces: value.workspaces,
        harnesses: value.harnesses,
        sessions: nextSessions,
        views: nextViews,
        slots: nextSlots,
        opened: s.opened.filter((id) => !!nextSessions[id]),
        selected: s.selected && nextSessions[s.selected] ? s.selected : null,
        workspaceId:
          s.workspaceId && value.workspaces.some((w) => w.id === s.workspaceId)
            ? s.workspaceId
            : (value.workspaces[0]?.id ?? null),
      };
    });
    return;
  }
  if (event.kind !== "session.patch" && event.kind !== "session.summary")
    return;
  const state = useAgentStore.getState();
  let view: SessionView;
  if (event.kind === "session.patch") {
    const patch = event.payload as {
      view: SessionView;
      messageUpserts: AgentMessage[];
      messageOrder: string[];
    };
    const previous = state.views[patch.view.id];
    if (
      previous?.instanceId === patch.view.instanceId &&
      (previous?.revision ?? 0) > (patch.view.revision ?? 0)
    )
      return;
    const messages = new Map(previous?.messages.map((m) => [m.id, m]) ?? []);
    for (const message of patch.messageUpserts)
      messages.set(message.id, shareMessage(messages.get(message.id), message));
    view = {
      ...patch.view,
      _messageOrder: patch.messageOrder,
      messages: patch.messageOrder
        .map((id) => messages.get(id))
        .filter((m): m is AgentMessage => !!m),
    };
  } else view = event.payload as SessionView;
  const previous = state.sessions[view.id];
  if (view.archived) {
    markTaskRead(`agent:${view.id}`);
    if (state.unread.includes(view.id)) {
      useAgentStore.setState({
        unread: state.unread.filter((v) => v !== view.id),
      });
    }
  } else if (
    previous &&
    isBusy(previous) &&
    (view.state === "idle" || view.state === "crashed")
  ) {
    if (state.selected !== view.id || document.hidden) {
      markUnreadTask(`agent:${view.id}`);
      useAgentStore.setState({
        unread: [...new Set([...state.unread, view.id])],
      });
    }
    if (!state.mobile && previous.state !== "compacting") {
      const workspaceTitle = state.workspaces.find(
        (w) => w.id === view.workspaceId,
      )?.title;
      const lastAssistant = [...view.messages]
        .reverse()
        .find(
          (m) => m.role === "assistant" && m.kind === "message" && !!m.text,
        );
      void import("./notify")
        .then((m) =>
          m.notifyAgentTurnFinished({
            sessionTitle: view.title,
            workspaceTitle,
            failed: view.state === "crashed" || !!view.error,
            preview: lastAssistant?.text.slice(0, 120),
          }),
        )
        .catch(() => undefined);
    }
    if (
      !state.mobile &&
      event.kind === "session.patch" &&
      !view.error &&
      previous.state !== "compacting"
    ) {
      const message = [...view.messages]
        .reverse()
        .find(
          (m) => m.role === "assistant" && m.kind === "message" && !!m.text,
        );
      if (message)
        void import("@/modules/voice/output")
          .then((module) =>
            module.speakFinalIfEnabled(
              message.text,
              `${state.serverId}:${view.id}:${message.id}`,
            ),
          )
          .catch((e) => console.warn("Agent 语音输出不可用", e));
    }
  }
  useAgentStore.setState((s) => ({
    sessions: { ...s.sessions, [view.id]: view },
    ...(event.kind === "session.patch"
      ? { views: { ...s.views, [view.id]: view } }
      : {}),
  }));
}
function establish(options: ConnectionOptions, mobile: boolean) {
  useAgentStore.setState({ mobile, error: "" });
  stopReady?.();
  let initialReady = true;
  stopReady = agentClient.onReady(() => {
    const state = useAgentStore.getState();
    if (!mobile) {
      void agentClient
        .request<Record<string, string[]> | null>("host.project_harnesses.get")
        .then(async (projectHarnesses) => {
          if (projectHarnesses === null) {
            const legacy = readStored<Record<string, string[]>>(
              "codev.agent.projectHarnesses",
              {},
            );
            const available = new Set(state.harnesses.map((item) => item.id));
            for (const workspace of state.workspaces) {
              if (!Array.isArray(legacy[workspace.id])) continue;
              const harnessIds = legacy[workspace.id].filter((id) =>
                available.has(id),
              );
              await agentClient.request("host.project_harnesses.set", {
                workspaceId: workspace.id,
                harnessIds,
              });
            }
            projectHarnesses = await agentClient.request<Record<
              string,
              string[]
            > | null>("host.project_harnesses.get");
          }
          useAgentStore.setState({ projectHarnesses: projectHarnesses ?? {} });
        })
        .catch(state.report);
    }
    if (initialReady && !mobile) {
      for (const id of state.temporarySessions) {
        if (!state.sessions[id]) continue;
        void agentClient
          .request<SessionView>("session.open", {}, id)
          .then((view) => {
            storeView(view);
            discardEmptySession(id, []);
          })
          .catch(state.report);
      }
    }
    initialReady = false;
    for (const id of new Set([
      ...state.slots.filter((id): id is string => !!id),
      ...(state.selected ? [state.selected] : []),
    ])) {
      void openSession(id).catch((e) => useAgentStore.getState().report(e));
    }
  });
  agentClient.connect(options, consume, (connection, error) =>
    useAgentStore.setState({
      connection,
      ...(error ? { error } : connection === "connected" ? { error: "" } : {}),
    }),
  );
}

export const useAgentStore = create<State>((set, get) => ({
  connection: "disconnected",
  error: "",
  serverId: null,
  mobile: false,
  workspaces: [],
  sessions: {},
  views: {},
  harnesses: [],
  selected: null,
  workspaceId: null,
  harnessId: "pi",
  slots: [null],
  activeViewport: 0,
  opened: [],
  drafts: readStored<Record<string, Draft>>("codev.agent.drafts", {}),
  sendRevisions: {},
  temporarySessions: readStored<string[]>("codev.agent.temporarySessions", []),
  projectHarnesses: {},
  unread: [],
  initDesktop: () => {
    if (desktopInit) return desktopInit;
    desktopInit = (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const connection = await invoke<ConnectionOptions>(
        "agent_host_bootstrap",
      );
      establish(connection, false);
    })().catch((error) => {
      desktopInit = null;
      get().report(error);
      throw error;
    });
    return desktopInit;
  },
  connectRemote: (options) => establish(options, true),
  select: async (id, viewport) => {
    const state = get();
    const existing = state.slots.indexOf(id);
    const empty = state.slots.indexOf(null);
    const activeEmpty =
      state.selected === null && state.slots[state.activeViewport] === null
        ? state.activeViewport
        : -1;
    const index =
      viewport ??
      (existing >= 0
        ? existing
        : activeEmpty >= 0
          ? activeEmpty
          : empty >= 0
            ? empty
            : state.slots.length > 1
              ? -1
              : 0);
    if (index < 0 || index >= state.slots.length)
      throw new Error("视口已满，请新增视口或拖动线程到目标视口替换");
    const slots = [...state.slots];
    const previous = slots.indexOf(id);
    if (previous >= 0 && previous !== index)
      [slots[index], slots[previous]] = [slots[previous], slots[index]];
    else slots[index] = id;
    set({
      slots,
      activeViewport: index,
      opened: [...new Set([...state.opened, id])],
    });
    if (state.selected !== id) discardEmptySession(state.selected, slots);
    saveLocal("codev.agent.slots", JSON.stringify(slots));
    focusAgentSession(id);
    await openSession(id);
    const current = get();
    if (current.selected !== id) discardEmptySession(id, current.slots);
  },
  createSession: async (workspaceId, harnessId) => {
    const state = get();
    if (state.slots.length > 1 && !state.slots.includes(null))
      throw new Error("视口已满，请先新增或清空视口");
    const targetWorkspace = workspaceId ?? state.workspaceId;
    if (!targetWorkspace) throw new Error("请先选择工作目录");
    const view = await agentClient.request<SessionView>("session.create", {
      workspaceId: targetWorkspace,
      harnessId: harnessId ?? state.harnessId,
      connect: false,
    });
    const temporarySessions = [...get().temporarySessions, view.id];
    saveLocal(
      "codev.agent.temporarySessions",
      JSON.stringify(temporarySessions),
    );
    set({ temporarySessions });
    storeView(view);
    await get().select(view.id);
  },
  setProjectHarnesses: async (workspaceId, harnessIds) => {
    await get().command("host.project_harnesses.set", {
      workspaceId,
      harnessIds,
    });
    set((state) => ({
      projectHarnesses: {
        ...state.projectHarnesses,
        [workspaceId]: harnessIds,
      },
    }));
  },
  addWorkspace: async (cwd) => {
    const workspace = await agentClient.request<Workspace>("workspace.add", {
      cwd,
    });
    set((state) => ({
      workspaceId: workspace.id,
      workspaces: [
        ...state.workspaces.filter((w) => w.id !== workspace.id),
        workspace,
      ],
    }));
  },
  setWorkspace: (id) => set({ workspaceId: id }),
  setHarness: (id) => set({ harnessId: id }),
  setDraft: (id, draft) =>
    set((s) => {
      const drafts = {
        ...s.drafts,
        [id]: {
          ...(s.drafts[id] ?? { text: "", images: [], files: [] }),
          ...draft,
        },
      };
      saveLocal("codev.agent.drafts", JSON.stringify(drafts));
      return { drafts };
    }),
  bumpSend: (id) =>
    set((s) => ({
      sendRevisions: {
        ...s.sendRevisions,
        [id]: (s.sendRevisions[id] ?? 0) + 1,
      },
    })),
  setSlots: (slots) => {
    const nextSlots = slots.length ? slots : [null];
    const previous = get();
    for (const id of previous.slots) discardEmptySession(id, nextSlots);
    saveLocal("codev.agent.slots", JSON.stringify(nextSlots));
    set((s) => {
      const nextSelected =
        s.selected && nextSlots.includes(s.selected)
          ? s.selected
          : s.selected === null && nextSlots.includes(null)
            ? null
            : (nextSlots.find(Boolean) ?? null);
      const emptyIndex =
        nextSlots[s.activeViewport] === null
          ? s.activeViewport
          : nextSlots.indexOf(null);
      if (nextSelected) saveLocal("codev.agent.selected", nextSelected);
      else {
        try {
          localStorage.removeItem("codev.agent.selected");
        } catch {
          /* optional UI persistence */
        }
      }
      return {
        slots: nextSlots,
        opened: s.opened.filter(
          (id) => nextSlots.includes(id) || id === s.selected,
        ),
        selected: nextSelected,
        activeViewport: nextSelected
          ? nextSlots.indexOf(nextSelected)
          : Math.max(0, emptyIndex),
      };
    });
  },
  focusViewport: (index) => {
    const state = get();
    if (index < 0 || index >= state.slots.length) return;
    const id = state.slots[index];
    if (id) focusAgentSession(id);
    else {
      discardEmptySession(state.selected, state.slots);
      try {
        localStorage.removeItem("codev.agent.selected");
      } catch {
        /* optional UI persistence */
      }
      set({ selected: null, activeViewport: index });
    }
  },
  command: async <T>(operation: string, payload: unknown = {}, id?: string) => {
    const session = id ? get().views[id] : undefined;
    if (
      id &&
      (operation === "session.prompt" || operation === "session.queue.steer")
    ) {
      get().bumpSend(id);
    }
    const result = await agentClient.request<T>(
      operation,
      payload,
      id,
      session?.instanceId,
    );
    if (
      operation === "session.prompt" &&
      id &&
      get().temporarySessions.includes(id)
    ) {
      const temporarySessions = get().temporarySessions.filter(
        (item) => item !== id,
      );
      saveLocal(
        "codev.agent.temporarySessions",
        JSON.stringify(temporarySessions),
      );
      set({ temporarySessions });
    }
    if (
      ["session.connect", "session.history", "session.open"].includes(
        operation,
      ) &&
      id
    ) {
      const view = result as SessionView;
      if (view?.id) storeView(view);
    }
    return result;
  },
  report: (error) =>
    set({ error: error instanceof Error ? error.message : String(error) }),
}));
