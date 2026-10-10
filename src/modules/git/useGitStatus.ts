import { useCallback, useEffect, useRef, useState } from "react";
import { gitSnapshot, type GitSnapshot } from "./native";

const cache = new Map<string, { value: GitSnapshot | null; expires: number }>();
const pending = new Map<string, Promise<GitSnapshot | null>>();

export function invalidateGitStatus(root: string) {
  cache.delete(root);
}

export function cachedGitStatus(root: string) {
  return cache.get(root)?.value ?? null;
}

/** One local read per root; switching views reuses recent state, never fetches. */
export function readGitStatus(
  root: string,
  force = false,
): Promise<GitSnapshot | null> {
  const running = pending.get(root);
  if (running) return running;
  const entry = cache.get(root);
  if (!force && entry && entry.expires > Date.now())
    return Promise.resolve(entry.value);
  const request = gitSnapshot(root)
    .then((value) => {
      cache.delete(root);
      cache.set(root, {
        value,
        expires: Date.now() + (value ? 5_000 : 30_000),
      });
      if (cache.size > 40) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return value;
    })
    .finally(() => pending.delete(root));
  pending.set(root, request);
  return request;
}

export function useGitStatus(root: string | null) {
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(() =>
    root ? cachedGitStatus(root) : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);

  const refresh = useCallback(
    async (force = true) => {
      const id = ++version.current;
      if (!root) {
        setSnapshot(null);
        setError("");
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const next = await readGitStatus(root, force);
        if (id === version.current) setSnapshot(next);
      } catch (failure) {
        if (id === version.current) setError(String(failure));
      } finally {
        if (id === version.current) setLoading(false);
      }
    },
    [root],
  );

  useEffect(() => {
    setSnapshot(root ? cachedGitStatus(root) : null);
    void refresh(false);
    const focus = () => void refresh(false);
    window.addEventListener("focus", focus);
    return () => {
      version.current++;
      window.removeEventListener("focus", focus);
    };
  }, [root, refresh]);
  return { snapshot, loading, error, refresh };
}
