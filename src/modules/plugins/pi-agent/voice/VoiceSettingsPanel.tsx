import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Copy01Icon,
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
  copyPiVoiceToCodex,
  listVoiceConfig,
  readVoiceSecret,
  saveVoiceConfig,
} from "./native";
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

export function VoiceSettingsPanel() {
  const [value, setValue] = useState<VoiceScopeView | null>(null);
  const [draft, setDraft] = useState<VoiceConfigInput | null>(null);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [path, setPath] = useState("");

  const load = async () => {
    setBusy(true);
    try {
      const all = await listVoiceConfig();
      const next = all[SCOPE];
      setValue(next);
      setDraft(cloneInput(next));
      setPath(all.path);
      setKey(next.hasKey ? await readVoiceSecret(SCOPE) : "");
      setShowKey(false);
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

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
      setValue(next);
      setDraft(cloneInput(next));
      setKey(next.hasKey ? await readVoiceSecret(SCOPE) : "");
      setShowKey(false);
      setMessage("已保存");
      toast.success("Pi 小米语音配置已保存");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };
  const copyToCodex = async () => {
    setBusy(true);
    try {
      await saveVoiceConfig("pi", { ...draft, key });
      const copied = await copyPiVoiceToCodex();
      setMessage(
        copied.codex.enabled
          ? "已同步到 Codex，并保留启用状态"
          : "已同步到 Codex",
      );
      toast.success("Pi 的小米语音配置已同步到 Codex");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reader-scrollbar min-h-0 flex-1 overflow-auto p-3 sm:p-4">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <HugeiconsIcon icon={VolumeHighIcon} size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">小米语音</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            一个 API Key 同时用于流式识别和流式朗读，只在当前 Pi 生效。
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

      <section className="space-y-3 rounded-lg border border-border/70 p-3">
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={Key01Icon} size={14} />
          <h3 className="text-xs font-medium">API Key</h3>
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
        <p className="truncate text-[10px] text-muted-foreground" title={path}>
          {path}
        </p>
      </section>

      <section className="mt-3 space-y-3 rounded-lg border border-border/70 p-3">
        <div className="flex items-center gap-2">
          <h3 className="shrink-0 text-xs font-medium">语音输入</h3>
          <Select
            value={draft.asr.language}
            onValueChange={(language) =>
              updateAsr({ language: language as AsrConfig["language"] })
            }
            disabled={busy || !draft.enabled}
          >
            <SelectTrigger aria-label="识别语言" className="w-28">
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
            className="ml-auto"
            aria-label="启用语音输入"
          />
        </div>
      </section>

      <section className="mt-3 rounded-lg border border-border/70 p-3">
        <div className="flex items-center gap-2">
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
            className="ml-auto"
            aria-label="启用语音播放"
          />
        </div>
      </section>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          <HugeiconsIcon icon={FloppyDiskIcon} size={14} />
          保存
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void load()}
        >
          <HugeiconsIcon icon={Refresh01Icon} size={14} />
          刷新
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void copyToCodex()}
        >
          <HugeiconsIcon icon={Copy01Icon} size={14} />
          保存并同步到 Codex 插件
        </Button>
        {message && (
          <span className="text-[10px] text-muted-foreground">{message}</span>
        )}
      </div>
    </div>
  );
}
