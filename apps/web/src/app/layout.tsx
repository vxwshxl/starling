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

// Bitdefender's TrafficLight extension (and a few ad blockers) stamp
// `bis_skin_checked` / `bis_register` / `__processed_*` onto every div after
// the HTML is parsed but before React hydrates, which React then reports as a
// hydration mismatch. suppressHydrationWarning does not inherit, so it cannot
// cover nested nodes — the only fix from inside the app is to strip the
// attributes back off as fast as they appear. Dev only; nothing to do at
// runtime in production, where the warning is not surfaced anyway.
const STRIP_EXTENSION_ATTRS = `(function(){
  function clean(el){
    if(!el||el.nodeType!==1||!el.attributes)return;
    var a=el.attributes;
    for(var i=a.length-1;i>=0;i--){
      var n=a[i].name;
      if(n.indexOf("bis_")===0||n.indexOf("__processed")===0)el.removeAttribute(n);
    }
  }
  function sweep(root){
    clean(root);
    if(root.querySelectorAll){
      var els=root.querySelectorAll("*");
      for(var i=0;i<els.length;i++)clean(els[i]);
    }
  }
  new MutationObserver(function(muts){
    for(var i=0;i<muts.length;i++){
      var m=muts[i];
      if(m.type==="attributes")clean(m.target);
      else for(var j=0;j<m.addedNodes.length;j++)sweep(m.addedNodes[j]);
    }
  }).observe(document.documentElement,{subtree:true,childList:true,attributes:true});
  sweep(document.documentElement);
})();`;

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
        {process.env.NODE_ENV !== "production" && (
          <script dangerouslySetInnerHTML={{ __html: STRIP_EXTENSION_ATTRS }} />
        )}
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
