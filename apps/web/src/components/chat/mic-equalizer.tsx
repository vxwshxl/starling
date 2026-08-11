"use client";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/** Enough bars to read as a spectrum, few enough to stay legible on a phone. */
const BARS = 32;

/**
 * Live spectrum of what the microphone is hearing.
 *
 * The point is not decoration. Recording is otherwise invisible: the user
 * cannot tell a working microphone from a muted one, a denied permission or a
 * dead pipeline until the transcript comes back empty. Bars that move with
 * their voice answer "is it hearing me?" in the moment, before they have
 * spoken a whole question into nothing.
 *
 * Runs its own rAF loop and writes transforms straight to the DOM. Driving 32
 * bars through React state at 60 fps would re-render the composer 60 times a
 * second to animate something React has no opinion about.
 */
export function MicEqualizer({
  analyser,
  className,
}: {
  /** Null until the microphone stream is live; the bars idle flat until then. */
  analyser: AnalyserNode | null;
  className?: string;
}) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (!analyser) return;

    const spectrum = new Uint8Array(analyser.frequencyBinCount);
    const levels = new Float32Array(BARS);
    let frame = 0;

    const tick = () => {
      analyser.getByteFrequencyData(spectrum);

      // Speech lives in the bottom of the range. Spreading the bars across the
      // full width up to Nyquist would leave two thirds of them permanently
      // flat, which looks like a broken microphone.
      const usable = Math.floor(spectrum.length * 0.45);

      for (let i = 0; i < BARS; i++) {
        const from = Math.floor((i / BARS) * usable);
        const to = Math.max(from + 1, Math.floor(((i + 1) / BARS) * usable));
        let sum = 0;
        for (let j = from; j < to; j++) sum += spectrum[j];
        const target = Math.min(1, (sum / (to - from) / 255) * 1.9);

        // Rise instantly, fall slowly. Symmetric smoothing makes speech look
        // mushy and delayed; this tracks the attack of each syllable and lets
        // the tail decay, which is what reads as "listening".
        levels[i] = target > levels[i] ? target : levels[i] * 0.8 + target * 0.2;

        const el = bars.current[i];
        if (el) el.style.transform = `scaleY(${0.06 + levels[i] * 0.94})`;
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [analyser]);

  return (
    <div
      className={cn("flex h-8 items-center justify-between gap-px", className)}
      aria-hidden
    >
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          // Capped width, spread by justify-between: left to grow freely the
          // bars become fat capsules on a wide composer and stop reading as a
          // spectrum at all.
          className="h-full w-full max-w-[3px] min-w-px flex-1 origin-center rounded-full bg-destructive/70"
          style={{ transform: "scaleY(0.06)" }}
        />
      ))}
    </div>
  );
}
