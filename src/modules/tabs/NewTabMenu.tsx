import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmtShortcut, MOD_KEY, SHIFT_KEY } from "@/lib/platform";
import {
  ComputerTerminal02Icon,
  Globe02Icon,
  IncognitoIcon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

type Props = {
  onNew: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
};

export function NewTabMenu({
  onNew,
  onNewBlock,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="New tab"
        >
          <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuItem onSelect={onNew}>
          <HugeiconsIcon
            icon={ComputerTerminal02Icon}
            size={14}
            strokeWidth={1.75}
          />
          <span className="flex-1">Terminal</span>
          <span className="text-xs text-muted-foreground">
            {fmtShortcut(MOD_KEY, "T")}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewBlock}>
          <HugeiconsIcon
            icon={ComputerTerminal02Icon}
            size={14}
            strokeWidth={1.75}
          />
          <span className="flex-1">Blocks</span>
          <span className="text-xs text-muted-foreground">
            {fmtShortcut(MOD_KEY, SHIFT_KEY, "T")}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewPrivate}>
          <HugeiconsIcon
            icon={IncognitoIcon}
            size={14}
            strokeWidth={1.75}
          />
          <span className="flex-1">Privacy</span>
          <span className="text-xs text-muted-foreground">
            {fmtShortcut(MOD_KEY, "R")}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewEditor}>
          <HugeiconsIcon
            icon={PencilEdit02Icon}
            size={14}
            strokeWidth={1.75}
          />
          <span className="flex-1">Editor</span>
          <span className="text-xs text-muted-foreground">
            {fmtShortcut(MOD_KEY, "E")}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewPreview}>
          <HugeiconsIcon
            icon={Globe02Icon}
            size={14}
            strokeWidth={1.75}
          />
          <span className="flex-1">Preview</span>
          <span className="text-xs text-muted-foreground">
            {fmtShortcut(MOD_KEY, "P")}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
