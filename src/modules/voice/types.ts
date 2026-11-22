export type VoiceScope = "pi" | "codex";

export type VoiceMode = "manual" | "auto";

export type AsrConfig = {
  language: "zh" | "en" | "auto";
  enabled: boolean;
};

export type TtsConfig = {
  voice: string;
  mode: VoiceMode;
  enabled: boolean;
};

export type VoiceScopeView = {
  enabled: boolean;
  asr: AsrConfig;
  tts: TtsConfig;
  hasKey: boolean;
};

export type VoiceConfigView = {
  pi: VoiceScopeView;
  codex: VoiceScopeView;
  path: string;
};

export type VoiceConfigInput = {
  enabled: boolean;
  asr: AsrConfig;
  tts: TtsConfig;
  key?: string;
};

export type VoiceStreamEvent = {
  streamId: number;
  kind: "asr" | "tts";
  text?: string | null;
  audio?: string | null;
  done: boolean;
  error?: string | null;
};

export const VOICE_OPTIONS = [
  ["mimo_default", "默认"],
  ["冰糖", "冰糖"],
  ["茉莉", "茉莉"],
  ["苏打", "苏打"],
  ["白桦", "白桦"],
  ["Mia", "Mia"],
  ["Chloe", "Chloe"],
  ["Milo", "Milo"],
  ["Dean", "Dean"],
] as const;
