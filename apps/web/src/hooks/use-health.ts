"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { describeError, getHealth, type Health } from "@/lib/api";

export const POLL_INTERVAL_MS = 5000;

export type HealthState =
  | { phase: "loading" }
  | { phase: "up"; health: Health; latencyMs: number }
  | { phase: "down"; error: string };

export type UseHealth = {
  state: HealthState;
  /** True while a poll is in flight that is NOT the first one. */
  refreshing: boolean;
  lastCheckedAt: Date | null;
  refresh: () => void;
};

/**
 * Polls /health every 5s.
 *
 * The phase deliberately does NOT drop back to "loading" on subsequent polls.
 * Doing so would tear the card down and rebuild it twelve times a minute. A
 * poll only ever replaces the phase with its own result, and `refreshing`
 * carries the in-flight signal instead.
 */
export function useHealth(): UseHealth {
  const [state, setState] = useState<HealthState>({ phase: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);

  // Guards against a slow in-flight request resolving after the component has
  // gone away, and against overlapping polls if the service is sluggish.
  const inFlight = useRef<AbortController | null>(null);
  const alive = useRef(true);

  const check = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    setRefreshing(true);
    const started = performance.now();
    try {
      const health = await getHealth(controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setState({
        phase: "up",
        health,
        latencyMs: Math.round(performance.now() - started),
      });
      setLastCheckedAt(new Date());
    } catch (err) {
      if (!alive.current || controller.signal.aborted) return;
      setState({ phase: "down", error: describeError(err) });
      setLastCheckedAt(new Date());
    } finally {
      if (alive.current && !controller.signal.aborted) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void check();
    const id = setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
      inFlight.current?.abort();
    };
  }, [check]);

  return { state, refreshing, lastCheckedAt, refresh: () => void check() };
}
