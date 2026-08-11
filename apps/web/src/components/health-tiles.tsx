"use client";

import {
  AudioLines,
  Cpu,
  Ear,
  Loader2,
  PlugZap,
  Power,
  RefreshCw,
} from "lucide-react";
import { useState, type ReactNode } from "react";

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
import {
  API_BASE,
  loadModel,
  unloadModel,
  type ModelTarget,
} from "@/lib/api";
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
  target,
  busy,
  error,
  onToggle,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  state: HealthState;
  model?: string;
  loaded?: boolean;
  badges?: ReactNode;
  delay: number;
  target: ModelTarget;
  busy: boolean;
  error: string | null;
  onToggle: (target: ModelTarget, loaded: boolean) => void;
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

            <div className="space-y-2">
              <Button
                variant={loaded ? "outline" : "secondary"}
                size="sm"
                className="w-full"
                disabled={busy}
                onClick={() => onToggle(target, !!loaded)}
                aria-label={
                  loaded ? `Unload the ${label} model` : `Load the ${label} model`
                }
              >
                {busy ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Power data-icon="inline-start" />
                )}
                {busy
                  ? loaded
                    ? "Freeing…"
                    : "Loading…"
                  : loaded
                    ? "Unload"
                    : "Load"}
              </Button>
              {error && (
                <p className="text-xs text-balance text-destructive">{error}</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Tile>
  );
}

export function HealthTiles() {
  const { state, refreshing, lastCheckedAt, refresh } = useHealth();

  const [busy, setBusy] = useState<ModelTarget | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ModelTarget, string>>>({});

  // ASR ships one recogniser per language, so loading it needs a language.
  // /health lists enabled codes in the brief's priority order, so the first is
  // the default -- no second request just to learn that.
  const defaultLanguage =
    state.phase === "up" ? (state.health.languages[0] ?? "as") : "as";

  async function toggle(target: ModelTarget, loaded: boolean) {
    setBusy(target);
    setErrors((e) => ({ ...e, [target]: undefined }));
    try {
      if (loaded) {
        await unloadModel(target);
      } else {
        await loadModel(target, defaultLanguage);
      }
    } catch (err) {
      setErrors((e) => ({
        ...e,
        [target]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusy(null);
      // Loading changes what is resident, and the poll is up to 5s away.
      refresh();
    }
  }

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
        target="asr"
        busy={busy === "asr"}
        error={errors.asr ?? null}
        onToggle={toggle}
        hint="Turns speech into text. Whisper for Assamese and Bengali, IndicConformer for the rest."
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
        target="tts"
        busy={busy === "tts"}
        error={errors.tts ?? null}
        onToggle={toggle}
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
