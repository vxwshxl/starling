"use client";

import Link from "next/link";
import { Activity, Bird, MessageSquarePlus, WifiOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { LanguageInfo } from "@/lib/api";
import { coverageOf } from "@/lib/coverage";
import { cn } from "@/lib/utils";

export type Thread = { id: string; title: string; at: number };

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
  threads,
  activeThread,
  onSelectThread,
  onNewChat,
  onNavigate,
  className,
}: {
  languages: LanguageInfo[];
  language: string;
  onLanguageChange: (code: string) => void;
  threads: Thread[];
  activeThread: string | null;
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
  /** Called after any action that should dismiss the mobile drawer. */
  onNavigate?: () => void;
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
              <li key={t.id}>
                <button
                  onClick={() => {
                    onSelectThread(t.id);
                    onNavigate?.();
                  }}
                  className={cn(
                    "w-full truncate rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                    t.id === activeThread
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {t.title}
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
                    <span className="text-warning" title="Recognition is limited">
                      ●
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
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
        <p className="flex items-center gap-1.5">
          <WifiOff className="size-3.5 shrink-0" />
          Runs offline. Nothing leaves this machine.
        </p>
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
