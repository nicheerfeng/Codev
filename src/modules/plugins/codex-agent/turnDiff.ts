const KEY = "codev.codex.turn-diff";

export type CodexTurnFile = {
  path: string;
  diff: string;
  adds: number;
  dels: number;
  kind: "created" | "modified" | "deleted";
};

export function codexTurnDiffEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function tally(diff: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) adds += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) dels += 1;
  }
  return { adds, dels };
}

export function codexTurnFiles(
  changes: Array<{
    path: string;
    diff: string;
    kind?: { type: string };
  }>,
): CodexTurnFile[] {
  if (!codexTurnDiffEnabled()) return [];
  return [
    ...new Map(
      changes.map((change) => {
        const counts = tally(change.diff);
        const type = change.kind?.type;
        return [
          change.path,
          {
            path: change.path,
            diff: change.diff,
            adds: counts.adds,
            dels: counts.dels,
            kind:
              type === "add"
                ? "created"
                : type === "delete"
                  ? "deleted"
                  : "modified",
          } satisfies CodexTurnFile,
        ];
      }),
    ).values(),
  ].filter((file) => file.adds > 0 || file.dels > 0 || file.diff);
}
