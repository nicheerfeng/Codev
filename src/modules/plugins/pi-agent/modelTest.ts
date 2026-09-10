import { PiWorkspaceClient } from "./client";

/** 通过临时无工具 Pi 会话测试已保存模型，结束、关闭或超时均释放进程。 */
export async function testSavedModel(
  cwd: string,
  provider: string,
  modelId: string,
  signal: AbortSignal,
): Promise<string> {
  const started = performance.now();
  let sent = false;
  let resolveResult: (value: string) => void = () => {};
  let rejectResult: (reason: Error) => void = () => {};
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // 初始化期间失败时也会进入同一清理流程，避免未处理的 Promise 拒绝。
  void result.catch(() => {});
  const client = new PiWorkspaceClient(
    () => {
      const thread = client.threads.get("test");
      if (!sent || !thread) return;
      if (thread.view.error) rejectResult(new Error(thread.view.error));
      else if (
        thread.view.status === "idle" &&
        thread.view.items.some(
          (item) =>
            item.kind === "message" &&
            item.role === "assistant" &&
            item.text.trim(),
        )
      )
        resolveResult(
          `可用 · ${(performance.now() - started).toFixed(0)} ms（含启动）`,
        );
      else if (
        thread.view.status === "stopped" ||
        thread.view.status === "failed"
      )
        rejectResult(new Error("测试进程已结束"));
    },
    () => {},
    true,
  );
  /** 中断当前测试并回收其临时进程。 */
  const cancel = () => {
    rejectResult(new Error("测试已取消"));
    client.dispose();
  };
  const timeout = setTimeout(() => {
    rejectResult(new Error("测试超时（45 秒）"));
    client.dispose();
  }, 45000);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new Error("测试已取消");
    const thread = await client.open("test", cwd);
    await client.request(thread, { type: "set_model", provider, modelId });
    sent = true;
    await client.request(thread, { type: "prompt", message: "Reply only OK." });
    return await result;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    client.dispose();
  }
}
