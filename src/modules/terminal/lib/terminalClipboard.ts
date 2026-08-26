// Linux and Windows use the native clipboard first; the web clipboard remains
// available for macOS and as a fallback when native IPC fails.
const USE_NATIVE_CLIPBOARD =
  typeof navigator !== "undefined" &&
  /(Linux|Windows)/.test(navigator.userAgent) &&
  !/Android/.test(navigator.userAgent);

function webClipboard(): Clipboard | null {
  if (typeof navigator === "undefined") return null;
  return navigator.clipboard ?? null;
}

export async function readTerminalClipboard(): Promise<string> {
  let nativeError: unknown = null;
  if (USE_NATIVE_CLIPBOARD) {
    try {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return await readText();
    } catch (error) {
      nativeError = error;
    }
  }
  try {
    const clipboard = webClipboard();
    if (!clipboard) throw new Error("Web Clipboard API unavailable");
    return await clipboard.readText();
  } catch (webError) {
    console.error("Failed to read terminal clipboard", {
      nativeError,
      webError,
    });
    return "";
  }
}

export async function writeTerminalClipboard(text: string): Promise<void> {
  let nativeError: unknown = null;
  if (USE_NATIVE_CLIPBOARD) {
    try {
      const { writeText } = await import(
        "@tauri-apps/plugin-clipboard-manager"
      );
      await writeText(text);
      return;
    } catch (error) {
      nativeError = error;
    }
  }
  try {
    const clipboard = webClipboard();
    if (!clipboard) throw new Error("Web Clipboard API unavailable");
    await clipboard.writeText(text);
  } catch (webError) {
    console.error("Failed to write terminal clipboard", {
      nativeError,
      webError,
    });
  }
}
