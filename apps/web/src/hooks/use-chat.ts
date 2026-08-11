"use client";

import { useCallback, useRef, useState } from "react";

import {
  askChat,
  describeError,
  synthesize,
  transcribe,
  type ChatKind,
  type Source,
  type Timings,
  type TTSBackend,
} from "@/lib/api";

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** True while the assistant reply is still being generated. */
  pending?: boolean;
  /** The answer before the return translation, shown on demand. Absent when
   *  the conversation was already in English. */
  textEn?: string;
  sources?: Source[];
  /** False when the text did not come from retrieved passages. */
  grounded?: boolean;
  /** Where the answer came from; see ChatKind. */
  kind?: ChatKind;
  warnings?: string[];
  timings?: Timings;
  error?: string;
  /** Set once this message has been spoken, so the audio can be replayed. */
  audioUrl?: string;
  /** Bumped by each completed synthesis so the player starts itself once.
   *  Cleared on restore, or reopening a thread would blare. */
  autoplayToken?: number;
  /** Caveats from the synthesis backend, e.g. that the audio left the machine. */
  ttsWarnings?: string[];
  /** True while synthesis is running for this message. */
  speaking?: boolean;
  /** Set when the message came from the microphone rather than typing. */
  spoken?: boolean;
};

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

export function useChat(language: string, ttsBackend: TTSBackend = "local") {
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recorderError, setRecorderError] = useState<string | null>(null);
  /** Live spectrum of the microphone, for the composer's equaliser. */
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const inFlight = useRef<AbortController | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const audioCtx = useRef<AudioContext | null>(null);

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
          textEn: result.text_en,
          pending: false,
          sources: result.sources,
          grounded: result.grounded,
          kind: result.kind,
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
        const { url, warnings } = await synthesize(text, language, ttsBackend);
        // `autoplay` and NOT a detached `new Audio(url).play()`. That is what
        // caused the double voice: the bare Audio element started playing
        // while <AudioPlayer> mounted its own <audio> for the same clip, and
        // pressing play on the visible one put a second voice over the first
        // with no way to stop the invisible one.
        patch(id, {
          audioUrl: url,
          autoplayToken: Date.now(),
          speaking: false,
          ttsWarnings: warnings,
        });
      } catch (err) {
        patch(id, { speaking: false, error: describeError(err) });
      }
    },
    [language, ttsBackend, patch],
  );

  /** Drop the spectrum tap. Safe to call twice. */
  const closeAnalyser = useCallback(() => {
    setAnalyser(null);
    void audioCtx.current?.close().catch(() => {
      /* already closed */
    });
    audioCtx.current = null;
  }, []);

  const stopRecording = useCallback(() => {
    recorder.current?.stop();
    setRecording(false);
    closeAnalyser();
  }, [closeAnalyser]);

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

      // Tap the same stream the recorder is using, so the bars show what is
      // actually being captured rather than a second, separately-gained take
      // of the microphone. fftSize 512 gives 256 bins -- ample for 32 bars,
      // and cheap enough to run every frame on a fanless machine.
      try {
        const ctx = new AudioContext();
        const node = ctx.createAnalyser();
        node.fftSize = 512;
        node.smoothingTimeConstant = 0.6;
        ctx.createMediaStreamSource(stream).connect(node);
        audioCtx.current = ctx;
        setAnalyser(node);
      } catch {
        // Visualisation is a nicety. If WebAudio refuses, still record.
      }

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      mr.onstop = async () => {
        // Release the mic immediately; leaving it open keeps the browser's
        // recording indicator lit and looks like the app is still listening.
        stream.getTracks().forEach((t) => t.stop());
        closeAnalyser();
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
      closeAnalyser();
      setRecorderError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone permission was denied."
          : describeError(err),
      );
    }
  }, [language, send, closeAnalyser]);

  const reset = useCallback(() => {
    inFlight.current?.abort();
    setMessages([]);
    setBusy(false);
    setRecorderError(null);
  }, []);

  /** Swap in a stored conversation, discarding whatever is on screen. */
  const restore = useCallback((next: Message[]) => {
    inFlight.current?.abort();
    // Nothing in a restored thread is still in flight, so any `pending` or
    // `speaking` flag saved mid-request would otherwise come back as a
    // spinner that never resolves.
    setMessages(
      next.map((m) => ({
        ...m,
        pending: false,
        speaking: false,
        autoplayToken: undefined,
      })),
    );
    setBusy(false);
    setRecorderError(null);
  }, []);

  return {
    messages,
    busy,
    recording,
    recorderError,
    analyser,
    send,
    speak,
    startRecording,
    stopRecording,
    reset,
    restore,
  };
}
