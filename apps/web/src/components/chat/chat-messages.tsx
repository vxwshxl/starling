"use client";

import { useEffect, useRef } from "react";
import {
  AlertTriangle,
  Bird,
  BookOpen,
  BrainCircuit,
  CircleAlert,
  Cloud,
  Languages,
  Loader2,
  Mic,
  Volume2,
} from "lucide-react";

import { AudioPlayer } from "@/components/chat/audio-player";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Message } from "@/hooks/use-chat";
import type { TTSBackend } from "@/lib/api";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  "My child has loose motion since morning",
  "How do I apply for a job card?",
  "Is school free for my daughter?",
  "How do I make drinking water safe?",
];

function Empty({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 px-4 py-10 text-center sm:py-16">
      <span
        className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground"
        aria-hidden
      >
        <Bird className="size-6" />
      </span>
      <div className="space-y-2">
        <h1 className="font-display text-3xl leading-tight text-balance sm:text-4xl">
          How can I help you today?
        </h1>
        <p className="text-sm text-pretty text-muted-foreground">
          Ask about health, government services, education or rural
          livelihoods. Type, or hold the microphone and speak.
        </p>
      </div>
      <div className="grid w-full gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="rounded-lg border border-border px-3 py-2.5 text-left text-sm text-pretty transition-colors hover:bg-muted/60"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Roughly how long synthesis will take, so the wait is a number rather than a
 * hang.
 *
 * Both constants are measured on this machine, not guessed. Speech runs about
 * 14 characters per second of audio (a 1180-character Assamese reply came out
 * at 83.8 s), and synthesis costs a fixed multiple of the audio length: 6.05x
 * on the CPU at 8 denoising steps, 0.41x on the Modal GPU. The CPU figure is
 * the one that matters — a long answer is minutes, and saying "about 30 s"
 * there, as this used to, is how a user concludes the app has frozen.
 */
function synthesisEstimate(chars: number, backend: TTSBackend): string {
  const audioSeconds = chars / 14;
  const seconds = Math.round(audioSeconds * (backend === "modal" ? 0.41 : 6.05));
  if (backend === "modal") {
    return seconds < 20
      ? "a few seconds — on the cloud GPU"
      : `about ${seconds}s — on the cloud GPU`;
  }
  if (seconds < 90) return `about ${seconds}s — OmniVoice runs on this CPU`;
  return `about ${Math.round(seconds / 60)} min on this CPU — switch to Cloud GPU for ~${Math.max(
    1,
    Math.round(audioSeconds * 0.41),
  )}s`;
}

function Sources({ sources }: { sources: NonNullable<Message["sources"]> }) {
  if (sources.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
      <BookOpen className="size-3 text-muted-foreground" aria-hidden />
      <span className="sr-only">Answer based on:</span>
      {sources.map((s) => (
        <Badge key={s.id} variant="outline" title={`${s.sector} · score ${s.score}`}>
          {s.title}
        </Badge>
      ))}
    </div>
  );
}

function Bubble({
  message,
  onSpeak,
  showWarnings,
  ttsBackend,
}: {
  message: Message;
  onSpeak: (id: string, text: string) => void;
  /** Warnings already shown earlier in the thread are suppressed here. */
  showWarnings: string[];
  ttsBackend: TTSBackend;
}) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[85%] items-start gap-2 sm:max-w-[75%]">
          {message.spoken && (
            <Mic className="mt-2 size-3.5 shrink-0 text-muted-foreground" aria-label="Spoken" />
          )}
          <div className="rounded-2xl rounded-br-sm bg-primary px-3.5 py-2.5 text-sm text-pretty text-primary-foreground">
            {message.text}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <span
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary"
        aria-hidden
      >
        <Bird className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        {message.pending ? (
          <p className="flex items-center gap-2 py-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Thinking…
          </p>
        ) : message.error ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{message.error}</AlertDescription>
          </Alert>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-pretty whitespace-pre-wrap">
              {message.text}
            </p>

            {/* A greeting is ungrounded too, and labelling it would be absurd.
                Only a general-knowledge answer gets the caveat, because that
                is the one with nothing behind it. */}
            {message.kind === "general" && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <BrainCircuit className="mt-px size-3.5 shrink-0" aria-hidden />
                <span>
                  Not in the knowledge base — answered from the model&apos;s own
                  knowledge, with no source behind it. Check anything that
                  matters with a health worker or your gram panchayat.
                </span>
              </p>
            )}

            {message.sources && <Sources sources={message.sources} />}

            {/* The English the model actually reasoned in. Collapsed, because
                the point of the product is that you never need it -- but when
                a translated answer looks wrong, this is the only way to tell a
                bad answer from a bad translation. */}
            {message.textEn && message.textEn !== message.text && (
              <details className="group/en">
                <summary className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <Languages className="size-3.5" aria-hidden />
                  Show the English it was written in
                </summary>
                <p className="mt-1.5 border-l-2 border-border pl-2.5 text-xs leading-relaxed text-muted-foreground">
                  {message.textEn}
                </p>
              </details>
            )}

            {showWarnings.map((w) => (
              <Alert key={w} variant="warning">
                <AlertTriangle />
                <AlertDescription>{w}</AlertDescription>
              </Alert>
            ))}

            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <Button
                variant="ghost"
                size="xs"
                disabled={message.speaking}
                onClick={() => onSpeak(message.id, message.text)}
              >
                {message.speaking ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Volume2 />
                )}
                {message.speaking ? "Synthesising…" : "Speak"}
              </Button>
              {message.speaking && (
                <span className="text-xs text-muted-foreground">
                  {synthesisEstimate(message.text.length, ttsBackend)}
                </span>
              )}
              {/* A refusal costs a fraction of a millisecond, and "0 ms" next
                  to an answer reads as a stopwatch that failed rather than as
                  work that never happened. */}
              {message.timings?.total_ms != null &&
                message.timings.total_ms >= 1 && (
                  <span className="font-mono text-xs text-muted-foreground">
                    {Math.round(message.timings.total_ms)} ms
                  </span>
                )}
            </div>

            {message.audioUrl && (
              <AudioPlayer
                src={message.audioUrl}
                autoplayToken={message.autoplayToken}
                className="mt-1"
              />
            )}

            {message.ttsWarnings?.map((w) => (
              <p
                key={w}
                className="flex items-start gap-1.5 text-xs text-warning"
              >
                <Cloud className="mt-px size-3.5 shrink-0" aria-hidden />
                <span>{w}</span>
              </p>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export function ChatMessages({
  messages,
  onSpeak,
  onPickSuggestion,
  ttsBackend,
}: {
  messages: Message[];
  onSpeak: (id: string, text: string) => void;
  onPickSuggestion: (q: string) => void;
  ttsBackend: TTSBackend;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  if (messages.length === 0) {
    return <Empty onPick={onPickSuggestion} />;
  }

  // The translation caveat is a property of the language, not of the reply, so
  // every single answer carries it. Shown on all of them it becomes wallpaper
  // and stops being read; shown on its first appearance it is still a warning.
  const seen = new Set<string>();

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
      {messages.map((m) => {
        const fresh = (m.warnings ?? []).filter((w) => !seen.has(w));
        fresh.forEach((w) => seen.add(w));
        return (
          <Bubble
            key={m.id}
            message={m}
            onSpeak={onSpeak}
            showWarnings={fresh}
            ttsBackend={ttsBackend}
          />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
