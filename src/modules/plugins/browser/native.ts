import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function browserShow(url: string, bounds: BrowserBounds): Promise<void> {
  return invoke("browser_show", { url, bounds });
}

export function browserSetBounds(bounds: BrowserBounds): Promise<void> {
  return invoke("browser_set_bounds", { bounds });
}

export function browserReload(): Promise<void> {
  return invoke("browser_reload");
}

export function browserInspect(): Promise<void> {
  return invoke("browser_inspect");
}

export function browserHide(): Promise<void> {
  return invoke("browser_hide");
}

export function onBrowserTitle(
  handler: (title: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("codev://browser-title", (event) =>
    handler(event.payload),
  );
}
