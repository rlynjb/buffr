import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import { ProviderProvider } from "@/context/provider-context";
import { NotificationProvider } from "@/components/ui/notification";
import { Nav } from "@/components/nav";
import { CommandPalette } from "@/components/command-palette";
import "./globals.css";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "buffr",
  description: "Developer continuity and momentum tool",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${dmSans.variable} ${jetbrainsMono.variable} antialiased bg-background text-foreground font-sans`}
      >
        <ProviderProvider>
          <NotificationProvider>
            <Nav />
            <main className="mx-auto max-w-3xl px-4 py-8">{children}</main>
            <CommandPalette />
          </NotificationProvider>
        </ProviderProvider>
      </body>
    </html>
  );
}
