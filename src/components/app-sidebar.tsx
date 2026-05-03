import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, LineChart, Cpu, Coins, Gauge, TrendingUp } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
} from "@/components/ui/sidebar";

const items = [
  { title: "Feed Health", url: "/", icon: Activity },
  { title: "Predictions", url: "/predictions", icon: LineChart },
  { title: "Performance", url: "/performance", icon: TrendingUp },
  { title: "Models", url: "/models", icon: Cpu },
  { title: "Cost", url: "/cost", icon: Coins },
];

export function AppSidebar() {
  const path = useRouterState({ select: (r) => r.location.pathname });

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <Link to="/" className="flex items-center gap-2 px-2 py-1.5">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-primary text-primary-foreground">
            <Gauge className="h-4 w-4" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-tight">MPS Admin</span>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">v1 · shadow</span>
          </div>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Operations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={path === item.url}>
                    <Link to={item.url} className="flex items-center gap-2">
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <div className="px-2 py-1.5 text-[10px] font-mono text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>SYSTEM_TRUSTED</span>
            <span className="text-warning">false</span>
          </div>
          <div className="flex items-center justify-between">
            <span>UPTIME</span>
            <span className="text-success">99.4%</span>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
