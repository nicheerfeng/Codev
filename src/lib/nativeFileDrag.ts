export type NativeDragDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

export type NativeFileDragPhase = "ignore" | "hover" | "leave" | "drop";

/** 只把带路径的系统文件拖当成落点，选字拖一律忽略。 */
export function createNativeFileDragGate() {
  let active = false;
  return {
    phase(payload: NativeDragDropPayload): NativeFileDragPhase {
      if (payload.type === "enter") {
        active = payload.paths.length > 0;
        return active ? "hover" : "ignore";
      }
      if (payload.type === "over") return active ? "hover" : "ignore";
      if (payload.type === "leave") {
        const was = active;
        active = false;
        return was ? "leave" : "ignore";
      }
      active = false;
      return payload.paths.length > 0 ? "drop" : "ignore";
    },
    reset() {
      active = false;
    },
  };
}
