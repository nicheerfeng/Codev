import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  FloppyDiskIcon,
  Key01Icon,
  Refresh01Icon,
  ViewIcon,
  ViewOffIcon,
  VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingCard,
  SettingRow,
  SettingSectionHeader,
} from "@/modules/agent/SettingPrimitives";
import { listVoiceConfig, readVoiceSecret, saveVoiceConfig } from "./native";
import { notifyVoiceScopeConfigChanged } from "./output";
import {
  VOICE_OPTIONS,
  type AsrConfig,
  type TtsConfig,
  type VoiceConfigInput,
  type VoiceScopeView,
} from "./types";

function cloneInput(value: VoiceScopeView): VoiceConfigInput {
  return {
    enabled: value.enabled,
    asr: { ...value.asr },
    tts: { ...value.tts },
  };
}

const SCOPE = "pi" as const;

export function VoiceSettingsPanel({
  embedded = false,
  onDirtyChange,
}: {
  embedded?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [value, setValue] = useState<VoiceScopeView | null>(null);
  const [draft, setDraft] = useState<VoiceConfigInput | null>(null);
  const [key, setKey] = useState("");
  const [savedKey, setSavedKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [path, setPath] = useState("");
  const dirty =
    !!value &&
    !!draft &&
    (JSON.stringify(draft) !== JSON.stringify(cloneInput(value)) ||
      key !== savedKey);

  const load = async () => {
    setBusy(true);
    try {
      const all = await listVoiceConfig();
      const next = all[SCOPE];
      setValue(next);
      setDraft(cloneInput(next));
      setPath(all.path);
      const secret = next.hasKey ? await readVoiceSecret(SCOPE) : "";
      setKey(secret);
      setSavedKey(secret);
      setShowKey(false);
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load the stored configuration once
  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  if (!value || !draft) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        正在读取小米语音配置…
      </div>
    );
  }

  const updateAsr = (change: Partial<AsrConfig>) => {
    setDraft((current) =>
      current ? { ...current, asr: { ...current.asr, ...change } } : current,
    );
  };
  const updateTts = (change: Partial<TtsConfig>) => {
    setDraft((current) =>
      current ? { ...current, tts: { ...current.tts, ...change } } : current,
    );
  };
  const save = async () => {
    setBusy(true);
    try {
      const all = await saveVoiceConfig(SCOPE, { ...draft, key });
      const next = all[SCOPE];
      notifyVoiceScopeConfigChanged(next);
      setValue(next);
      setDraft(cloneInput(next));
      const secret = next.hasKey ? await readVoiceSecret(SCOPE) : "";
      setKey(secret);
      setSavedKey(secret);
      setShowKey(false);
      setMessage("已保存");
      toast.success("Agent 语音配置已保存");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  if (embedded) {
    return (
      <div className="space-y-4">
        <SettingSectionHeader
          title="小米语音"
          description="一个 API Key 用于桌面 Agent 工作区的流式识别和朗读。"
          actions={
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (
                    !dirty ||
                    window.confirm("有未保存的语音设置，确定刷新？")
                  )
                    void load();
                }}
              >
                <HugeiconsIcon icon={Refresh01Icon} size={14} />
                刷新
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                <HugeiconsIcon icon={FloppyDiskIcon} size={14} />
                保存
              </Button>
            </div>
          }
        />
        <SettingCard>
          <SettingRow
            htmlFor="voice-enabled-switch"
            title="启用小米语音"
            description="开启后可使用下方的流式语音输入与消息朗读。"
            control={
              <Switch
                id="voice-enabled-switch"
                checked={draft.enabled}
                onCheckedChange={(enabled) =>
                  setDraft((current) =>
                    current ? { ...current, enabled } : current,
                  )
                }
                disabled={busy}
                aria-label="启用小米语音"
              />
            }
          />
          <SettingRow
            title="API Key"
            description={
              <span className="font-mono text-[10px]" title={path}>
                {path}
              </span>
            }
          >
            <div className="flex items-center gap-2">
              <Input
                type={showKey ? "text" : "password"}
                value={key}
                placeholder="填写小米 MiMo API Key"
                disabled={busy}
                autoComplete="off"
                onChange={(event) => setKey(event.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                aria-label={showKey ? "隐藏 API Key" : "查看 API Key"}
                title={showKey ? "隐藏 API Key" : "查看 API Key"}
                onClick={() =>
                  void (async () => {
                    if (showKey) {
                      setShowKey(false);
                      return;
                    }
                    if (!key && value.hasKey)
                      setKey(await readVoiceSecret(SCOPE));
                    setShowKey(true);
                  })()
                }
              >
                <HugeiconsIcon
                  icon={showKey ? ViewOffIcon : ViewIcon}
                  size={14}
                />
              </Button>
            </div>
          </SettingRow>
          <SettingRow
            title="语音输入"
            description="在输入框中使用流式语音识别转文字。"
            control={
              <div className="flex items-center gap-2">
                <Select
                  value={draft.asr.language}
                  onValueChange={(language) =>
                    updateAsr({ language: language as AsrConfig["language"] })
                  }
                  disabled={busy || !draft.enabled}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label="识别语言"
                    className="w-24"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="zh">中文</SelectItem>
                    <SelectItem value="en">英文</SelectItem>
                    <SelectItem value="auto">自动检测</SelectItem>
                  </SelectContent>
                </Select>
                <Switch
                  checked={draft.asr.enabled}
                  onCheckedChange={(enabled) => updateAsr({ enabled })}
                  disabled={busy || !draft.enabled}
                  aria-label="启用语音输入"
                />
              </div>
            }
          />
          <SettingRow
            title="语音播放"
            description="开启后，在助手回复下方显示朗读图标按钮。"
            control={
              <div className="flex items-center gap-2">
                <Select
                  value={draft.tts.voice}
                  onValueChange={(voice) => updateTts({ voice })}
                  disabled={busy || !draft.enabled}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label="朗读音色"
                    className="w-24"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VOICE_OPTIONS.map(([id, label]) => (
                      <SelectItem key={id} value={id}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={draft.tts.mode}
                  onValueChange={(mode) =>
                    updateTts({ mode: mode as TtsConfig["mode"] })
                  }
                  disabled={busy || !draft.enabled}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label="播放方式"
                    className="w-28"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">点击播放</SelectItem>
                    <SelectItem value="auto">自动播放</SelectItem>
                  </SelectContent>
                </Select>
                <Switch
                  checked={draft.tts.enabled}
                  onCheckedChange={(enabled) => updateTts({ enabled })}
                  disabled={busy || !draft.enabled}
                  aria-label="启用语音播放"
                />
              </div>
            }
          />
        </SettingCard>
        {message && (
          <p className="text-[11px] text-muted-foreground">{message}</p>
        )}
      </div>
    );
  }

  return (
    <div
      className={
        embedded
          ? "rounded-lg border border-border/70 p-3"
          : "reader-scrollbar min-h-0 flex-1 overflow-auto p-3 sm:p-4"
      }
    >
      <div
        className={
          embedded
            ? "mb-3 flex items-start gap-3"
            : "mb-4 flex items-start gap-3"
        }
      >
        {!embedded && (
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <HugeiconsIcon icon={VolumeHighIcon} size={17} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h2
            className={embedded ? "text-xs font-medium" : "text-sm font-medium"}
          >
            小米语音
          </h2>
          <p
            className={
              embedded
                ? "mt-1 text-[11px] text-muted-foreground"
                : "mt-1 text-xs text-muted-foreground"
            }
          >
            一个 API Key 用于桌面 Agent
            工作区的流式识别和朗读。沿用原有默认语音配置。
          </p>
        </div>
        <Switch
          checked={draft.enabled}
          onCheckedChange={(enabled) =>
            setDraft((current) => (current ? { ...current, enabled } : current))
          }
          disabled={busy}
          aria-label="启用小米语音"
        />
      </div>

      <section className="space-y-2 rounded-lg border border-border/70 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <HugeiconsIcon icon={Key01Icon} size={14} />
          <h3 className="shrink-0 text-xs font-medium">API Key</h3>
          <p
            className="min-w-0 flex-1 truncate text-right text-[10px] text-muted-foreground"
            title={path}
          >
            {path}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type={showKey ? "text" : "password"}
            value={key}
            placeholder="填写小米 MiMo API Key"
            disabled={busy}
            autoComplete="off"
            onChange={(event) => setKey(event.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            aria-label={showKey ? "隐藏 API Key" : "查看 API Key"}
            title={showKey ? "隐藏 API Key" : "查看 API Key"}
            onClick={() =>
              void (async () => {
                if (showKey) {
                  setShowKey(false);
                  return;
                }
                if (!key && value.hasKey) setKey(await readVoiceSecret(SCOPE));
                setShowKey(true);
              })()
            }
          >
            <HugeiconsIcon icon={showKey ? ViewOffIcon : ViewIcon} size={14} />
          </Button>
        </div>
      </section>

      <div className="mt-3 grid grid-cols-1 gap-2">
        <section className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border/70 p-3">
          <h3 className="shrink-0 text-xs font-medium">语音输入</h3>
          <Select
            value={draft.asr.language}
            onValueChange={(language) =>
              updateAsr({ language: language as AsrConfig["language"] })
            }
            disabled={busy || !draft.enabled}
          >
            <SelectTrigger aria-label="识别语言" className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh">中文</SelectItem>
              <SelectItem value="en">英文</SelectItem>
              <SelectItem value="auto">自动检测</SelectItem>
            </SelectContent>
          </Select>
          <Switch
            checked={draft.asr.enabled}
            onCheckedChange={(enabled) => updateAsr({ enabled })}
            disabled={busy || !draft.enabled}
            className="ml-auto shrink-0"
            aria-label="启用语音输入"
          />
        </section>
        <section className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border/70 p-3">
          <h3 className="shrink-0 text-xs font-medium">语音播放</h3>
          <Select
            value={draft.tts.voice}
            onValueChange={(voice) => updateTts({ voice })}
            disabled={busy || !draft.enabled}
          >
            <SelectTrigger aria-label="朗读音色" className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VOICE_OPTIONS.map(([id, label]) => (
                <SelectItem key={id} value={id}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={draft.tts.mode}
            onValueChange={(mode) =>
              updateTts({ mode: mode as TtsConfig["mode"] })
            }
            disabled={busy || !draft.enabled}
          >
            <SelectTrigger aria-label="播放方式" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">点击播放</SelectItem>
              <SelectItem value="auto">自动播放</SelectItem>
            </SelectContent>
          </Select>
          <Switch
            checked={draft.tts.enabled}
            onCheckedChange={(enabled) => updateTts({ enabled })}
            disabled={busy || !draft.enabled}
            className="ml-auto shrink-0"
            aria-label="启用语音播放"
          />
        </section>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          <HugeiconsIcon icon={FloppyDiskIcon} size={14} />
          保存
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            if (!dirty || window.confirm("有未保存的语音设置，确定刷新？"))
              void load();
          }}
        >
          <HugeiconsIcon icon={Refresh01Icon} size={14} />
          刷新
        </Button>
        {message && (
          <span className="text-[10px] text-muted-foreground">{message}</span>
        )}
      </div>
    </div>
  );
}
