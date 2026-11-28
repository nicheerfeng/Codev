import { ContextMenuItem } from "@/components/ui/context-menu";
import { usePluginStore } from "@/modules/plugins/store";
import { requestAgentProject } from "@/modules/agent/agentProjectRequest";
import { COMPACT_ITEM } from "./lib/menuItemClass";

export function AgentProjectMenuItems({
  cwd,
  isFile = false,
}: {
  cwd: string;
  isFile?: boolean;
}) {
  const enabled = usePluginStore((state) => state.enabled["agent-host"]);
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
      onSelect={() => requestAgentProject(cwd)}
    >
      添加到 Agent 工作区
    </ContextMenuItem>
  );
}
