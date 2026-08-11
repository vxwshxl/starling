"use client";

import { Cloud, Laptop } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TTSBackend } from "@/lib/api";
import { cn } from "@/lib/utils";

const MODES: {
  value: TTSBackend;
  label: string;
  icon: typeof Laptop;
  tip: string;
}[] = [
  {
    value: "local",
    label: "On device",
    icon: Laptop,
    tip: "OmniVoice on this laptop's CPU. Speaks in your own cloned voice and nothing leaves the machine — but roughly 6× real time, so a short answer takes about 30 seconds.",
  },
  {
    value: "modal",
    label: "Cloud GPU",
    icon: Cloud,
    tip: "OmniVoice on a serverless GPU: about 3 seconds once warm, roughly 12× faster than on-device. The first request after an idle spell cold-starts the container and can take 40 seconds. The text is sent over the internet, and the reply comes back in a generic voice rather than yours.",
  },
];

/**
 * Picks where speech is synthesised.
 *
 * In the header rather than buried in settings because it is not a
 * preference, it is a live trade-off the user re-makes constantly during a
 * demo: wait thirty seconds for a private, cloned voice, or three for a
 * generic one that went over the wire.
 */
export function TTSModeToggle({
  value,
  onChange,
  disabled,
}: {
  value: TTSBackend;
  onChange: (next: TTSBackend) => void;
  /** True when the remote endpoint is not configured. */
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Where speech is synthesised"
      className="flex items-center gap-0.5 rounded-lg border border-border p-0.5"
    >
      {MODES.map((mode) => {
        const active = value === mode.value;
        const unavailable = disabled && mode.value === "modal";
        return (
          <Tooltip key={mode.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                disabled={unavailable}
                onClick={() => onChange(mode.value)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                  active
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  unavailable && "cursor-not-allowed opacity-40",
                )}
              >
                <mode.icon className="size-3.5" />
                <span className="hidden md:inline">{mode.label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {unavailable
                ? "No Modal endpoint is configured. Set MODAL_TTS_URL on the service."
                : mode.tip}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
