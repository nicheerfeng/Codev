/**
 * Unified client-side storage layer with registered keys and safe JSON helpers.
 * Consolidates scattered `localStorage` access into a single typed façade so UI
 * preferences and caches stay predictable, testable, and safe under restricted contexts.
 */

export const STORAGE_KEYS = {
  agentSelected: "codev.agent.selected",
  agentDrafts: "codev.agent.drafts",
  agentTemporarySessions: "codev.agent.temporarySessions",
  agentWorkspaceOrder: "codev.agent.workspaceOrder",
  agentSessionOrder: "codev.agent.sessionOrder",
  agentProjectOrganization: "codev.agent.projectOrganization",
  agentSidebarWidth: "codev.agent.sidebar.width",
  agentWelcomeDismissed: "codev.agent.welcomeDismissed",
  agentNotify: "codev.agent.notify",
  agentDeviceToken: "codev.agent.deviceToken",
  agentPromptHistoryPrefix: "codev.agent.prompts:",
} as const;

export function readString(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function readNullableString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore quota / restricted storage errors */
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore restricted storage errors */
  }
}

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota / restricted storage errors */
  }
}
