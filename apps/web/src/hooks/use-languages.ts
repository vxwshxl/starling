"use client";

import { useEffect, useState } from "react";

import {
  describeError,
  getLanguages,
  type LanguagesResponse,
} from "@/lib/api";

export type LanguagesState =
  | { phase: "loading" }
  | { phase: "ready"; data: LanguagesResponse }
  | { phase: "error"; error: string };

/**
 * Fetches /languages once.
 *
 * Unlike /health this is not polled: it serves a frozen config dict that only
 * changes when languages.py changes, which means a service restart anyway.
 */
export function useLanguages(): LanguagesState {
  const [state, setState] = useState<LanguagesState>({ phase: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    getLanguages(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ phase: "ready", data });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setState({ phase: "error", error: describeError(err) });
        }
      });

    return () => controller.abort();
  }, []);

  return state;
}
