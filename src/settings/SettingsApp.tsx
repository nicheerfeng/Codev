import { WindowControls } from "@/components/WindowControls";
import { useT } from "@/lib/i18n";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useEffect } from "react";
import { EditorSection } from "./sections/EditorSection";
import { GeneralSection } from "./sections/GeneralSection";
import { PluginsSection } from "./sections/PluginsSection";
import { ThemesSection } from "./sections/ThemesSection";

/** 渲染单页面紧凑设置窗口，避免分页和低频配置分散注意力。 */
export function SettingsApp() {
  const t = useT();
  const init = usePreferencesStore((state) => state.init);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground select-none">
      <header
        data-tauri-drag-region
        className={`flex h-10 shrink-0 items-center border-b border-border/60 bg-card/60 ${
          IS_MAC ? "pr-3 pl-22" : "px-3"
        }`}
      >
        <span className="text-[12px] font-semibold tracking-tight">
          {t("Settings")}
        </span>
        <div className="flex-1" data-tauri-drag-region />
        {USE_CUSTOM_WINDOW_CONTROLS && <WindowControls closeOnly />}
      </header>

      <main className="min-h-0 flex-1 overflow-hidden px-4 py-3 sm:px-5">
        <Tabs defaultValue="general" className="mx-auto flex h-full w-full max-w-[560px] flex-col">
          <TabsList
            variant="line"
            className="h-8 w-full shrink-0 justify-start border-b border-border/60"
          >
            <TabsTrigger value="general" className="flex-none px-3 text-[11px]">
              {t("General")}
            </TabsTrigger>
            <TabsTrigger value="plugins" className="flex-none px-3 text-[11px]">
              {t("Plugins")}
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="general"
            className="min-h-0 flex-1 overflow-y-auto py-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <div className="flex flex-col gap-4">
              <GeneralSection />
              <ThemesSection />
              <EditorSection />
            </div>
          </TabsContent>
          <TabsContent
            value="plugins"
            className="min-h-0 flex-1 overflow-y-auto py-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <PluginsSection />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
