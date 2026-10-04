import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "./env";

export function workspaceCurrentDir(): Promise<string> {
  return invoke<string>("workspace_current_dir");
}

export function workspaceAuthorize(path: string): Promise<string> {
  return invoke<string>("workspace_authorize", {
    path,
    workspace: currentWorkspaceEnv(),
  });
}
