"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";

import { cn } from "@/lib/utils";

/** Bars in the waveform. Enough to show phrasing, few enough to stay crisp. */
const BARS = 48;

function clock(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Decode the clip once and reduce it to per-bar peak amplitudes.
 *
 * Real peaks, not a decorative animation: the shape has to match the audio,
 * because its job is to let someone see where the speech is and scrub to it.
 */
async function peaksOf(url: string, signal: AbortSignal): Promise<number[]> {
  const res = await fetch(url, { signal });
  const bytes = await res.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const buffer = await ctx.decodeAudioData(bytes);
    const data = buffer.getChannelData(0);
    const per = Math.floor(data.length / BARS) || 1;
    const out: number[] = [];
    let loudest = 0;
    for (let i = 0; i < BARS; i++) {
      let peak = 0;
      for (let j = i * per; j < (i + 1) * per && j < data.length; j++) {
        const v = Math.abs(data[j]);
        if (v > peak) peak = v;
      }
      out.push(peak);
      if (peak > loudest) loudest = peak;
    }
    // Normalise against the clip's own peak. OmniVoice output sits around 0.5
    // and an un-normalised waveform would be a permanently half-height stub.
    return loudest > 0 ? out.map((p) => p / loudest) : out;
  } finally {
    void ctx.close();
  }
}

/**
 * Playback for a synthesised reply.
 *
 * Replaces `<audio controls>`, which renders as a wide slab of Chrome's own
 * chrome -- its own greys, its own corner radius, its own volume slider -- in
 * the middle of a monochrome chat. This is the same three affordances (play,
 * position, duration) drawn in the app's own language, and the waveform is
 * doing real work: it shows at a glance whether synthesis produced speech or
 * the near-silence failure mode the CPU/MPS notes warn about.
 */
export function AudioPlayer({
  src,
  className,
}: {
  src: string;
  className?: string;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setPeaks(null);
    peaksOf(src, controller.signal)
      .then((p) => {
        if (!controller.signal.aborted) setPeaks(p);
      })
      .catch(() => {
        // Decoding is a nicety; playback still works without the waveform.
        if (!controller.signal.aborted) setPeaks([]);
      });
    return () => controller.abort();
  }, [src]);

  const toggle = useCallback(() => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setPlaying(false));
    else el.pause();
  }, []);

  const seek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = audio.current;
      if (!el || !total) return;
      const box = e.currentTarget.getBoundingClientRect();
      el.currentTime = ((e.clientX - box.left) / box.width) * total;
    },
    [total],
  );

  const progress = total > 0 ? at / total : 0;
  const bars = peaks ?? [];

  return (
    <div
      className={cn(
        "flex w-full max-w-sm items-center gap-3 rounded-xl border border-border bg-card px-3 py-2",
        className,
      )}
    >
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setTotal(e.currentTarget.duration)}
      >
        {/* Synthesised speech of the text shown directly above it. */}
        <track kind="captions" />
      </audio>

      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause" : "Play"}
        className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90"
      >
        {playing ? (
          <Pause className="size-3.5 fill-current" />
        ) : (
          <Play className="size-3.5 translate-x-px fill-current" />
        )}
      </button>

      {peaks === null ? (
        <span className="flex flex-1 items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Loading…
        </span>
      ) : (
        <div
          onClick={seek}
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(at)}
          onKeyDown={(e) => {
            const el = audio.current;
            if (!el) return;
            if (e.key === "ArrowRight") el.currentTime = Math.min(total, at + 5);
            if (e.key === "ArrowLeft") el.currentTime = Math.max(0, at - 5);
          }}
          className="flex h-8 flex-1 cursor-pointer items-center justify-between gap-px"
        >
          {bars.map((p, i) => (
            <span
              key={i}
              // Played bars are solid, unplayed are ghosted -- the progress
              // indicator is the waveform itself rather than a separate line.
              className={cn(
                "w-full max-w-[3px] min-w-px flex-1 rounded-full transition-colors",
                i / BARS <= progress
                  ? "bg-foreground"
                  : "bg-muted-foreground/35",
              )}
              style={{ height: `${Math.max(9, p * 100)}%` }}
            />
          ))}
        </div>
      )}

      <span className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
        {clock(at)}/{clock(total)}
      </span>
    </div>
  );
}
