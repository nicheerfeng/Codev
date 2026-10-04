import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  VoiceConfigInput,
  VoiceConfigView,
  VoiceScope,
  VoiceStreamEvent,
} from "./types";

export const VOICE_EVENT = "codev://voice";

export function listVoiceConfig(): Promise<VoiceConfigView> {
  return invoke<VoiceConfigView>("voice_config_list");
}

export function readVoiceSecret(scope: VoiceScope): Promise<string> {
  return invoke<string>("voice_config_read_secret", { scope });
}

export function saveVoiceConfig(
  scope: VoiceScope,
  input: VoiceConfigInput,
): Promise<VoiceConfigView> {
  return invoke<VoiceConfigView>("voice_config_save", { scope, input });
}

export function copyPiVoiceToCodex(): Promise<VoiceConfigView> {
  return invoke<VoiceConfigView>("voice_config_copy_to_codex");
}

export function startVoiceAsr(
  scope: VoiceScope,
  audio: Uint8Array,
): Promise<number> {
  return invoke<number>("voice_asr_start", {
    scope,
    audio: Array.from(audio),
  });
}

export function startVoiceTts(
  scope: VoiceScope,
  text: string,
): Promise<number> {
  return invoke<number>("voice_tts_start", { scope, text });
}

export function onVoiceStream(
  handler: (event: VoiceStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<VoiceStreamEvent>(VOICE_EVENT, (event) =>
    handler(event.payload),
  );
}
