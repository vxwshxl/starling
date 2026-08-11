"use client";

import { useCallback, useMemo, useState } from "react";
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

export function ChatShell() {
  const langs = useLanguages();
  const health = useHealth();

  const [language, setLanguage] = useState("as");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [starting, setStarting] = useState(false);

  const chat = useChat(language);

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
        setThreads((t) => [{ id, title, at: Date.now() }, ...t]);
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
        threads={threads}
        activeThread={activeThread}
        onSelectThread={setActiveThread}
        onNewChat={newChat}
        onNavigate={() => setDrawer(false)}
      />
    ),
    [languages, language, threads, activeThread, newChat],
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {/* Permanent rail from lg up; a drawer below that. */}
      <aside className="hidden w-72 shrink-0 border-r border-border lg:block">
        {langs.phase === "loading" ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          sidebar
        )}
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
          canRecord={canRecord}
          onSend={send}
          onStartRecording={chat.startRecording}
          onStopRecording={chat.stopRecording}
        />
      </div>
    </div>
  );
}
