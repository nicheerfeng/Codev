import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const commands = new Map<string, Promise<unknown>>();
function send(
  command: string,
  id: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  const next = (commands.get(id) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => invoke<void>(command, { ...args, id }));
  commands.set(id, next);
  void next
    .finally(() => {
      if (commands.get(id) === next) commands.delete(id);
    })
    .catch(() => undefined);
  return next;
}

export type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export function browserShow(
  url: string,
  bounds: BrowserBounds,
  id = "default",
  navigate = false,
): Promise<void> {
  return send("browser_show", id, { url, bounds, navigate });
}
export function browserSetBounds(
  bounds: BrowserBounds,
  id = "default",
): Promise<void> {
  return send("browser_set_bounds", id, { bounds });
}
export function browserReload(id = "default"): Promise<void> {
  return send("browser_reload", id);
}
export function browserInspect(id = "default"): Promise<void> {
  return send("browser_inspect", id);
}
export function browserHide(id = "default"): Promise<void> {
  return send("browser_hide", id);
}
export function browserClose(id = "default"): Promise<void> {
  return send("browser_close", id);
}
export function onBrowserTitle(
  handler: (title: string) => void,
  id = "default",
): Promise<UnlistenFn> {
  return listen<{ id: string; title: string }>(
    "codev://browser-title",
    (event) => {
      if (event.payload.id === id) handler(event.payload.title);
    },
  );
}
