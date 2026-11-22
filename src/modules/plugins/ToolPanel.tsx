import { lazy, Suspense, useEffect, useState } from "react";
import { JsonFormatterPane } from "./json-formatter/JsonFormatterPane";
import { TextDiffPane } from "./text-diff/TextDiffPane";
import { AGENT_HOST_PLUGIN_ID, usePluginStore } from "./store";
const AgentPane = lazy(() =>
  import("@/modules/agent/AgentPane").then((module) => ({
    default: module.AgentPane,
  })),
);
export type ToolId = "json" | "diff" | "agent";

function JsonFormatterTool() {
  const [ids, setIds] = useState([1]);
  return (
    <div className="flex h-full min-h-0 min-w-0 overflow-hidden bg-card">
      <div className="flex min-h-0 min-w-0 flex-1 gap-px overflow-hidden">
        {ids.map((id) => (
          <JsonFormatterPane
            key={id}
            onAdd={
              ids.length === 1
                ? () => setIds((ids) => [...ids, Math.max(...ids) + 1])
                : undefined
            }
            onClose={
              ids.length === 2
                ? () => setIds((ids) => ids.filter((i) => i !== id))
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}
export function ToolPanel({
  tool = "agent",
  active = true,
  onOpenFile,
  onOpenDiff,
  workspaceRoots = [],
  onAddWorkspaceRoot,
}: {
  tool?: ToolId;
  active?: boolean;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (path: string, diff: string) => void;
  workspaceRoots?: string[];
  onAddWorkspaceRoot?: (path: string) => void;
}) {
  const enabled = usePluginStore((s) => s.enabled[AGENT_HOST_PLUGIN_ID]);
  const [visited, setVisited] = useState(active && tool === "agent");
  useEffect(() => {
    if (active && tool === "agent") setVisited(true);
  }, [active, tool]);
  return (
    <div className="relative h-full min-h-0 min-w-0 overflow-hidden bg-card">
      <div
        className={
          tool === "json" ? "absolute inset-0" : "hidden absolute inset-0"
        }
      >
        <JsonFormatterTool />
      </div>
      <div
        className={
          tool === "diff" ? "absolute inset-0" : "hidden absolute inset-0"
        }
      >
        <TextDiffPane />
      </div>
      <div
        className={
          tool === "agent" ? "absolute inset-0" : "hidden absolute inset-0"
        }
      >
        {visited && enabled && (
          <Suspense
            fallback={
              <div className="p-4 text-xs text-muted-foreground">
                正在连接 Agent 主机…
              </div>
            }
          >
            <AgentPane
              active={active && tool === "agent"}
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
              workspaceRoots={workspaceRoots}
              onAddWorkspaceRoot={onAddWorkspaceRoot}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
