"use client";

import Link from "next/link";
import {
  Activity,
  Bird,
  Cloud,
  MessageSquarePlus,
  RotateCw,
  Trash2,
  WifiOff,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import type { Message } from "@/hooks/use-chat";
import type { LanguageInfo } from "@/lib/api";
import { coverageOf } from "@/lib/coverage";
import { cn } from "@/lib/utils";

export type Thread = {
  id: string;
  title: string;
  at: number;
  messages: Message[];
};

/** Sectors the knowledge base actually covers, matching knowledge.py. */
const SECTORS = [
  "Healthcare",
  "Governance",
  "Education",
  "Rural development",
] as const;

export function ChatSidebar({
  languages,
  language,
  onLanguageChange,
  languagesPending,
  languagesError,
  onRetryLanguages,
  threads,
  activeThread,
  onSelectThread,
  onDeleteThread,
  onNewChat,
  onNavigate,
  cloudTts,
  className,
}: {
  languages: LanguageInfo[];
  language: string;
  onLanguageChange: (code: string) => void;
  /** True while /languages is still in flight. */
  languagesPending: boolean;
  languagesError: string | null;
  onRetryLanguages: () => void;
  threads: Thread[];
  activeThread: string | null;
  onSelectThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
  onNewChat: () => void;
  /** Called after any action that should dismiss the mobile drawer. */
  onNavigate?: () => void;
  /** True when synthesis is going to the remote GPU rather than staying here. */
  cloudTts?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col gap-4 p-4", className)}>
      <div className="flex items-center gap-2.5">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
          aria-hidden
        >
          <Bird className="size-4" />
        </span>
        <span className="font-display text-2xl leading-none">Starling</span>
      </div>

      <Button
        onClick={() => {
          onNewChat();
          onNavigate?.();
        }}
        className="w-full"
      >
        <MessageSquarePlus data-icon="inline-start" />
        New chat
      </Button>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="px-1 pb-2 text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase">
          Your chats
        </p>
        {threads.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">
            Nothing yet. Ask a question to start.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {threads.map((t) => (
              <li key={t.id} className="group/thread relative">
                <button
                  onClick={() => {
                    onSelectThread(t.id);
                    onNavigate?.();
                  }}
                  className={cn(
                    // Padded right to leave room for the delete control, which
                    // sits over the row rather than in it: nesting a button
                    // inside a button is invalid, and a flex sibling would
                    // shorten the title even when the control is hidden.
                    "w-full truncate rounded-md py-2 pr-9 pl-2.5 text-left text-sm transition-colors",
                    t.id === activeThread
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {t.title}
                </button>
                <button
                  onClick={() => onDeleteThread(t.id)}
                  aria-label={`Delete chat: ${t.title}`}
                  title="Delete this chat"
                  className={cn(
                    "absolute inset-y-1 right-1 grid w-7 place-items-center rounded-md text-muted-foreground transition-colors",
                    "hover:bg-destructive/10 hover:text-destructive",
                    // Hidden until wanted on the desktop rail, always visible
                    // on touch, where there is no hover to reveal it.
                    "opacity-100 focus-visible:opacity-100 lg:opacity-0 lg:group-hover/thread:opacity-100",
                  )}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Separator />

      <div className="space-y-2">
        <p className="px-1 text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase">
          Language
        </p>
        {/* Only this block waits on /languages. The rest of the sidebar --
            the wordmark, New chat, the thread list -- needs nothing from the
            service, and blanking all of it behind one skeleton made a busy
            backend look like a frontend that never loaded. */}
        {languagesPending ? (
          <div className="grid grid-cols-2 gap-1.5">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : languagesError ? (
          <div className="space-y-1.5 px-1">
            <p className="text-xs text-muted-foreground">{languagesError}</p>
            <Button variant="outline" size="sm" onClick={onRetryLanguages}>
              <RotateCw data-icon="inline-start" />
              Retry
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {languages.map((l) => {
              const asr = coverageOf(l, "asr");
              return (
                <button
                  key={l.code}
                  onClick={() => {
                    onLanguageChange(l.code);
                    onNavigate?.();
                  }}
                  aria-pressed={l.code === language}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-left transition-colors",
                    l.code === language
                      ? "border-primary/40 bg-primary/10"
                      : "border-border hover:bg-muted/60",
                  )}
                >
                  <span
                    lang={l.iso}
                    className="block truncate text-sm leading-tight"
                  >
                    {l.native_name}
                  </span>
                  <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                    {l.name.split(" / ")[0]}
                    {asr !== "native" && (
                      <span
                        className="text-warning"
                        title="Recognition is limited"
                      >
                        ●
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Separator />

      <div className="space-y-2">
        <p className="px-1 text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase">
          Covers
        </p>
        <div className="flex flex-wrap gap-1">
          {SECTORS.map((s) => (
            <Badge key={s} variant="outline">
              {s}
            </Badge>
          ))}
        </div>
      </div>

      <div className="space-y-2 text-xs text-muted-foreground">
        {/* This claim has to track reality. Recognition, answering and
            translation are always local, but cloud synthesis sends the reply
            text to a GPU, and a health assistant must not keep promising
            privacy it is no longer delivering. */}
        {cloudTts ? (
          <p className="flex items-start gap-1.5 text-warning">
            <Cloud className="mt-px size-3.5 shrink-0" />
            <span>
              Cloud voice is on: reply text is sent to a GPU to be spoken.
              Everything else still runs here.
            </span>
          </p>
        ) : (
          <p className="flex items-center gap-1.5">
            <WifiOff className="size-3.5 shrink-0" />
            Runs offline. Nothing leaves this machine.
          </p>
        )}
        <Button asChild variant="ghost" size="sm" className="w-full justify-start">
          <Link href="/status" onClick={onNavigate}>
            <Activity data-icon="inline-start" />
            Service status
          </Link>
        </Button>
      </div>
    </div>
  );
}
