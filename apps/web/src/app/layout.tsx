import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";

import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import "./globals.css";

// An editorial serif for the wordmark against monospaced telemetry — the page
// is an instrument panel, and the contrast is the whole point.
const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });
const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "Starling",
  description:
    "Speech-to-speech assistant for low-resource Northeast Indian languages",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={cn(
        "font-sans",
        geist.variable,
        geistMono.variable,
        display.variable,
      )}
      // next-themes writes the theme class onto <html> before paint, which the
      // server render cannot predict. Required, not a papered-over bug.
      suppressHydrationWarning
    >
      {/* suppressHydrationWarning does not inherit, so <body> needs its own.
          Browser extensions inject attributes here (bis_register and friends)
          before React hydrates, which is not something the app can prevent. */}
      <body className="antialiased" suppressHydrationWarning>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
