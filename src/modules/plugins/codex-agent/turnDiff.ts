const KEY = "codev.codex.turn-diff";

export type CodexTurnFile = { path: string; diff: string };

export function codexTurnDiffEnabled(): boolean {
  return localStorage.getItem(KEY) === "1";
}

export function codexTurnFiles(
  changes: Array<{ path: string; diff: string }>,
): CodexTurnFile[] {
  if (!codexTurnDiffEnabled()) return [];
  return [...new Map(changes.map((change) => [change.path, change])).values()];
}
