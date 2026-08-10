"use client";

import {
  AudioLines,
  Cpu,
  Ear,
  PlugZap,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHealth } from "@/hooks/use-health";
import { API_BASE } from "@/lib/api";
import { cn } from "@/lib/utils";

function StatusDot({ phase }: { phase: "loading" | "up" | "down" }) {
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

/** One label/value pair in the resident-models list. */
function ModelRow({
  icon,
  label,
  model,
  loaded,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  model: string;
  loaded: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
      <div className="flex w-24 shrink-0 items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium tracking-wide uppercase">
          {label}
        </span>
      </div>
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={model}>
        {model}
      </code>
      <div className="flex items-center gap-1.5">
        {children}
        <Badge variant={loaded ? "success" : "outline"}>
          {loaded ? "resident" : "not loaded"}
        </Badge>
      </div>
    </div>
  );
}

export function ServiceStatusCard() {
  const { state, refreshing, lastCheckedAt, refresh } = useHealth();

  const heading =
    state.phase === "up"
      ? "Speech service is up"
      : state.phase === "down"
        ? "Speech service is not reachable"
        : "Checking speech service…";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5 text-base">
          <StatusDot phase={state.phase} />
          {heading}
          {state.phase === "up" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="font-mono">
                  {state.latencyMs} ms
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Round-trip time of the last probe</TooltipContent>
            </Tooltip>
          )}
        </CardTitle>
        <CardDescription className="font-mono text-xs">
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

      <CardContent>
        {state.phase === "loading" && (
          <div className="space-y-3" aria-hidden>
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-11/12" />
            <Skeleton className="h-5 w-9/12" />
          </div>
        )}

        {state.phase === "up" && (
          <div className="divide-y divide-border">
            <div className="flex items-center gap-3 pb-2.5">
              <div className="flex w-24 shrink-0 items-center gap-2 text-muted-foreground">
                <Cpu className="size-3.5" />
                <span className="text-xs font-medium tracking-wide uppercase">
                  Device
                </span>
              </div>
              <code className="font-mono text-xs">
                {state.health.models.device}
              </code>
              <span className="ml-auto text-xs text-muted-foreground">
                v{state.health.version}
              </span>
            </div>

            <ModelRow
              icon={<Ear className="size-3.5" />}
              label="ASR"
              model={state.health.models.asr.model}
              loaded={state.health.models.asr.loaded}
            >
              <Badge variant="outline" className="font-mono">
                {state.health.models.asr.backend}
              </Badge>
            </ModelRow>

            <ModelRow
              icon={<AudioLines className="size-3.5" />}
              label="TTS"
              model={state.health.models.tts.model}
              loaded={state.health.models.tts.loaded}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="font-mono">
                    {(state.health.models.tts.sample_rate / 1000).toFixed(0)} kHz
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Synthesis output rate. The rest of the pipeline runs at 16 kHz.
                </TooltipContent>
              </Tooltip>
            </ModelRow>
          </div>
        )}

        {state.phase === "down" && (
          <Alert variant="destructive">
            <PlugZap />
            <AlertTitle>{state.error}</AlertTitle>
            <AlertDescription>
              <p>Start the Python speech service from the repo root:</p>
              <pre className="mt-2 w-full overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
                pnpm dev:api
              </pre>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>

      {state.phase === "up" && !state.health.models.asr.loaded && (
        <>
          <Separator />
          <CardContent>
            <Alert variant="warning">
              <TriangleAlert />
              <AlertTitle>Models are not warmed</AlertTitle>
              <AlertDescription>
                Weights load lazily on first use and download from the Hugging
                Face hub if absent. The first request will appear frozen for
                several minutes — watch the service terminal, not the browser.
              </AlertDescription>
            </Alert>
          </CardContent>
        </>
      )}
    </Card>
  );
}
