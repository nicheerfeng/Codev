/**
 * Lightweight typed event bus bridging `agent_host` WebSocket push events to domain stores
 * (`vcs`, `forge`, etc.) so `agent/store.ts` never imports sibling domain stores directly.
 */

import type { ForgeInboxSnapshot, VcsSnapshot } from "@/modules/vcs/types";

type HostEventMap = {
  "host.snapshot": {
    vcsSnapshots?: VcsSnapshot[];
    forgeInboxes?: ForgeInboxSnapshot[];
  };
  "vcs.changed": { snapshot: VcsSnapshot };
  "forge.updated": { inbox: ForgeInboxSnapshot };
};

type Listener<K extends keyof HostEventMap> = (
  payload: HostEventMap[K],
) => void;

const listeners: {
  [K in keyof HostEventMap]: Set<Listener<K>>;
} = {
  "host.snapshot": new Set(),
  "vcs.changed": new Set(),
  "forge.updated": new Set(),
};

export function onHostEvent<K extends keyof HostEventMap>(
  event: K,
  listener: Listener<K>,
): () => void {
  listeners[event].add(listener);
  return () => {
    listeners[event].delete(listener);
  };
}

export function emitHostEvent<K extends keyof HostEventMap>(
  event: K,
  payload: HostEventMap[K],
): void {
  for (const listener of listeners[event]) {
    try {
      listener(payload);
    } catch (error) {
      console.warn(`[hostEvents] listener error on ${event}:`, error);
    }
  }
}
