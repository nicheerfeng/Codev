import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Mic01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { listVoiceConfig, startVoiceAsr } from "./native";
import { onVoiceEvents } from "./output";
import type { VoiceScopeView } from "./types";

function toWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1)
      view.setUint8(offset + index, text.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, sample * 0x7fff, true);
  }
  return bytes;
}

const SCOPE = "codex" as const;

export function VoiceInputButton({
  disabled,
  onText,
}: {
  disabled?: boolean;
  onText: (text: string) => void;
}) {
  const [config, setConfig] = useState<VoiceScopeView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const capture = useRef<{
    context: AudioContext;
    stream: MediaStream;
    samples: Float32Array[];
  } | null>(null);
  const active = useRef(0);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

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

  useEffect(() => {
    let pending = "";
    const stopListening = onVoiceEvents((event) => {
      if (event.kind !== "asr" || event.streamId !== active.current) return;
      if (event.text) pending += event.text;
      if (event.error) setError(event.error);
      if (event.done) {
        const text = pending.trim();
        pending = "";
        active.current = 0;
        setBusy(false);
        if (text) onTextRef.current(text);
      }
    });
    return () => {
      stopListening();
    };
  }, []);

  const stop = () => {
    const current = capture.current;
    capture.current = null;
    if (!current) {
      setBusy(false);
      return;
    }
    const chunks = current.samples.splice(0);
    const sampleRate = current.context.sampleRate;
    current.stream.getTracks().forEach((track) => track.stop());
    void current.context.close();
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!length) {
      setBusy(false);
      return;
    }
    const merged = new Float32Array(length);
    let offset = 0;
    chunks.forEach((chunk) => {
      merged.set(chunk, offset);
      offset += chunk.length;
    });
    void startVoiceAsr(SCOPE, toWav(merged, sampleRate))
      .then((streamId) => {
        active.current = streamId;
      })
      .catch((failure: unknown) => {
        active.current = 0;
        setBusy(false);
        setError(String(failure));
      });
  };

  const start = async () => {
    setError("");
    const current = await listVoiceConfig()
      .then((value) => value[SCOPE])
      .catch(() => config);
    if (current) setConfig(current);
    if (!current?.enabled || !current.asr.enabled || !current.hasKey) {
      setError("请先在“小米语音”中启用并填写 API Key");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const sink = context.createMediaStreamDestination();
      const processor = context.createScriptProcessor(4096, 1, 1);
      const samples: Float32Array[] = [];
      processor.onaudioprocess = (event) => {
        if (capture.current)
          samples.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(sink);
      capture.current = { context, stream, samples };
      setBusy(true);
    } catch (failure) {
      setError(String(failure));
    }
  };

  return (
    <span className="relative inline-flex">
      <Button
        variant={busy ? "secondary" : "ghost"}
        size="icon-xs"
        disabled={disabled}
        title={busy ? "停止语音输入" : "语音输入"}
        aria-label={busy ? "停止语音输入" : "语音输入"}
        onClick={() => void (busy ? stop() : start())}
      >
        {busy ? (
          <span className="voice-wave" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
        ) : (
          <HugeiconsIcon icon={Mic01Icon} size={14} />
        )}
      </Button>
      {error && (
        <span
          role="status"
          className="pointer-events-none absolute bottom-full left-0 z-30 mb-2 w-56 rounded-lg border border-border bg-popover px-2 py-1.5 text-[10px] text-destructive shadow-md"
        >
          {error}
        </span>
      )}
    </span>
  );
}
