"use client";

import { AudioLines, Cpu, Ear, PlugZap, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { Tile, TileLabel } from "@/components/tile";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHealth, type HealthState } from "@/hooks/use-health";
import { API_BASE } from "@/lib/api";
import { cn } from "@/lib/utils";

function StatusDot({ phase }: { phase: HealthState["phase"] }) {
  return (
    <span className="relative flex size-2.5 shrink-0" aria-hidden>
      {phase === "up" && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
      )}
      <span
        className={cn(
          "relative inline-flex size-2.5 rounded-full",
          phase === "up" && "bg-success",
          phase === "down" && "bg-destructive",
          phase === "loading" && "bg-muted-foreground/50",
        )}
      />
    </span>
  );
}

/** A model's tile: name in mono, state as badges. */
function ModelTile({
  icon,
  label,
  hint,
  state,
  model,
  loaded,
  badges,
  delay,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  state: HealthState;
  model?: string;
  loaded?: boolean;
  badges?: ReactNode;
  delay: number;
}) {
  return (
    <Tile delay={delay} className="col-span-full sm:col-span-1 lg:col-span-2">
      <CardHeader>
        <TileLabel icon={icon}>{label}</TileLabel>
        <p className="text-sm text-pretty text-muted-foreground">{hint}</p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-3">
        {state.phase === "loading" && <Skeleton className="h-5 w-4/5" />}
        {state.phase === "down" && (
          <p className="font-mono text-xs text-muted-foreground">unknown</p>
        )}
        {state.phase === "up" && (
          <>
            <p className="font-mono text-sm leading-snug break-all">{model}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {badges}
              <Badge variant={loaded ? "success" : "outline"}>
                {loaded ? "resident" : "not loaded"}
              </Badge>
            </div>
          </>
        )}
      </CardContent>
    </Tile>
  );
}

export function HealthTiles() {
  const { state, refreshing, lastCheckedAt, refresh } = useHealth();

  const heading =
    state.phase === "up"
      ? "Speech service is up"
      : state.phase === "down"
        ? "Speech service is not reachable"
        : "Checking speech service…";

  return (
    <>
      <Tile delay={0} className="col-span-full lg:col-span-4">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-base">
            <StatusDot phase={state.phase} />
            {heading}
            {state.phase === "up" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="secondary" className="font-mono">
                    {state.latencyMs} ms
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Round-trip time of the last probe
                </TooltipContent>
              </Tooltip>
            )}
          </CardTitle>
          <CardDescription className="font-mono text-xs break-all">
            {API_BASE}/health
          </CardDescription>
          <CardAction>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={refresh}
                  aria-label="Check now"
                >
                  <RefreshCw className={cn(refreshing && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {lastCheckedAt
                  ? `Last checked ${lastCheckedAt.toLocaleTimeString()} · polling every 5s`
                  : "Check now"}
              </TooltipContent>
            </Tooltip>
          </CardAction>
        </CardHeader>

        <CardContent className="flex flex-1 flex-col justify-end">
          {state.phase === "loading" && (
            <div className="space-y-2" aria-hidden>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}

          {state.phase === "up" && (
            <dl className="flex flex-wrap gap-x-10 gap-y-3 border-t border-border pt-3">
              <div className="space-y-1">
                <dt>
                  <TileLabel icon={<Cpu className="size-3" />}>Device</TileLabel>
                </dt>
                <dd className="font-mono text-sm">
                  {state.health.models.device}
                </dd>
              </div>
              <div className="space-y-1">
                <dt>
                  <TileLabel>Service</TileLabel>
                </dt>
                <dd className="font-mono text-sm">
                  {state.health.service} v{state.health.version}
                </dd>
              </div>
              <div className="space-y-1">
                <dt>
                  <TileLabel>Languages</TileLabel>
                </dt>
                <dd className="font-mono text-sm">
                  {state.health.languages.length} enabled
                </dd>
              </div>
            </dl>
          )}

          {state.phase === "down" && (
            <Alert variant="destructive">
              <PlugZap />
              <AlertTitle className="break-all">{state.error}</AlertTitle>
              <AlertDescription>
                <p>Start the Python speech service from the repo root:</p>
                <pre className="mt-2 w-full overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
                  pnpm dev:api
                </pre>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Tile>

      <ModelTile
        delay={120}
        icon={<Ear className="size-3" />}
        label="Recognition"
        hint="Turns the speaker's audio into text. Swapped for an Indic model in phase 2."
        state={state}
        model={state.phase === "up" ? state.health.models.asr.model : undefined}
        loaded={state.phase === "up" && state.health.models.asr.loaded}
        badges={
          state.phase === "up" && (
            <Badge variant="outline" className="font-mono">
              {state.health.models.asr.backend}
            </Badge>
          )
        }
      />

      <ModelTile
        delay={180}
        icon={<AudioLines className="size-3" />}
        label="Synthesis"
        hint="Speaks the reply, cloning the voice from the speaker's own recording."
        state={state}
        model={state.phase === "up" ? state.health.models.tts.model : undefined}
        loaded={state.phase === "up" && state.health.models.tts.loaded}
        badges={
          state.phase === "up" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="font-mono">
                  {(state.health.models.tts.sample_rate / 1000).toFixed(0)} kHz
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                Output rate. The rest of the pipeline runs at 16 kHz.
              </TooltipContent>
            </Tooltip>
          )
        }
      />
    </>
  );
}
