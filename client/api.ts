import { useCallback, useEffect, useState } from "react";

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${url}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!response.ok) {
    const body = await response.json();
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json();
}
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function useResource<T>(url?: string, poll = false) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!url) return;
    const endpoint = url;
    const abort = new AbortController();
    async function load() {
      try {
        setData(await api<T>(endpoint, { signal: abort.signal }));
        setError("");
      } catch (failure) {
        if (!abort.signal.aborted) setError(errorMessage(failure));
      }
    }
    void load();
    const interval = poll ? setInterval(() => void load(), 1500) : undefined;
    return () => {
      abort.abort();
      clearInterval(interval);
    };
  }, [url, poll, revision]);
  return { data, error, reload };
}
