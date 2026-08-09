import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Starling",
  description:
    "Speech-to-speech assistant for low-resource Northeast Indian languages",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
