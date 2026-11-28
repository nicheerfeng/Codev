import { ContextMenuItem } from "@/components/ui/context-menu";
import { usePluginStore } from "@/modules/plugins/store";
import { requestAgentProject } from "@/modules/agent/agentProjectRequest";
import { useAgentStore } from "@/modules/agent/store";
import { toast } from "sonner";
import { COMPACT_ITEM } from "./lib/menuItemClass";

function normalizePathKey(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function AgentProjectMenuItems({
  cwd,
  isFile = false,
}: {
  cwd: string;
  isFile?: boolean;
}) {
  const enabled = usePluginStore((state) => state.enabled["agent-host"]);
  const handleSelect = () => {
    requestAgentProject(cwd);
    const store = useAgentStore.getState();
    const targetKey = normalizePathKey(cwd);
    const existed = store.workspaces.some(
      (workspace) => normalizePathKey(workspace.cwd) === targetKey,
    );
    void store
      .addWorkspace(cwd)
      .then((workspace) => {
        requestAgentProject(workspace.cwd);
        toast.success(
          existed
            ? `项目「${workspace.title}」已在 Agent 工作区，已定位`
            : `已添加「${workspace.title}」到 Agent 工作区`,
        );
      })
      .catch((error) => {
        toast.error("添加到 Agent 工作区失败", {
          description: error instanceof Error ? error.message : String(error),
        });
      });
  };
  return (
    <ContextMenuItem
      className={COMPACT_ITEM}
      disabled={!enabled}
      title={
        enabled
          ? isFile
            ? `添加文件所在目录：${cwd}`
            : cwd
          : "请先启用 Agent 工作区"
      }
      onSelect={handleSelect}
    >
      添加到 Agent 工作区
    </ContextMenuItem>
  );
}
