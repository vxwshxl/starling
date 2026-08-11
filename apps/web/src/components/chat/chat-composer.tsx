"use client";

import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, CircleAlert, Mic, Square } from "lucide-react";

import { MicEqualizer } from "@/components/chat/mic-equalizer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

function elapsed(ms: number) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function ChatComposer({
  language,
  languageLabel,
  busy,
  recording,
  recorderError,
  analyser,
  canRecord,
  onSend,
  onStartRecording,
  onStopRecording,
}: {
  language: string;
  languageLabel: string;
  busy: boolean;
  recording: boolean;
  recorderError: string | null;
  /** Live microphone spectrum, or null when not recording. */
  analyser: AnalyserNode | null;
  /** False when no recogniser covers this language. */
  canRecord: boolean;
  onSend: (text: string) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
}) {
  const [value, setValue] = useState("");
  const [recordedMs, setRecordedMs] = useState(0);

  // A clock, not a decoration: without it there is no way to tell a two second
  // recording from a twenty second one, and long takes transcribe badly.
  useEffect(() => {
    if (!recording) {
      setRecordedMs(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => setRecordedMs(Date.now() - started), 200);
    return () => clearInterval(id);
  }, [recording]);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!value.trim() || busy) return;
    onSend(value);
    setValue("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter breaks the line. On touch keyboards Enter is
    // usually the only key available, so this must not require a modifier.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="border-t border-border bg-background/80 backdrop-blur">
      <div className="mx-auto w-full max-w-3xl px-4 py-3 sm:px-6 sm:py-4">
        {recorderError && (
          <Alert variant="destructive" className="mb-2">
            <CircleAlert />
            <AlertDescription>{recorderError}</AlertDescription>
          </Alert>
        )}

        <form
          onSubmit={submit}
          className={cn(
            "flex items-end gap-2 rounded-2xl border border-border bg-card p-2 transition-colors",
            recording && "border-destructive/50",
          )}
        >
          {recording ? (
            // The equaliser takes the composer's whole width while recording.
            // Nothing can be typed mid-take anyway, and a live spectrum where
            // the text box was is unmissable — the previous build gave no
            // on-screen sign the microphone was open at all.
            <div className="flex min-w-0 flex-1 items-center gap-3 px-2">
              <span
                className="size-2 shrink-0 animate-pulse rounded-full bg-destructive"
                aria-hidden
              />
              <MicEqualizer analyser={analyser} className="min-w-0 flex-1" />
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {elapsed(recordedMs)}
              </span>
            </div>
          ) : (
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              disabled={busy}
              placeholder={`Ask in ${languageLabel}`}
              aria-label={`Ask a question in ${languageLabel}`}
              className="max-h-40 min-h-9 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
            />
          )}

          <Button
            type="button"
            variant={recording ? "destructive" : "ghost"}
            size="icon"
            disabled={(busy && !recording) || !canRecord}
            onClick={recording ? onStopRecording : onStartRecording}
            title={
              canRecord
                ? recording
                  ? "Stop and transcribe"
                  : "Record a question"
                : "No recogniser covers this language"
            }
            aria-label={recording ? "Stop recording" : "Start recording"}
          >
            {recording ? <Square /> : <Mic />}
          </Button>

          <Button
            type="submit"
            size="icon"
            disabled={!value.trim() || busy || recording}
            aria-label="Send"
          >
            <ArrowUp />
          </Button>
        </form>

        <p className="mt-2 text-center text-xs text-muted-foreground" aria-live="polite">
          {recording ? (
            <span className="text-destructive">
              Listening — speak now, then press stop
            </span>
          ) : (
            <>
              Answers come from a fixed offline knowledge base, not the open
              internet. Not a substitute for a health worker.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
