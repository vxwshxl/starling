"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";

export function ModeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  // The server cannot know the resolved theme, so rendering the real icon on
  // the first client pass would mismatch the server HTML. Hold a placeholder
  // until after hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";

  // The label has to be gated on `mounted` for the same reason the icon is:
  // the server has no theme to resolve, so anything derived from it differs
  // between the two renders and React reports a hydration mismatch.
  const label = !mounted
    ? "Toggle theme"
    : isDark
      ? "Switch to light theme"
      : "Switch to dark theme";

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={label}
    >
      {mounted ? (
        isDark ? (
          <Sun aria-hidden />
        ) : (
          <Moon aria-hidden />
        )
      ) : (
        <span className="size-4" />
      )}
    </Button>
  );
}
