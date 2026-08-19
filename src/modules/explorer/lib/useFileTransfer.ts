import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { currentWorkspaceEnv } from "@/modules/workspace";

export type TransferMode = "copy" | "move" | "undo";
export type TransferStatus =
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";
export type TransferPhase = "copying" | "committing" | "undoing" | null;

export type TransferError = {
  code: string;
  path: string;
  message: string;
};

export type TransferResult = {
  id: string;
  status: "completed" | "cancelled" | "failed";
  error: TransferError | null;
  canUndo: boolean;
};

export type TransferEvent = {
  id: string;
  mode: TransferMode;
  status: TransferStatus;
  phase: TransferPhase;
  currentPath: string | null;
  doneBytes: number;
  totalBytes: number;
  error: TransferError | null;
  canUndo: boolean;
};

type TransferProgress = {
  id: string;
  phase: Exclude<TransferPhase, null>;
  currentPath: string | null;
  doneBytes: number;
  totalBytes: number;
};

/** 判断任务是否仍占用唯一迁移槽位。 */
function isTransferActive(event: TransferEvent | null): boolean {
  return event?.status === "running" || event?.status === "cancelling";
}

/** 展示一次迁移最终结果。 */
function notifyResult(mode: TransferMode, result: TransferResult): void {
  if (result.status === "completed") {
    toast.success(mode === "undo" ? "已撤销文件迁移" : "文件迁移完成");
  } else if (result.status === "cancelled") {
    toast.info("文件迁移已停止");
  } else {
    const detail = result.error?.path
      ? `${result.error.message}: ${result.error.path}`
      : (result.error?.message ?? "未知错误");
    toast.error(`文件迁移失败：${detail}`);
  }
}

/** 管理单一迁移任务，命令返回值负责最终状态，事件仅更新进度。 */
export function useFileTransfer() {
  const [event, setEvent] = useState<TransferEvent | null>(null);
  const activeRef = useRef<TransferEvent | null>(null);

  useEffect(() => {
    let alive = true;
    const unlistenPromise = listen<TransferProgress>(
      "fs:transfer-progress",
      ({ payload }) => {
        if (
          !alive ||
          activeRef.current?.id !== payload.id ||
          !isTransferActive(activeRef.current)
        ) {
          return;
        }
        const next: TransferEvent = {
          ...activeRef.current,
          phase: payload.phase,
          currentPath: payload.currentPath,
          doneBytes: payload.doneBytes,
          totalBytes: payload.totalBytes,
        };
        activeRef.current = next;
        setEvent(next);
      },
    );
    return () => {
      alive = false;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  /** 执行复制或移动，并以命令返回值闭合最终状态。 */
  const start = useCallback(
    async (
      sources: string[],
      destDir: string,
      mode: Exclude<TransferMode, "undo">,
    ): Promise<TransferResult | null> => {
      if (isTransferActive(activeRef.current)) {
        toast.info("已有文件迁移正在进行");
        return null;
      }
      const id = crypto.randomUUID();
      const initial: TransferEvent = {
        id,
        mode,
        status: "running",
        phase: "copying",
        currentPath: null,
        doneBytes: 0,
        totalBytes: 0,
        error: null,
        canUndo: false,
      };
      activeRef.current = initial;
      setEvent(initial);

      try {
        const result = await invoke<TransferResult>("fs_transfer_execute", {
          id,
          sources,
          destDir,
          mode,
          workspace: currentWorkspaceEnv(),
        });
        const latest =
          activeRef.current?.id === id ? activeRef.current : initial;
        const finalEvent: TransferEvent = {
          ...latest,
          ...result,
          mode,
          phase: null,
          currentPath: null,
        };
        activeRef.current = finalEvent;
        setEvent(finalEvent);
        notifyResult(mode, result);
        return result;
      } catch (cause) {
        const result: TransferResult = {
          id,
          status: "failed",
          error: {
            code: "invoke_failed",
            path: "",
            message: String(cause),
          },
          canUndo: false,
        };
        const finalEvent: TransferEvent = {
          ...initial,
          ...result,
          phase: null,
        };
        activeRef.current = finalEvent;
        setEvent(finalEvent);
        notifyResult(mode, result);
        return result;
      }
    },
    [],
  );

  /** 请求当前复制或移动在安全检查点停止。 */
  const cancel = useCallback(async () => {
    const current = activeRef.current;
    if (!current || !isTransferActive(current) || current.mode === "undo")
      return;
    const next = { ...current, status: "cancelling" as const };
    activeRef.current = next;
    setEvent(next);
    try {
      await invoke("fs_transfer_cancel", { id: current.id });
    } catch (cause) {
      toast.info(String(cause));
    }
  }, []);

  /** 撤销最近一次可安全撤销的迁移。 */
  const undo = useCallback(async (): Promise<TransferResult | null> => {
    const current = activeRef.current;
    if (current?.status !== "completed" || !current.canUndo) {
      return null;
    }
    const sourceId = current.id;
    const id = crypto.randomUUID();
    const initial: TransferEvent = {
      id,
      mode: "undo",
      status: "running",
      phase: "undoing",
      currentPath: null,
      doneBytes: 0,
      totalBytes: 0,
      error: null,
      canUndo: false,
    };
    activeRef.current = initial;
    setEvent(initial);
    try {
      const result = await invoke<TransferResult>("fs_transfer_undo", {
        id,
        sourceId,
      });
      const finalEvent: TransferEvent = {
        ...initial,
        ...result,
        phase: null,
      };
      activeRef.current = finalEvent;
      setEvent(finalEvent);
      notifyResult("undo", result);
      return result;
    } catch (cause) {
      const result: TransferResult = {
        id,
        status: "failed",
        error: {
          code: "invoke_failed",
          path: "",
          message: String(cause),
        },
        canUndo: false,
      };
      const finalEvent: TransferEvent = {
        ...initial,
        ...result,
        phase: null,
      };
      activeRef.current = finalEvent;
      setEvent(finalEvent);
      notifyResult("undo", result);
      return result;
    }
  }, []);

  /** 清除已结束任务的状态提示。 */
  const clear = useCallback(() => {
    if (isTransferActive(activeRef.current)) return;
    activeRef.current = null;
    setEvent(null);
  }, []);

  return { event, start, cancel, undo, clear, active: isTransferActive(event) };
}
