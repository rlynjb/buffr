"use client";

import { useAuth } from "@/context/auth-context";
import { ProviderProvider } from "@/context/provider-context";
import { NotificationProvider } from "@/components/ui/notification";
import { Nav } from "@/components/nav";
export function AppShell({ children }: { children: React.ReactNode }) {
  const { authenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 animate-pulse" />
      </div>
    );
  }

  if (!authenticated) {
    return <>{children}</>;
  }

  return (
    <ProviderProvider>
      <NotificationProvider>
        <Nav />
        <main className="main__container">{children}</main>
      </NotificationProvider>
    </ProviderProvider>
  );
}
