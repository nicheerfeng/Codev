import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { currentWorkspaceEnv } from "@/modules/workspace";

export type TransferMode = "copy" | "move" | "undo";

export type TransferError = {
  code: string;
  path: string;
  message: string;
};

export type TransferEvent = {
  id: number;
  mode: TransferMode;
  status:
    | "preparing"
    | "running"
    | "cancelling"
    | "completed"
    | "cancelled"
    | "failed";
  currentPath: string | null;
  doneBytes: number;
  totalBytes: number;
  doneItems: number;
  totalItems: number;
  error: TransferError | null;
  canUndo: boolean;
};

/** 判断迁移事件是否仍处于可停止的后台阶段。 */
function isTransferActive(event: TransferEvent | null): boolean {
  return (
    event?.status === "preparing" ||
    event?.status === "running" ||
    event?.status === "cancelling"
  );
}

/** 管理文件迁移任务、进度事件、停止和撤销操作。 */
export function useFileTransfer() {
  const [event, setEvent] = useState<TransferEvent | null>(null);
  const activeRef = useRef<TransferEvent | null>(null);

  useEffect(() => {
    let alive = true;
    const unlistenPromise = listen<TransferEvent>("fs:transfer", (message) => {
      if (!alive) return;
      const next = message.payload;
      if (activeRef.current?.id !== next.id) return;
      activeRef.current = next;
      setEvent(next);
      if (next.status === "completed") {
        toast.success(next.mode === "undo" ? "已撤销文件迁移" : "文件迁移完成");
      } else if (next.status === "failed" && next.error) {
        toast.error(`${next.error.message}: ${next.error.path}`);
      } else if (next.status === "cancelled") {
        toast.info("文件迁移已停止");
      }
    });
    return () => {
      alive = false;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const start = useCallback(
    async (
      sources: string[],
      destDir: string,
      mode: Exclude<TransferMode, "undo">,
    ) => {
      if (isTransferActive(activeRef.current)) {
        toast.info("已有文件迁移正在进行");
        return null;
      }
      const id = await invoke<number>("fs_transfer_start", {
        sources,
        destDir,
        mode,
        workspace: currentWorkspaceEnv(),
      });
      const initial: TransferEvent = {
        id,
        mode,
        status: "preparing",
        currentPath: null,
        doneBytes: 0,
        totalBytes: 0,
        doneItems: 0,
        totalItems: 0,
        error: null,
        canUndo: false,
      };
      activeRef.current = initial;
      setEvent(initial);
      return id;
    },
    [],
  );

  const cancel = useCallback(async () => {
    const current = activeRef.current;
    if (!current || !isTransferActive(current)) return;
    const next = { ...current, status: "cancelling" as const };
    activeRef.current = next;
    setEvent(next);
    await invoke("fs_transfer_cancel", { id: current.id });
  }, []);

  const undo = useCallback(async () => {
    const current = activeRef.current;
    if (!current) return null;
    if (current.status !== "completed" || !current.canUndo) return null;
    const id = await invoke<number>("fs_transfer_undo", { id: current.id });
    const initial: TransferEvent = {
      id,
      mode: "undo",
      status: "preparing",
      currentPath: null,
      doneBytes: 0,
      totalBytes: 0,
      doneItems: 0,
      totalItems: 0,
      error: null,
      canUndo: false,
    };
    activeRef.current = initial;
    setEvent(initial);
    return id;
  }, []);

  const clear = useCallback(() => {
    activeRef.current = null;
    setEvent(null);
  }, []);

  return { event, start, cancel, undo, clear, active: isTransferActive(event) };
}
