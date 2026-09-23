import type { Thread, Session } from "./protocol";

/** 从原生来源或活动事件补充的字段读取父线程。 */
export function parentThread(thread: Thread): string | null {
  const parent = thread.parentThreadId ?? thread.source?.subAgent?.thread_spawn?.parent_thread_id ?? thread.source?.subagent?.thread_spawn?.parent_thread_id;
  return parent && parent !== thread.id ? parent : null;
}

/** 查找所属子任务树，限制重复访问以避免错误关系循环。 */
export function taskFamily(sessions: Record<string, Session>, root: string): string[] {
  const result = [root];
  const visited = new Set(result);
  for (let index = 0; index < result.length; index++) {
    const parent = sessions[result[index]]?.thread.id;
    for (const [key, session] of Object.entries(sessions)) {
      if (parent && parentThread(session.thread) === parent && !visited.has(key)) {
        visited.add(key);
        result.push(key);
      }
    }
  }
  return result;
}
