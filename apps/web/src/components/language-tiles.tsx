"use client";

import { CircleAlert, Languages, TriangleAlert } from "lucide-react";

import { Tile, TileLabel } from "@/components/tile";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLanguages } from "@/hooks/use-languages";
import type { LanguageInfo } from "@/lib/api";
import {
  COVERAGE_BADGE,
  COVERAGE_LABEL,
  coverageOf,
  type Stage,
} from "@/lib/coverage";

const STAGE_HINT: Record<Stage, string> = {
  asr: "Speech recognition — mlx-whisper",
  tts: "Voice cloning and synthesis — OmniVoice",
};

function CoverageBadge({ lang, stage }: { lang: LanguageInfo; stage: Stage }) {
  const level = coverageOf(lang, stage);
  return <Badge variant={COVERAGE_BADGE[level]}>{COVERAGE_LABEL[level]}</Badge>;
}

function StageHeading({ stage }: { stage: Stage }) {
  return (
    <Tooltip>
      <TooltipTrigger className="cursor-help underline decoration-dotted underline-offset-4">
        {stage.toUpperCase()}
      </TooltipTrigger>
      <TooltipContent>{STAGE_HINT[stage]}</TooltipContent>
    </Tooltip>
  );
}

export function LanguageTiles() {
  const state = useLanguages();

  // Every enabled language is currently native at all three stages, so there
  // is nothing to caveat and the tile would render empty. It is kept rather
  // than deleted for the same reason the fallback machinery in languages.py
  // is: the next language added may well need a stand-in somewhere, and this
  // is what reports that. It reappears on its own when a warning exists.
  const caveats =
    state.phase === "ready"
      ? state.data.languages.flatMap((lang) =>
          lang.warnings.map((warning) => ({ lang, warning })),
        )
      : [];

  return (
    <>
      <Tile delay={240} className="col-span-full lg:col-span-4">
        <CardHeader>
          <TileLabel icon={<Languages className="size-3" />}>
            Language coverage
          </TileLabel>
          <CardTitle className="sr-only">Language coverage</CardTitle>
          <CardDescription className="text-pretty">
            Recognition and synthesis are separate models with different reach,
            so a language can be covered by one and not the other.
          </CardDescription>
        </CardHeader>

        <CardContent>
          {state.phase === "loading" && (
            <div className="space-y-3" aria-hidden>
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}

          {state.phase === "error" && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>Could not load the language list</AlertTitle>
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          {state.phase === "ready" && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Language</TableHead>
                  <TableHead className="hidden sm:table-cell">Script</TableHead>
                  <TableHead>
                    <StageHeading stage="asr" />
                  </TableHead>
                  <TableHead>
                    <StageHeading stage="tts" />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.data.languages.map((lang) => (
                  <TableRow key={lang.code}>
                    <TableCell>
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{lang.name}</span>
                        {lang.code === state.data.default && (
                          <Badge variant="secondary">default</Badge>
                        )}
                      </div>
                      <div className="text-muted-foreground">
                        {/* A real BCP-47 hint, so the browser picks a Bengali
                            or Devanagari face instead of guessing from the
                            surrounding Latin text. */}
                        <span lang={lang.iso} className="text-base">
                          {lang.native_name}
                        </span>
                        <span className="ml-2 font-mono text-xs">
                          {lang.iso}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {lang.script_name}
                    </TableCell>
                    <TableCell>
                      <CoverageBadge lang={lang} stage="asr" />
                    </TableCell>
                    <TableCell>
                      <CoverageBadge lang={lang} stage="tts" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Tile>

      {caveats.length > 0 && (
        <Tile delay={300} className="col-span-full lg:col-span-6">
          <CardHeader>
            <TileLabel icon={<TriangleAlert className="size-3" />}>
              Caveats
            </TileLabel>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {caveats.map(({ lang, warning }, i) => (
              <Alert key={`${lang.code}-${i}`} variant="warning">
                <TriangleAlert />
                <AlertTitle>{lang.name}</AlertTitle>
                <AlertDescription>{warning}</AlertDescription>
              </Alert>
            ))}
          </CardContent>
        </Tile>
      )}
    </>
  );
}
