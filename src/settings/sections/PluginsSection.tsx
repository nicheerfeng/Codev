import { Switch } from "@/components/ui/switch";
import { useT } from "@/lib/i18n";
import {
  JSON_FORMATTER_PLUGIN_ID,
  setPluginEnabled,
  usePluginStore,
} from "@/modules/plugins";
import { useEffect } from "react";
import { SettingRow } from "../components/SettingRow";

/** 渲染独立插件开关，插件状态不进入常规设置文件。 */
export function PluginsSection() {
  const t = useT();
  const enabled = usePluginStore(
    (state) => state.enabled[JSON_FORMATTER_PLUGIN_ID],
  );
  const init = usePluginStore((state) => state.init);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[12px] font-semibold tracking-tight">
        {t("Plugins")}
      </h2>
      <SettingRow
        title={t("JSON/JSONL Formatter")}
        description={t(
          "Paste JSON or JSONL into an independent formatter page, then search and compare it.",
        )}
      >
        <Switch
          checked={enabled}
          onCheckedChange={(value) =>
            void setPluginEnabled(JSON_FORMATTER_PLUGIN_ID, value)
          }
        />
      </SettingRow>
    </section>
  );
}
