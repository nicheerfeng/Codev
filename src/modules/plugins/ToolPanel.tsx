import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { lazy, Suspense, useEffect, useState } from "react";
import { ForgeInboxPanel } from "@/modules/forge/ForgeInboxPanel";
import { JsonFormatterPane } from "./json-formatter/JsonFormatterPane";
import { TextDiffPane } from "./text-diff/TextDiffPane";
import { AGENT_HOST_PLUGIN_ID, usePluginStore } from "./store";
const AgentPane = lazy(() =>
  import("@/modules/agent/AgentPane").then((module) => ({
    default: module.AgentPane,
  })),
);
export type ToolId = "json" | "diff" | "agent" | "git-inbox";

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
  dockSide = "right",
  onOpenFile,
  onOpenDiff,
  workspaceRoots = [],
  activeRoot,
  onAddWorkspaceRoot,
  onFocusAgentTab,
}: {
  tool?: ToolId;
  active?: boolean;
  dockSide?: "left" | "right";
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (
    path: string,
    diff: string,
    options?: { activate?: boolean },
  ) => void;
  workspaceRoots?: string[];
  activeRoot?: string | null;
  onAddWorkspaceRoot?: (path: string) => void;
  onFocusAgentTab?: () => void;
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
          tool === "git-inbox" ? "absolute inset-0" : "hidden absolute inset-0"
        }
      >
        <PanelErrorBoundary title="Git 收件箱">
          <ForgeInboxPanel
            workspaceRoots={workspaceRoots}
            activeRoot={activeRoot}
            onAddWorkspaceRoot={onAddWorkspaceRoot}
            onFocusAgentTab={onFocusAgentTab}
          />
        </PanelErrorBoundary>
      </div>
      <div
        className={
          tool === "agent" ? "absolute inset-0" : "hidden absolute inset-0"
        }
      >
        {visited && enabled && (
          <PanelErrorBoundary title="Agent">
            <Suspense
              fallback={
                <div className="p-4 text-xs text-muted-foreground">
                  正在连接 Agent 主机…
                </div>
              }
            >
              <AgentPane
                active={active && tool === "agent"}
                dockSide={dockSide}
                onOpenFile={onOpenFile}
                onOpenDiff={onOpenDiff}
                workspaceRoots={workspaceRoots}
                onAddWorkspaceRoot={onAddWorkspaceRoot}
              />
            </Suspense>
          </PanelErrorBoundary>
        )}
      </div>
    </div>
  );
}
