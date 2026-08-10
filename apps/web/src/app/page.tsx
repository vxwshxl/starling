import { Bird } from "lucide-react";

import { LanguageCoverageCard } from "@/components/language-coverage-card";
import { ModeToggle } from "@/components/mode-toggle";
import { ServiceStatusCard } from "@/components/service-status-card";

export default function Home() {
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-5 py-10 sm:px-8 sm:py-14">
      <header className="flex items-start gap-3">
        <span
          className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
          aria-hidden
        >
          <Bird className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Starling</h1>
          <p className="text-sm text-balance text-muted-foreground">
            Speech-to-speech health assistance for Northeast Indian languages,
            answered in your own voice.
          </p>
        </div>
        <ModeToggle />
      </header>

      <main className="flex flex-col gap-8">
        <ServiceStatusCard />
        <LanguageCoverageCard />
      </main>

      <footer className="mt-auto pt-4 text-xs text-muted-foreground">
        Phase 1 — ASR and TTS only, joined end to end so the assistant repeats
        you back in your cloned voice. The pipeline itself is driven from the
        Gradio lab (<code className="font-mono">pnpm lab</code>).
      </footer>
    </div>
  );
}
