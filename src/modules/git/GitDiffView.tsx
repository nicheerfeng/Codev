export function GitDiffView({ diff }: { diff: string }) {
  return (
    <pre className="reader-scrollbar h-full overflow-auto bg-card p-3 text-[12px] leading-5">
      {(diff || "没有可显示的差异").split("\n").map((line, index) => {
        const color = line.startsWith("+")
          ? "text-green-500"
          : line.startsWith("-")
            ? "text-red-500"
            : "text-foreground/80";
        return (
          <div key={`${index}:${line}`} className={color}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
