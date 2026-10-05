import { Switch } from "@/components/ui/switch";
import { useT } from "@/lib/i18n";
import {
  JSON_FORMATTER_PLUGIN_ID,
  PI_AGENT_PLUGIN_ID,
  CODEX_AGENT_PLUGIN_ID,
  BROWSER_PLUGIN_ID,
  TEXT_DIFF_PLUGIN_ID,
  TASKBAR_UNREAD_PLUGIN_ID,
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
  const diffEnabled = usePluginStore(
    (state) => state.enabled[TEXT_DIFF_PLUGIN_ID],
  );
  const piAgentEnabled = usePluginStore(
    (state) => state.enabled[PI_AGENT_PLUGIN_ID],
  );
  const init = usePluginStore((state) => state.init);
  const codexEnabled = usePluginStore(
    (state) => state.enabled[CODEX_AGENT_PLUGIN_ID],
  );
  const browserEnabled = usePluginStore(
    (state) => state.enabled[BROWSER_PLUGIN_ID],
  );
  const taskbarUnreadEnabled = usePluginStore(
    (state) => state.enabled[TASKBAR_UNREAD_PLUGIN_ID],
  );

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
      <SettingRow
        title="Pi Agent"
        description="在右侧工作区运行并恢复 Pi Coding Agent 原生线程。"
      >
        <Switch
          checked={piAgentEnabled}
          onCheckedChange={(value) =>
            void setPluginEnabled(PI_AGENT_PLUGIN_ID, value)
          }
        />
      </SettingRow>
      <SettingRow
        title="Codex"
        description="运行 Codex CLI 原生会话，沿用本机 Codex 配置与认证。"
      >
        <Switch
          checked={codexEnabled}
          onCheckedChange={(value) =>
            void setPluginEnabled(CODEX_AGENT_PLUGIN_ID, value)
          }
        />
      </SettingRow>
      <SettingRow
        title="浏览器"
        description="在右侧插件区打开网页，与文件阅读区分开。默认关闭。"
      >
        <Switch
          checked={browserEnabled}
          onCheckedChange={(value) =>
            void setPluginEnabled(BROWSER_PLUGIN_ID, value)
          }
        />
      </SettingRow>
      <SettingRow
        title={t("Taskbar unread badge")}
        description={t(
          "Show finished Pi and Codex tasks as a count on the app icon. Default on.",
        )}
      >
        <Switch
          checked={taskbarUnreadEnabled}
          onCheckedChange={(value) =>
            void setPluginEnabled(TASKBAR_UNREAD_PLUGIN_ID, value)
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
          checked={diffEnabled}
          onCheckedChange={(value) =>
            void setPluginEnabled(TEXT_DIFF_PLUGIN_ID, value)
          }
        />
      </SettingRow>
    </section>
  );
}
