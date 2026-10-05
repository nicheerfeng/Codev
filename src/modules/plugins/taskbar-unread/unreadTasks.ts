const listeners = new Set<() => void>();
const ids = new Set<string>();

function emit() {
  for (const listener of listeners) listener();
}

export function unreadTaskId(scope: "pi" | "codex", key: string) {
  return `${scope}:${key}`;
}

export function listUnreadTasks() {
  return [...ids];
}

export function unreadTaskCount() {
  return ids.size;
}

export function hasUnreadTask(id: string) {
  return ids.has(id);
}

export function getUnreadTaskSnapshot() {
  return ids;
}

export function subscribeUnreadTasks(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function markUnreadTask(id: string) {
  if (!id || ids.has(id)) return;
  ids.add(id);
  emit();
}

export function markUnreadTasks(next: string[]) {
  let changed = false;
  for (const id of next) {
    if (!id || ids.has(id)) continue;
    ids.add(id);
    changed = true;
  }
  if (changed) emit();
}

export function markTaskRead(id: string) {
  if (!ids.delete(id)) return;
  emit();
}

export function clearUnreadIds(next: string[]) {
  let changed = false;
  for (const id of next) {
    if (!ids.delete(id)) continue;
    changed = true;
  }
  if (changed) emit();
}

export function clearUnreadPrefix(prefix: string) {
  let changed = false;
  for (const id of [...ids]) {
    if (!id.startsWith(prefix)) continue;
    ids.delete(id);
    changed = true;
  }
  if (changed) emit();
}

export function resetUnreadTasks() {
  if (!ids.size) return;
  ids.clear();
  emit();
}

export type UnreadStatusTask = {
  key: string;
  status: string;
  child?: boolean;
};

const ACTIVE_STATUSES = new Set(["running", "queued", "stopping"]);
const DONE_STATUSES = new Set(["idle", "complete", "completed"]);
const LIVE_PRIORS = new Set(["running", "queued", "stopping", "waiting"]);

/** 运行中清待读；从运行/等待边沿进入完成则记待读。 */
export function collectUnreadStatusChanges(
  previous: Map<string, string>,
  tasks: UnreadStatusTask[],
  idFor: (key: string) => string,
): { completed: string[]; running: string[] } {
  const completed: string[] = [];
  const running: string[] = [];
  for (const task of tasks) {
    const prior = previous.get(task.key);
    const active = ACTIVE_STATUSES.has(task.status);
    const done = DONE_STATUSES.has(task.status);
    if (active) running.push(idFor(task.key));
    if (
      done &&
      (LIVE_PRIORS.has(prior ?? "") || (task.child && prior === undefined))
    )
      completed.push(idFor(task.key));
    previous.set(task.key, task.status);
  }
  return { completed, running };
}

export function applyUnreadStatusChanges(input: {
  completed: string[];
  running: string[];
}) {
  clearUnreadIds(input.running);
  markUnreadTasks(input.completed);
}
