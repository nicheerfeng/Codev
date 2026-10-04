import { useState } from "react";
import type { PiTurnFile } from "./turnDiff";

export function PiTurnFilesCard({
  files,
  onOpenFile,
}: {
  files: PiTurnFile[];
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!files.length) return null;
  return (
    <div className="my-2 rounded-lg border border-border/70 text-xs">
      <button
        type="button"
        className="flex w-full items-center px-2 py-1.5 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        本回合修改了 {files.length} 个文件
      </button>
      {open && (
        <div className="border-t border-border/60 p-1">
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              className="block w-full truncate rounded px-2 py-1 text-left hover:bg-accent"
              title={file.path}
              onClick={() => onOpenFile?.(file.path)}
            >
              {file.path}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
