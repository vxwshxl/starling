"use client";

import { useCallback, useRef, useState } from "react";

import {
  askChat,
  describeError,
  synthesize,
  transcribe,
  type Source,
  type Timings,
} from "@/lib/api";

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** True while the assistant reply is still being generated. */
  pending?: boolean;
  sources?: Source[];
  /** False when the knowledge base did not cover the question. */
  grounded?: boolean;
  warnings?: string[];
  timings?: Timings;
  error?: string;
  /** Set once this message has been spoken, so the audio can be replayed. */
  audioUrl?: string;
  /** True while synthesis is running for this message. */
  speaking?: boolean;
  /** Set when the message came from the microphone rather than typing. */
  spoken?: boolean;
};

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

export function useChat(language: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recorderError, setRecorderError] = useState<string | null>(null);

  const inFlight = useRef<AbortController | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const patch = useCallback((id: string, next: Partial<Message>) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...next } : m)));
  }, []);

  /** Send a question and stream the answer into a placeholder message. */
  const send = useCallback(
    async (question: string, opts?: { spoken?: boolean }) => {
      const text = question.trim();
      if (!text || busy) return;

      const userId = newId();
      const replyId = newId();
      setMessages((ms) => [
        ...ms,
        { id: userId, role: "user", text, spoken: opts?.spoken },
        { id: replyId, role: "assistant", text: "", pending: true },
      ]);
      setBusy(true);

      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      try {
        const { result, timings } = await askChat(
          text,
          language,
          controller.signal,
        );
        patch(replyId, {
          text: result.text,
          pending: false,
          sources: result.sources,
          grounded: result.grounded,
          warnings: result.warnings,
          timings,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        patch(replyId, { pending: false, error: describeError(err) });
      } finally {
        setBusy(false);
      }
    },
    [busy, language, patch],
  );

  /** Speak an assistant message aloud. Explicit, never automatic. */
  const speak = useCallback(
    async (id: string, text: string) => {
      patch(id, { speaking: true, error: undefined });
      try {
        const { url } = await synthesize(text, language);
        patch(id, { audioUrl: url, speaking: false });
        void new Audio(url).play().catch(() => {
          /* autoplay policy can refuse; the player element is still rendered */
        });
      } catch (err) {
        patch(id, { speaking: false, error: describeError(err) });
      }
    },
    [language, patch],
  );

  const stopRecording = useCallback(() => {
    recorder.current?.stop();
    setRecording(false);
  }, []);

  const startRecording = useCallback(async () => {
    setRecorderError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setRecorderError("This browser cannot record audio.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunks.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      mr.onstop = async () => {
        // Release the mic immediately; leaving it open keeps the browser's
        // recording indicator lit and looks like the app is still listening.
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: mr.mimeType });
        if (blob.size === 0) return;
        setBusy(true);
        try {
          const { result } = await transcribe(blob, language);
          const heard = result.text.trim();
          if (!heard) {
            setRecorderError("Nothing was recognised. Try again, closer to the mic.");
            return;
          }
          await send(heard, { spoken: true });
        } catch (err) {
          setRecorderError(describeError(err));
        } finally {
          setBusy(false);
        }
      };
      recorder.current = mr;
      mr.start();
      setRecording(true);
    } catch (err) {
      setRecorderError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone permission was denied."
          : describeError(err),
      );
    }
  }, [language, send]);

  const reset = useCallback(() => {
    inFlight.current?.abort();
    setMessages([]);
    setBusy(false);
    setRecorderError(null);
  }, []);

  return {
    messages,
    busy,
    recording,
    recorderError,
    send,
    speak,
    startRecording,
    stopRecording,
    reset,
  };
}
