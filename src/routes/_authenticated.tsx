import { createFileRoute, Outlet, Navigate } from "@tanstack/react-router";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";

export const Route = createFileRoute("/_authenticated")({
  component: AuthLayout,
});

function AuthLayout() {
  const { session, loading, user, signOut } = useAuth();
  if (loading) {
    return <div className="flex min-h-screen items-center justify-center font-mono text-xs text-muted-foreground">loading...</div>;
  }
  if (!session) return <Navigate to="/login" />;

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-border bg-background/80 px-3 backdrop-blur">
            <SidebarTrigger />
            <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-success" />
              <span>market_hours · ingest_live</span>
            </div>
            <div className="ml-auto flex items-center gap-3 font-mono text-xs text-muted-foreground">
              <span className="hidden sm:inline">{user?.email}</span>
              <Button size="sm" variant="ghost" onClick={signOut} className="h-7 gap-1">
                <LogOut className="h-3 w-3" /> sign out
              </Button>
            </div>
          </header>
          <main className="flex-1 p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
