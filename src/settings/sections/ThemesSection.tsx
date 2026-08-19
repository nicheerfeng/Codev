import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useTheme } from "@/modules/theme";
import { listBuiltinThemes } from "@/modules/theme/themes";
import { useMemo } from "react";
import { SettingRow } from "../components/SettingRow";

/** 渲染紧凑的主题选择，仅保留少量高区分度主题。 */
export function ThemesSection() {
  const t = useT();
  const { themeId, setThemeId, resolvedMode, customThemes } = useTheme();
  const themes = useMemo(
    () => [...listBuiltinThemes(), ...customThemes],
    [customThemes],
  );

  return (
    <SettingRow
      title={t("Theme")}
      description={t("Choose the app and editor color palette.")}
      className="items-center"
    >
      <div className="flex max-w-[300px] flex-wrap justify-end gap-1.5">
        {themes.map((theme) => {
          const variant =
            theme.variants[resolvedMode] ??
            theme.variants.dark ??
            theme.variants.light;
          const colors = variant?.colors;
          const selected = themeId === theme.id;
          return (
            <button
              key={theme.id}
              type="button"
              title={theme.name}
              aria-pressed={selected}
              onClick={() => setThemeId(theme.id)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors",
                selected
                  ? "border-foreground/60 bg-accent text-accent-foreground"
                  : "border-border/60 hover:border-foreground/40 hover:bg-muted/60",
              )}
            >
              <span
                className="size-3 rounded-full border border-foreground/20"
                style={{
                  background: colors?.primary ?? "var(--primary)",
                }}
              />
              <span className="max-w-24 truncate">{t(theme.name)}</span>
            </button>
          );
        })}
      </div>
    </SettingRow>
  );
}
