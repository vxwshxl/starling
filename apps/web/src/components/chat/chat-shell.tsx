"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Menu, Play, Power, Square } from "lucide-react";

import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ChatSidebar, type Thread } from "@/components/chat/chat-sidebar";
import { ModeToggle } from "@/components/mode-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useChat } from "@/hooks/use-chat";
import { useHealth } from "@/hooks/use-health";
import { useLanguages } from "@/hooks/use-languages";
import { loadModel, unloadModel } from "@/lib/api";
import { coverageOf } from "@/lib/coverage";
import { cn } from "@/lib/utils";

/**
 * Where the conversation list lives between reloads.
 *
 * localStorage, not the service: these are the user's own questions, and the
 * whole premise is that nothing leaves the machine. Bumping the suffix is the
 * migration strategy — the stored shape is disposable chat history, not data
 * worth writing a migration for.
 */
const THREADS_KEY = "starling.threads.v1";

function readThreads(): Thread[] {
  try {
    const raw = localStorage.getItem(THREADS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Hand-rolled rather than trusted: this is parsing whatever an older
    // build, or another tab, happened to leave behind.
    return parsed.filter(
      (t): t is Thread =>
        !!t &&
        typeof t === "object" &&
        typeof (t as Thread).id === "string" &&
        typeof (t as Thread).title === "string" &&
        Array.isArray((t as Thread).messages),
    );
  } catch {
    return [];
  }
}

export function ChatShell() {
  const langs = useLanguages();
  const health = useHealth();

  const [language, setLanguage] = useState("as");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [starting, setStarting] = useState(false);

  const chat = useChat(language);

  // Read after mount, never during render: localStorage does not exist on the
  // server, and seeding state from it would hydrate against empty HTML.
  const hydrated = useRef(false);
  useEffect(() => {
    setThreads(readThreads());
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
    } catch {
      /* private mode or quota; history is a convenience, not a requirement */
    }
  }, [threads]);

  // The live conversation is the one in useChat; the thread record is a
  // mirror of it. Keeping the mirror here, rather than making useChat write
  // through to it, is what stops a half-finished reply from being saved
  // under the wrong thread when the user switches mid-request.
  useEffect(() => {
    if (!activeThread) return;
    setThreads((ts) =>
      ts.map((t) =>
        t.id === activeThread
          ? { ...t, messages: chat.messages, at: Date.now() }
          : t,
      ),
    );
  }, [chat.messages, activeThread]);

  const languages = langs.phase === "ready" ? langs.data.languages : [];
  const current = languages.find((l) => l.code === language);
  const languageLabel = current?.name.split(" / ")[0] ?? "your language";
  const canRecord = current ? coverageOf(current, "asr") !== "unavailable" : true;

  // The models the chat actually needs resident to answer and to listen.
  const modelsReady =
    health.state.phase === "up" && health.state.health.models.asr.loaded;

  const send = useCallback(
    (text: string) => {
      // First message names the thread, mirroring how the sidebar reads.
      if (chat.messages.length === 0) {
        const id = `${Date.now()}`;
        const title = text.length > 38 ? `${text.slice(0, 38)}…` : text;
        setThreads((t) => [{ id, title, at: Date.now(), messages: [] }, ...t]);
        setActiveThread(id);
      }
      void chat.send(text);
    },
    [chat],
  );

  const newChat = useCallback(() => {
    chat.reset();
    setActiveThread(null);
  }, [chat]);

  const selectThread = useCallback(
    (id: string) => {
      if (id === activeThread) return;
      const thread = threads.find((t) => t.id === id);
      if (!thread) return;
      chat.restore(thread.messages);
      setActiveThread(id);
    },
    [activeThread, threads, chat],
  );

  const deleteThread = useCallback(
    (id: string) => {
      setThreads((ts) => ts.filter((t) => t.id !== id));
      // Deleting the conversation on screen has to clear the screen too,
      // otherwise the messages stay visible with nothing left to save them to
      // and the next reply resurrects the thread.
      if (id === activeThread) {
        chat.reset();
        setActiveThread(null);
      }
    },
    [activeThread, chat],
  );

  /** Start = warm the models. Stop = free them. */
  const toggleModels = useCallback(async () => {
    setStarting(true);
    try {
      if (modelsReady) {
        await unloadModel("all");
      } else {
        await loadModel("asr", language);
      }
    } catch {
      /* surfaced by the status page; the header stays quiet */
    } finally {
      setStarting(false);
      health.refresh();
    }
  }, [modelsReady, language, health]);

  const sidebar = useMemo(
    () => (
      <ChatSidebar
        languages={languages}
        language={language}
        onLanguageChange={setLanguage}
        languagesPending={langs.phase === "loading"}
        languagesError={langs.phase === "error" ? langs.error : null}
        onRetryLanguages={langs.retry}
        threads={threads}
        activeThread={activeThread}
        onSelectThread={selectThread}
        onDeleteThread={deleteThread}
        onNewChat={newChat}
        onNavigate={() => setDrawer(false)}
      />
    ),
    [languages, language, langs, threads, activeThread, selectThread, deleteThread, newChat],
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {/* Permanent rail from lg up; a drawer below that. */}
      <aside className="hidden w-72 shrink-0 border-r border-border lg:block">
        {sidebar}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4">
          <Sheet open={drawer} onOpenChange={setDrawer}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label="Open menu"
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[85vw] max-w-xs p-0">
              <SheetTitle className="sr-only">Menu</SheetTitle>
              {sidebar}
            </SheetContent>
          </Sheet>

          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm font-medium">
              {current ? (
                <>
                  <span lang={current.iso}>{current.native_name}</span>
                  <span className="ml-2 hidden text-muted-foreground sm:inline">
                    {languageLabel}
                  </span>
                </>
              ) : (
                "Starling"
              )}
            </span>
            {current && coverageOf(current, "asr") !== "native" && (
              <Badge variant="warning" className="hidden sm:inline-flex">
                limited speech
              </Badge>
            )}
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={modelsReady ? "outline" : "default"}
                size="sm"
                onClick={toggleModels}
                disabled={starting || health.state.phase !== "up"}
              >
                {starting ? (
                  <Power className="animate-pulse" data-icon="inline-start" />
                ) : modelsReady ? (
                  <Square data-icon="inline-start" />
                ) : (
                  <Play data-icon="inline-start" />
                )}
                <span className="hidden sm:inline">
                  {starting ? "Working…" : modelsReady ? "Stop" : "Start"}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {modelsReady
                ? "Free the models and release memory"
                : "Load the models so the first question is not slow"}
            </TooltipContent>
          </Tooltip>

          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              health.state.phase === "up"
                ? modelsReady
                  ? "bg-success"
                  : "bg-warning"
                : health.state.phase === "down"
                  ? "bg-destructive"
                  : "bg-muted-foreground/50",
            )}
            title={
              health.state.phase !== "up"
                ? "Speech service unreachable"
                : modelsReady
                  ? "Models resident"
                  : "Models not loaded"
            }
          />

          <ModeToggle />
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <ChatMessages
            messages={chat.messages}
            onSpeak={chat.speak}
            onPickSuggestion={send}
          />
        </main>

        <ChatComposer
          language={language}
          languageLabel={languageLabel}
          busy={chat.busy}
          recording={chat.recording}
          recorderError={chat.recorderError}
          analyser={chat.analyser}
          canRecord={canRecord}
          onSend={send}
          onStartRecording={chat.startRecording}
          onStopRecording={chat.stopRecording}
        />
      </div>
    </div>
  );
}
