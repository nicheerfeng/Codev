import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CodexClient } from "./client";

/** 合并磁盘通知；仅刷新外部修改的空闲缓存，不恢复写线程。 */
export function watchHistory(
  client: CodexClient,
  onError: (error: unknown) => void,
) {
  let stopped = false;
  let listening: UnlistenFn | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading = false;
  const pending = new Set<string>();
  /** 串行合并目录变化，活跃线程由原生事件维护。 */
  const flush = async () => {
    timer = undefined;
    const state = client.getSnapshot();
    if (stopped || !state.connected) return;
    if (state.switching || reading) {
      timer = setTimeout(() => void flush(), 1500);
      return;
    }
    reading = true;
    const paths = [...pending];
    pending.clear();
    try {
      await client.refreshChanged(paths);
      for (const session of Object.values(client.getSnapshot().sessions)) {
        if (stopped) break;
        if (
          session.loaded &&
          !session.resumed &&
          !session.busy &&
          !session.sending &&
          paths.some((path) => path.includes(session.thread.id))
        ) {
          client.patch(session.thread.id, { loaded: false });
          await client.load(session.thread.id);
        }
      }
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      reading = false;
      if (!stopped && pending.size && !timer)
        timer = setTimeout(() => void flush(), 1500);
    }
  };
  void listen<string[]>("codev://codex-sessions-changed", ({ payload }) => {
    const own = Object.values(client.getSnapshot().sessions).filter(
      (session) => session.resumed || session.busy || session.sending,
    );
    payload
      .filter(
        (path) => Object.keys(client.getSnapshot().sessions).some(id => path.includes(id)) && !own.some((session) => path.includes(session.thread.id)),
      )
      .forEach((path) => {
        pending.add(path);
      });
    if (pending.size && !timer) timer = setTimeout(() => void flush(), 1500);
  })
    .then(async (unlisten) => {
      if (stopped) {
        unlisten();
        return;
      }
      listening = unlisten;
      await invoke("codex_agent_watch_sessions", { enabled: true });
      if (stopped)
        await invoke("codex_agent_watch_sessions", { enabled: false });
    })
    .catch(onError);
  return () => {
    stopped = true;
    clearTimeout(timer);
    listening?.();
    void invoke("codex_agent_watch_sessions", { enabled: false }).catch(
      onError,
    );
  };
}
