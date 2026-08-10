import { ArrowUpRight, Mic, TriangleAlert } from "lucide-react";

import { Tile, TileLabel } from "@/components/tile";
import { Button } from "@/components/ui/button";
import { CardContent, CardHeader } from "@/components/ui/card";
import { LAB_URL } from "@/lib/api";

/** Heights are irregular by hand so the meter reads as speech, not a metronome. */
const LEVELS = [
  0.35, 0.7, 1, 0.5, 0.85, 0.4, 0.95, 0.6, 0.3, 0.75, 1, 0.45, 0.8, 0.35, 0.65,
  0.25,
];

const TABS = [
  { n: "1", name: "ASR", blurb: "Speech in, text out. Nothing else runs." },
  { n: "2", name: "TTS", blurb: "Text plus a voice reference, out comes audio." },
  { n: "3", name: "Round trip", blurb: "Speak, hear yourself in your own voice." },
];

export function LabTile() {
  return (
    <Tile
      delay={60}
      // Explicitly placed rather than left to auto-flow: it has to occupy the
      // whole right rail beside the three stacked left tiles, and DOM order
      // alone will not put it there.
      className="col-span-full bg-primary/[0.06] lg:col-span-2 lg:col-start-5 lg:row-span-3 lg:row-start-1"
    >
      <CardHeader>
        <TileLabel icon={<Mic className="size-3" />}>The lab</TileLabel>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-5">
        <div className="space-y-3">
          <p className="font-display text-3xl leading-[1.1] tracking-tight text-balance">
            Record or upload, and hear yourself answered back in your own voice.
          </p>
          <p className="text-sm text-muted-foreground text-pretty">
            Recording lives in the Gradio lab — the debugging surface, with
            per-stage timings and full tracebacks. This dashboard is the status
            face.
          </p>
        </div>

        <ol className="space-y-2.5">
          {TABS.map((tab) => (
            <li key={tab.n} className="flex gap-2.5 text-sm">
              <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded bg-primary/15 font-mono text-[0.6875rem] text-primary">
                {tab.n}
              </span>
              <span className="min-w-0">
                <span className="font-medium">{tab.name}</span>{" "}
                <span className="text-muted-foreground text-pretty">
                  {tab.blurb}
                </span>
              </span>
            </li>
          ))}
        </ol>

        <div className="mt-auto space-y-3 pt-1">
          <div className="flex items-end justify-between gap-4 border-t border-border pt-4">
            <div className="flex h-8 items-end gap-[3px]" aria-hidden>
              {LEVELS.map((scale, i) => (
                <span
                  key={i}
                  className="level-bar w-1 rounded-full bg-primary/50"
                  style={{
                    height: `${scale * 100}%`,
                    animationDelay: `${i * 90}ms`,
                  }}
                />
              ))}
            </div>
            <code className="truncate font-mono text-xs text-muted-foreground">
              {LAB_URL.replace(/^https?:\/\//, "")}
            </code>
          </div>

          <Button asChild size="lg" className="w-full">
            <a href={LAB_URL} target="_blank" rel="noreferrer">
              Open the lab
              <ArrowUpRight data-icon="inline-end" />
            </a>
          </Button>

          <p className="flex gap-2 text-xs text-muted-foreground">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
            <span className="text-pretty">
              Start it with <code className="font-mono">pnpm lab</code>. First
              run downloads several GB of weights and looks frozen — watch the
              terminal.
            </span>
          </p>
        </div>
      </CardContent>
    </Tile>
  );
}
