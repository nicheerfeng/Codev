const KEY = "codev.pi.turn-diff";

export type PiTurnFile = { path: string; before: string | null };

const turns = new Map<string, Map<string, PiTurnFile>>();

export function piTurnDiffEnabled(): boolean {
  return localStorage.getItem(KEY) === "1";
}

export function recordPiTurnFile(
  turn: string,
  path: string,
  before: string | null,
) {
  if (!piTurnDiffEnabled() || !turn || !path) return;
  const files = turns.get(turn) ?? new Map<string, PiTurnFile>();
  if (!files.has(path)) files.set(path, { path, before });
  turns.set(turn, files);
}

export function piTurnFiles(turn: string): PiTurnFile[] {
  return [...(turns.get(turn)?.values() ?? [])];
}
