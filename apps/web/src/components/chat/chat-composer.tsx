"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, CircleAlert, Mic, Square } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function ChatComposer({
  language,
  languageLabel,
  busy,
  recording,
  recorderError,
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
  /** False when no recogniser covers this language. */
  canRecord: boolean;
  onSend: (text: string) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
}) {
  const [value, setValue] = useState("");

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
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={busy}
            placeholder={
              recording
                ? "Listening… press stop when you finish"
                : `Ask in ${languageLabel}`
            }
            aria-label={`Ask a question in ${languageLabel}`}
            className="max-h-40 min-h-9 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
          />

          <Button
            type="button"
            variant={recording ? "destructive" : "ghost"}
            size="icon"
            disabled={busy && !recording}
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
            disabled={!value.trim() || busy}
            aria-label="Send"
          >
            <ArrowUp />
          </Button>
        </form>

        <p className="mt-2 text-center text-xs text-muted-foreground">
          {recording ? (
            <span className="text-destructive">Recording — speak now</span>
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
