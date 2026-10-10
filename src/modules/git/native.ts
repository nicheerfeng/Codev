import { invoke } from "@tauri-apps/api/core";

export type GitRepo = {
  root: string;
  name: string;
  branch: string;
  changes: number;
};

export type GitChange = {
  path: string;
  status: string;
  staged: boolean;
};

export type GitSnapshot = {
  repo: GitRepo;
  changes: GitChange[];
  empty: boolean;
};

export type GitCommit = {
  hash: string;
  subject: string;
  author: string;
  date: string;
  refs: string;
};

export type GitTracking = {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
};

export function gitSnapshot(root: string): Promise<GitSnapshot | null> {
  return invoke<GitSnapshot | null>("git_snapshot", { root });
}

export function gitDiff(
  root: string,
  path: string,
  staged: boolean,
): Promise<string> {
  return invoke<string>("git_diff", { root, path, staged });
}

export function gitStage(
  root: string,
  paths: string[],
  staged: boolean,
): Promise<void> {
  return invoke<void>("git_stage", { root, paths, staged });
}

export function gitCommit(root: string, message: string): Promise<void> {
  return invoke<void>("git_commit", { root, message });
}

export function gitLog(root: string): Promise<GitCommit[]> {
  return invoke<GitCommit[]>("git_log", { root });
}

export function gitFetch(root: string): Promise<void> {
  return invoke<void>("git_fetch", { root });
}

export function gitTracking(root: string): Promise<GitTracking> {
  return invoke<GitTracking>("git_tracking", { root });
}

export function gitPull(root: string): Promise<void> {
  return invoke<void>("git_pull", { root });
}

export function gitPush(root: string): Promise<void> {
  return invoke<void>("git_push", { root });
}
