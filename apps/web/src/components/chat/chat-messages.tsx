"use client";

import { useEffect, useRef } from "react";
import {
  AlertTriangle,
  Bird,
  BookOpen,
  CircleAlert,
  Loader2,
  Mic,
  Volume2,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Message } from "@/hooks/use-chat";
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
}: {
  message: Message;
  onSpeak: (id: string, text: string) => void;
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

            {message.grounded === false && (
              <p className="text-xs text-muted-foreground">
                Not covered by the knowledge base — answered with a fixed
                response rather than a guess.
              </p>
            )}

            {message.sources && <Sources sources={message.sources} />}

            {message.warnings?.map((w) => (
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
              {message.timings?.total_ms != null && (
                <span className="font-mono text-xs text-muted-foreground">
                  {Math.round(message.timings.total_ms)} ms
                </span>
              )}
            </div>

            {message.audioUrl && (
              // eslint-disable-next-line jsx-a11y/media-has-caption -- synthesised speech of the text shown directly above
              <audio controls src={message.audioUrl} className="mt-1 w-full max-w-sm" />
            )}
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
}: {
  messages: Message[];
  onSpeak: (id: string, text: string) => void;
  onPickSuggestion: (q: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  if (messages.length === 0) {
    return <Empty onPick={onPickSuggestion} />;
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
      {messages.map((m) => (
        <Bubble key={m.id} message={m} onSpeak={onSpeak} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
