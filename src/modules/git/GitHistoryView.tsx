import type { GitCommit } from "./native";

export function GitHistoryView({ commits }: { commits: GitCommit[] }) {
  return (
    <div className="reader-scrollbar h-full overflow-auto bg-card">
      <div className="grid grid-cols-[88px_minmax(0,1fr)_180px_140px_96px] border-b border-border/60 px-3 py-2 text-[10px] text-muted-foreground">
        <span>SHA</span>
        <span>SUBJECT</span>
        <span>REFS</span>
        <span>AUTHOR</span>
        <span>DATE</span>
      </div>
      {commits.map((commit) => (
        <div
          key={commit.hash}
          className="grid grid-cols-[88px_minmax(0,1fr)_180px_140px_96px] border-b border-border/40 px-3 py-1.5 text-xs hover:bg-accent/30"
        >
          <span className="font-mono text-sky-400">{commit.hash}</span>
          <span className="truncate">{commit.subject}</span>
          <span className="truncate text-amber-500">{commit.refs}</span>
          <span className="truncate text-muted-foreground">
            {commit.author}
          </span>
          <span className="text-muted-foreground">{commit.date}</span>
        </div>
      ))}
      {commits.length === 0 && (
        <p className="p-4 text-xs text-muted-foreground">没有提交记录</p>
      )}
    </div>
  );
}
