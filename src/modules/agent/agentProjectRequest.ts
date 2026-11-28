import { create } from "zustand";

let nextRequestId = 1;

export const useAgentProjectRequest = create<{
  request: { target: "agent"; cwd: string; id: number } | null;
}>(() => ({ request: null }));

export function requestAgentProject(cwd: string) {
  useAgentProjectRequest.setState({
    request: { target: "agent", cwd, id: nextRequestId++ },
  });
}
export function finishAgentProjectRequest(id: number) {
  if (useAgentProjectRequest.getState().request?.id === id)
    useAgentProjectRequest.setState({ request: null });
}
