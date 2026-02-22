import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ProviderProvider } from "@/context/provider-context";
import { NotificationProvider } from "@/components/ui/notification";
import { Nav } from "@/components/nav";
import { CommandPalette } from "@/components/command-palette";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
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
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground font-sans`}
      >
        <ProviderProvider>
          <NotificationProvider>
            <Nav />
            <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
            <CommandPalette />
          </NotificationProvider>
        </ProviderProvider>
      </body>
    </html>
  );
}
