"use client";

import { useCallback, useEffect, useState } from "react";

import {
  describeError,
  getLanguages,
  type LanguagesResponse,
} from "@/lib/api";

export type LanguagesState =
  | { phase: "loading" }
  | { phase: "ready"; data: LanguagesResponse }
  | { phase: "error"; error: string };

export type UseLanguages = LanguagesState & { retry: () => void };

/**
 * Fetches /languages, retrying on failure.
 *
 * Unlike /health this is not polled: it serves a frozen config dict that only
 * changes when languages.py changes, which means a service restart anyway.
 * But the first attempt lands while the page is loading, which is exactly
 * when a model may be mid-generation and starving the handler, so a single
 * shot that fails would strand the whole sidebar. Hence `retry`, and one
 * automatic attempt behind it.
 */
export function useLanguages(): UseLanguages {
  const [state, setState] = useState<LanguagesState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setState({ phase: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = (retriesLeft: number) => {
      getLanguages(controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setState({ phase: "ready", data });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          if (retriesLeft > 0) {
            timer = setTimeout(() => run(retriesLeft - 1), 2000);
            return;
          }
          setState({ phase: "error", error: describeError(err) });
        });
    };

    run(1);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [attempt]);

  return { ...state, retry };
}
