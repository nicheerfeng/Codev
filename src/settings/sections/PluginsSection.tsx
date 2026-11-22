import { useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/lib/i18n";
import {
  AGENT_HOST_PLUGIN_ID,
  JSON_FORMATTER_PLUGIN_ID,
  TEXT_DIFF_PLUGIN_ID,
  TASKBAR_UNREAD_PLUGIN_ID,
  setPluginEnabled,
  usePluginStore,
} from "@/modules/plugins";
import { SettingRow } from "../components/SettingRow";

export function PluginsSection() {
  const t = useT();
  const enabled = usePluginStore((s) => s.enabled);
  const init = usePluginStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[12px] font-semibold tracking-tight">
        {t("Plugins")}
      </h2>
      <SettingRow
        title="Agent 工作区"
        description="统一的 Rust 代理主机，支持 Pi 原生会话、独立代理与手机连接。"
      >
        <Switch
          checked={enabled[AGENT_HOST_PLUGIN_ID]}
          onCheckedChange={(value) =>
            void setPluginEnabled(AGENT_HOST_PLUGIN_ID, value)
          }
        />
      </SettingRow>
      <SettingRow
        title={t("JSON/JSONL Formatter")}
        description={t(
          "Paste JSON or JSONL into an independent formatter page, then search and compare it.",
        )}
      >
        <Switch
          checked={enabled[JSON_FORMATTER_PLUGIN_ID]}
          onCheckedChange={(value) =>
            void setPluginEnabled(JSON_FORMATTER_PLUGIN_ID, value)
          }
        />
      </SettingRow>
      <SettingRow
        title={t("Text Diff")}
        description={t(
          "Compare two texts in aligned editors with automatic difference highlighting.",
        )}
      >
        <Switch
          checked={enabled[TEXT_DIFF_PLUGIN_ID]}
          onCheckedChange={(value) =>
            void setPluginEnabled(TEXT_DIFF_PLUGIN_ID, value)
          }
        />
      </SettingRow>
      <SettingRow
        title={t("Taskbar unread badge")}
        description="在应用图标显示已完成、尚未查看的代理任务数量。"
      >
        <Switch
          checked={enabled[TASKBAR_UNREAD_PLUGIN_ID]}
          onCheckedChange={(value) =>
            void setPluginEnabled(TASKBAR_UNREAD_PLUGIN_ID, value)
          }
        />
      </SettingRow>
    </section>
  );
}
