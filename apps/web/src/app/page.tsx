import { Bird } from "lucide-react";

import { HealthTiles } from "@/components/health-tiles";
import { LabTile } from "@/components/lab-tile";
import { LanguageTiles } from "@/components/language-tiles";
import { ModeToggle } from "@/components/mode-toggle";

export default function Home() {
  return (
    <div className="relative min-h-screen">
      {/* Faint dot grid over the accent washes in globals.css. Fixed, so the
          panel appears to sit on a surface rather than scroll with one. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 text-foreground/10 opacity-[0.35] [background-image:radial-gradient(currentColor_1px,transparent_1px)] [background-size:22px_22px]"
      />

      <div className="mx-auto w-full max-w-[92rem] px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
        <header className="tile-rise mb-6 flex items-start gap-4 lg:mb-8">
          <span
            className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"
            aria-hidden
          >
            <Bird className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-4xl leading-none tracking-tight lg:text-5xl">
              Starling
            </h1>
            <p className="mt-1.5 max-w-prose text-sm text-pretty text-muted-foreground">
              Speech-to-speech health assistance for Northeast Indian languages,
              answered in your own voice.
            </p>
          </div>
          <ModeToggle />
        </header>

        <main className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-6">
          <HealthTiles />
          <LabTile />
          <LanguageTiles />
        </main>

        <footer className="tile-rise mt-8 text-xs text-muted-foreground [animation-delay:360ms]">
          Phase 1 — ASR and TTS only, joined end to end so the assistant repeats
          you back in your cloned voice. Translation, retrieval and the LLM slot
          in at the <code className="font-mono">PHASE 2 SEAM</code>.
        </footer>
      </div>
    </div>
  );
}
