import { useEffect, useState } from "react";
import type { Timeseries } from "../lib/contract";
import { useApp } from "../store/appStore";

/** One site's one-year visibility series (cached by the data store), with its error and a retry. */
export function useTimeseries(siteId: string | undefined): { ts: Timeseries | null; error: unknown; retry(): void } {
  const data = useApp((s) => s.data);
  const [loaded, setLoaded] = useState<{ siteId: string; ts: Timeseries } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!siteId) return;
    let alive = true;
    setError(null);
    data
      .timeseries(siteId)
      .then((ts) => alive && setLoaded({ siteId, ts }))
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [siteId, data, attempt]);

  return { ts: loaded && loaded.siteId === siteId ? loaded.ts : null, error, retry: () => setAttempt((n) => n + 1) };
}
