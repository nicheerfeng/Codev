export type DiffHunk = {
  id: string;
  header: string;
  lines: string[];
  additions: number;
  deletions: number;
  patch: string;
};

/** Parse a single-file unified diff into header lines + independently stageable/revertable hunks. */
export function parseUnifiedHunks(unified: string): {
  fileHeader: string;
  hunks: DiffHunk[];
} {
  if (!unified.trim()) return { fileHeader: "", hunks: [] };
  const allLines = unified.replace(/\r\n/g, "\n").split("\n");
  const headerLines: string[] = [];
  const hunks: DiffHunk[] = [];
  let inHunk = false;
  let currentHeader = "";
  let currentLines: string[] = [];
  let additions = 0;
  let deletions = 0;

  const flush = () => {
    if (!inHunk || !currentHeader) return;
    const fileHdr = headerLines.join("\n");
    const patchBody = [fileHdr, currentHeader, ...currentLines]
      .filter((x) => x !== "")
      .join("\n");
    hunks.push({
      id: `${hunks.length}:${currentHeader}`,
      header: currentHeader,
      lines: currentLines,
      additions,
      deletions,
      patch: `${patchBody}\n`,
    });
    currentHeader = "";
    currentLines = [];
    additions = 0;
    deletions = 0;
  };

  for (const line of allLines) {
    if (line.startsWith("@@ ")) {
      flush();
      inHunk = true;
      currentHeader = line;
      continue;
    }
    if (!inHunk) {
      if (
        line.startsWith("diff --git ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("index ") ||
        line.startsWith("new file mode") ||
        line.startsWith("deleted file mode")
      ) {
        headerLines.push(line);
      }
    } else {
      currentLines.push(line);
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
  }
  flush();
  return { fileHeader: headerLines.join("\n"), hunks };
}

/** Combine conflict base/ours/theirs cleanly when user chooses "保留双方 (Accept Both)". */
export function mergeConflictAcceptBoth(ours: string, theirs: string): string {
  const cleanOurs = ours.replace(/\r\n/g, "\n").trimEnd();
  const cleanTheirs = theirs.replace(/\r\n/g, "\n").replace(/^\n+/, "").trimEnd();
  if (!cleanOurs && !cleanTheirs) return "";
  if (!cleanOurs) return `${cleanTheirs}\n`;
  if (!cleanTheirs) return `${cleanOurs}\n`;
  return `${cleanOurs}\n${cleanTheirs}\n`;
}
