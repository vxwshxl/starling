"use client";

import { useCallback, useEffect, useState } from "react";

const API =
  process.env.NEXT_PUBLIC_STARLING_API ?? "http://127.0.0.1:8000";

type Health = {
  status: string;
  service: string;
  version: string;
  languages: string[];
  models: {
    device: string;
    asr: { backend: string; model: string; loaded: boolean };
    tts: { model: string; loaded: boolean; sample_rate: number };
  };
};

type Probe =
  | { state: "checking" }
  | { state: "up"; health: Health; latencyMs: number }
  | { state: "down"; error: string };

export default function Home() {
  const [probe, setProbe] = useState<Probe>({ state: "checking" });

  const check = useCallback(async () => {
    setProbe({ state: "checking" });
    const started = performance.now();
    try {
      const res = await fetch(`${API}/health`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const health: Health = await res.json();
      setProbe({
        state: "up",
        health,
        latencyMs: Math.round(performance.now() - started),
      });
    } catch (err) {
      setProbe({
        state: "down",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    void check();
    const id = setInterval(() => void check(), 5000);
    return () => clearInterval(id);
  }, [check]);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 p-8">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Starling</h1>
        <p className="mt-1 text-sm opacity-70">
          Speech-to-speech for Northeast Indian languages
        </p>
      </header>

      <section className="rounded-xl border border-black/10 p-6 dark:border-white/15">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className={`size-2.5 rounded-full ${
              probe.state === "up"
                ? "bg-green-500"
                : probe.state === "down"
                  ? "bg-red-500"
                  : "bg-amber-400"
            }`}
          />
          <h2 className="font-medium">
            {probe.state === "up"
              ? "Speech service is up"
              : probe.state === "down"
                ? "Speech service is not reachable"
                : "Checking…"}
          </h2>
          {probe.state === "up" && (
            <span className="ml-auto text-xs opacity-60">
              {probe.latencyMs} ms
            </span>
          )}
        </div>

        <p className="mt-2 font-mono text-xs opacity-60">{API}/health</p>

        {probe.state === "up" && (
          <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="opacity-60">Device</dt>
            <dd className="font-mono">{probe.health.models.device}</dd>

            <dt className="opacity-60">ASR</dt>
            <dd className="font-mono">
              {probe.health.models.asr.model}{" "}
              <span className="opacity-60">
                ({probe.health.models.asr.loaded ? "loaded" : "not loaded"})
              </span>
            </dd>

            <dt className="opacity-60">TTS</dt>
            <dd className="font-mono">
              {probe.health.models.tts.model}{" "}
              <span className="opacity-60">
                ({probe.health.models.tts.loaded ? "loaded" : "not loaded"},{" "}
                {probe.health.models.tts.sample_rate} Hz)
              </span>
            </dd>

            <dt className="opacity-60">Languages</dt>
            <dd className="font-mono">{probe.health.languages.join(", ")}</dd>
          </dl>
        )}

        {probe.state === "down" && (
          <div className="mt-5 text-sm">
            <p className="opacity-70">{probe.error}</p>
            <p className="mt-3 opacity-70">Start it with:</p>
            <pre className="mt-1 overflow-x-auto rounded-lg bg-black/5 p-3 font-mono text-xs dark:bg-white/10">
              pnpm dev:api
            </pre>
          </div>
        )}
      </section>

      <p className="text-xs opacity-50">
        Phase 1 shell. The pipeline itself lives in the Gradio lab —{" "}
        <code className="font-mono">pnpm lab</code>.
      </p>
    </main>
  );
}
