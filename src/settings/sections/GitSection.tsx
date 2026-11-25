import { Switch } from "@/components/ui/switch";
import { agentClient } from "@/modules/agent/client";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setGitInboxEnabled,
  setGitTreeBadges,
  setGitUiEnabled,
} from "@/modules/settings/store";
import { SettingRow } from "../components/SettingRow";

/** 渲染独立的 Git 与收件箱开关块，位于编辑器设置上方。 */
export function GitSection() {
  const gitUiEnabled = usePreferencesStore((s) => s.gitUiEnabled);
  const gitTreeBadges = usePreferencesStore((s) => s.gitTreeBadges);
  const gitInboxEnabled = usePreferencesStore((s) => s.gitInboxEnabled);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[12px] font-semibold tracking-tight">Git</h2>
      <SettingRow
        title="Git 工具与代理分支感知"
        description="提供工作区顶部按需弹出的 Git 窗口、Agent 分支切换与本轮变更卡片；关闭后完全隐藏以减少注意力干扰。"
      >
        <Switch
          checked={gitUiEnabled}
          onCheckedChange={(value) => {
            void setGitUiEnabled(value);
            void agentClient
              .request("host.policy.set", { gitUiEnabled: value })
              .catch(() => undefined);
          }}
        />
      </SettingRow>
      {gitUiEnabled && (
        <SettingRow
          title="文件树 Git 状态角标"
          description="在文件树中显示 M / A / U 修改角标与目录变动小圆点（默认关闭以保持纯净浏览）。"
        >
          <Switch
            checked={gitTreeBadges}
            onCheckedChange={(value) => void setGitTreeBadges(value)}
          />
        </SettingRow>
      )}
      <SettingRow
        title="右侧 Git 收件箱"
        description="在右侧工具栏显示 GitHub 通知、Issue 与 PR 管理标签。"
      >
        <Switch
          checked={gitInboxEnabled}
          onCheckedChange={(value) => void setGitInboxEnabled(value)}
        />
      </SettingRow>
    </section>
  );
}
