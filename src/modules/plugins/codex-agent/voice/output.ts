import { useEffect, useState, useSyncExternalStore } from "react";
import { listVoiceConfig, onVoiceStream, startVoiceTts } from "./native";
import type { VoiceScope, VoiceScopeView, VoiceStreamEvent } from "./types";

export type VoiceOutputState = {
  scope: VoiceScope | null;
  status: "idle" | "playing" | "error";
  error: string | null;
};

const SAMPLE_RATE = 24_000;
let state: VoiceOutputState = { scope: null, status: "idle", error: null };
let requestId = 0;
let activeStream = 0;
let playback: PcmPlayer | null = null;
const pendingAudio = new Map<number, Uint8Array[]>();
const finishedStreams = new Set<number>();
const listeners = new Set<() => void>();
const streamHandlers = new Set<(event: VoiceStreamEvent) => void>();
let streamReady: Promise<void> | null = null;

function publish(next: VoiceOutputState) {
  state = next;
  listeners.forEach((listener) => listener());
}

class PcmPlayer {
  private context = new AudioContext({ sampleRate: SAMPLE_RATE });
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private closed = false;
  private onIdle: (() => void) | null = null;

  constructor(onIdle: () => void) {
    this.onIdle = onIdle;
  }

  push(bytes: Uint8Array) {
    if (this.closed || bytes.length < 2) return;
    const length = Math.floor(bytes.length / 2);
    const samples = new Float32Array(length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, length * 2);
    for (let index = 0; index < length; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 0x8000;
    }
    const buffer = this.context.createBuffer(1, length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const start = Math.max(this.context.currentTime + 0.05, this.nextTime);
    source.start(start);
    this.nextTime = start + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.closed && this.sources.size === 0) this.onIdle?.();
    };
  }

  finish() {
    this.closed = true;
    if (this.sources.size === 0) this.onIdle?.();
  }

  stop() {
    this.closed = true;
    this.onIdle = null;
    this.sources.forEach((source) => {
      try {
        source.stop();
      } catch {
        /* already ended */
      }
    });
    this.sources.clear();
    void this.context.close();
  }
}

function decodeAudio(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function ensureStream() {
  streamReady ??= onVoiceStream((event) => {
    streamHandlers.forEach((handler) => handler(event));
  }).then(() => undefined);
  return streamReady;
}

function handlePlayback(event: VoiceStreamEvent) {
  if (event.kind !== "tts" || event.streamId !== activeStream) return;
  if (event.error) {
    playback?.stop();
    playback = null;
    publish({ scope: state.scope, status: "error", error: event.error });
    return;
  }
  if (event.audio) {
    const bytes = decodeAudio(event.audio);
    if (playback) playback.push(bytes);
    else
      pendingAudio.set(event.streamId, [
        ...(pendingAudio.get(event.streamId) ?? []),
        bytes,
      ]);
  }
  if (event.done) {
    if (playback) playback.finish();
    else finishedStreams.add(event.streamId);
  }
}

streamHandlers.add(handlePlayback);

export function stopVoiceOutput() {
  requestId += 1;
  activeStream = 0;
  playback?.stop();
  playback = null;
  publish({ scope: null, status: "idle", error: null });
}

const SCOPE = "codex" as const;

export async function speakVoice(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const current = ++requestId;
  playback?.stop();
  playback = null;
  publish({ scope: SCOPE, status: "playing", error: null });
  await ensureStream();
  try {
    const streamId = await startVoiceTts(SCOPE, trimmed);
    if (current !== requestId) return;
    activeStream = streamId;
    const player = new PcmPlayer(() => {
      if (current === requestId)
        publish({ scope: null, status: "idle", error: null });
    });
    playback = player;
    pendingAudio.get(streamId)?.forEach((chunk) => player.push(chunk));
    pendingAudio.delete(streamId);
    if (finishedStreams.delete(streamId)) player.finish();
  } catch (error) {
    if (current !== requestId) return;
    publish({ scope: SCOPE, status: "error", error: String(error) });
  }
}

export async function speakFinalIfEnabled(text: string, identity: string) {
  const key = `codev.voice.spoken.${SCOPE}`;
  if (sessionStorage.getItem(key) === identity) return;
  const config = await listVoiceConfig();
  const selected = config[SCOPE];
  if (
    !selected.enabled ||
    !selected.tts.enabled ||
    selected.tts.mode !== "auto" ||
    !selected.hasKey
  )
    return;
  sessionStorage.setItem(key, identity);
  await speakVoice(text);
}

export function onVoiceEvents(handler: (event: VoiceStreamEvent) => void) {
  streamHandlers.add(handler);
  void ensureStream();
  return () => streamHandlers.delete(handler);
}

export function useVoiceScopeConfig(): VoiceScopeView | null {
  const [config, setConfig] = useState<VoiceScopeView | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listVoiceConfig()
      .then((value) => {
        if (!cancelled) setConfig(value[SCOPE]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return config;
}

export function useVoiceOutput(): VoiceOutputState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}
