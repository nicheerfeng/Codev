import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n/types";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { ThemePref } from "@/modules/settings/store";
import {
  setLocale,
  setShowHidden,
  setZoomLevel,
} from "@/modules/settings/store";
import { useTheme } from "@/modules/theme";
import {
  ComputerIcon,
  Moon02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SettingRow } from "../components/SettingRow";

const APPEARANCE: {
  id: ThemePref;
  label: string;
  icon: typeof ComputerIcon;
}[] = [
  { id: "system", label: "System", icon: ComputerIcon },
  { id: "light", label: "Light", icon: Sun03Icon },
  { id: "dark", label: "Dark", icon: Moon02Icon },
];

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.05;

/** 渲染紧凑的外观、语言、缩放和文件树设置。 */
export function GeneralSection() {
  const { mode, setMode } = useTheme();
  const t = useT();
  const locale = usePreferencesStore((s) => s.locale);
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[12px] font-semibold tracking-tight">
        {t("General")}
      </h2>
      <SettingRow title={t("Appearance")}>
        <div className="flex items-center gap-1">
          {APPEARANCE.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setMode(option.id)}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] transition-colors",
                mode === option.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <HugeiconsIcon icon={option.icon} size={12} strokeWidth={1.75} />
              {t(option.label)}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow title={t("Language")} description={t("Interface language")}>
        <Select
          value={locale}
          onValueChange={(value) => void setLocale(value as Locale)}
        >
          <SelectTrigger value={locale} className="h-7 w-20 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zh" className="text-[11px]">
              中文
            </SelectItem>
            <SelectItem value="en" className="text-[11px]">
              English
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow title={t("UI zoom level")}>
        <div className="flex w-36 items-center gap-2">
          <Slider
            value={[zoomLevel]}
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            onValueChange={(value) => void setZoomLevel(value[0] ?? 1)}
          />
          <span className="w-8 text-right text-[10px] tabular-nums text-muted-foreground">
            {Math.round(zoomLevel * 100)}%
          </span>
        </div>
      </SettingRow>
      <SettingRow
        title={t("Show hidden files")}
        description={t(
          "Include dot-prefixed files and folders (.env, .gitignore, .config) in the file explorer and search.",
        )}
      >
        <Switch
          checked={showHidden}
          onCheckedChange={(value) => void setShowHidden(value)}
        />
      </SettingRow>
    </section>
  );
}
