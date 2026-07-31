import * as React from "react";
import { Link, useLocation } from "wouter";
import { Factory, BarChart3, Target, Camera, Boxes, ChevronDown, Activity, TrendingUp, ClipboardList, ListChecks, Award, ClipboardCheck, Users, Network, LogOut, LayoutDashboard, Archive } from "lucide-react";
import { authClient, signOutEverywhere } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { useGatewayHealth } from "@workspace/api-client-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface LayoutProps {
  children: React.ReactNode;
}

const INVENTORY_CONTROL_ITEMS = [
  { href: "/adjustments", label: "Adjustments Dashboard", icon: BarChart3 },
  { href: "/snapshots", label: "Weekly/Monthly Tracking", icon: Camera },
  { href: "/goals", label: "Budget", icon: Target },
  { href: "/root-cause", label: "Root Cause", icon: ClipboardList },
  { href: "/cycle-counts", label: "Cycle Count Schedule", icon: ListChecks },
] as const;

const DEMAND_ITEMS = [
  { href: "/demand", label: "Demand Planning", icon: TrendingUp },
  { href: "/excess-obsolete", label: "Excess & Obsolete", icon: Archive },
];

const SUPPLIER_ITEMS = [
  { href: "/scorecards", label: "Vendor Score Cards", icon: Award },
  { href: "/asl", label: "Approved Supplier List", icon: ClipboardCheck },
  { href: "/network", label: "Vendor Network", icon: Network },
] as const;

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const { data: health } = useGatewayHealth();

  const inventoryActive = INVENTORY_CONTROL_ITEMS.some((i) => i.href === location);
  const demandActive = location === "/demand" || location.startsWith("/demand/") || location === "/excess-obsolete";
  const supplierActive = SUPPLIER_ITEMS.some((i) => i.href === location);

  return (
    <div className="flex flex-col h-screen w-full bg-background overflow-hidden">
      <header className="h-14 flex items-center px-3 sm:px-6 border-b border-border bg-card shrink-0 gap-3 sm:gap-6">
        <Link href="/">
          <div className="flex items-center gap-2.5 cursor-pointer">
            <div className="w-8 h-8 rounded-md bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shadow-sm shrink-0">
              <Factory className="w-4 h-4 text-white" strokeWidth={2.25} />
            </div>
            <div className="hidden lg:flex flex-col leading-tight whitespace-nowrap">
              <span className="font-semibold text-[15px] tracking-tight text-foreground">
                Calyx <span className="font-normal text-muted-foreground">Containers</span>
              </span>
              <span className="text-[11px] text-muted-foreground">Supply Chain Analytics</span>
            </div>
          </div>
        </Link>

        <nav className="flex items-center gap-1">
          <Link
            href="/"
            className={cn(
              "flex items-center gap-1.5 px-3 h-9 rounded-md text-sm font-medium transition-colors outline-none whitespace-nowrap",
              location === "/"
                ? "text-primary bg-primary/10"
                : "text-foreground/80 hover:bg-accent hover:text-accent-foreground"
            )}
          >
            <LayoutDashboard className="w-4 h-4" />
            <span className="hidden sm:inline">Overview</span>
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1.5 px-3 h-9 rounded-md text-sm font-medium transition-colors outline-none whitespace-nowrap",
                  inventoryActive
                    ? "text-primary bg-primary/10"
                    : "text-foreground/80 hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <Boxes className="w-4 h-4" />
                <span className="hidden sm:inline">Inventory Control</span>
                <span className="sm:hidden">Inventory</span>
                <ChevronDown className="w-3.5 h-3.5 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              {INVENTORY_CONTROL_ITEMS.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href}>
                  <DropdownMenuItem
                    className={cn(
                      "cursor-pointer",
                      location === href && "bg-primary/10 text-primary focus:bg-primary/10 focus:text-primary"
                    )}
                  >
                    <Icon className="w-4 h-4 mr-2" />
                    {label}
                  </DropdownMenuItem>
                </Link>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1.5 px-3 h-9 rounded-md text-sm font-medium transition-colors outline-none whitespace-nowrap",
                  demandActive
                    ? "text-primary bg-primary/10"
                    : "text-foreground/80 hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <TrendingUp className="w-4 h-4" />
                <span className="hidden sm:inline">Demand Planning</span>
                <span className="sm:hidden">Demand</span>
                <ChevronDown className="w-3.5 h-3.5 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              {DEMAND_ITEMS.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href}>
                  <DropdownMenuItem
                    className={cn(
                      "cursor-pointer",
                      location === href && "bg-primary/10 text-primary focus:bg-primary/10 focus:text-primary"
                    )}
                  >
                    <Icon className="w-4 h-4 mr-2" />
                    {label}
                  </DropdownMenuItem>
                </Link>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1.5 px-3 h-9 rounded-md text-sm font-medium transition-colors outline-none whitespace-nowrap",
                  supplierActive
                    ? "text-primary bg-primary/10"
                    : "text-foreground/80 hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <Users className="w-4 h-4" />
                <span className="hidden sm:inline">Suppliers</span>
                <ChevronDown className="w-3.5 h-3.5 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {SUPPLIER_ITEMS.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href}>
                  <DropdownMenuItem
                    className={cn(
                      "cursor-pointer",
                      location === href && "bg-primary/10 text-primary focus:bg-primary/10 focus:text-primary"
                    )}
                  >
                    <Icon className="w-4 h-4 mr-2" />
                    {label}
                  </DropdownMenuItem>
                </Link>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "w-2 h-2 rounded-full",
                health?.odbcConnected
                  ? "bg-green-500"
                  : health?.reachable
                  ? "bg-yellow-500"
                  : "bg-red-500"
              )}
              title={
                health?.odbcConnected
                  ? "Label Traxx Connected"
                  : health?.reachable
                  ? "Gateway Up / LT API Down"
                  : "Label Traxx Disconnected"
              }
            />
            <span className="font-mono hidden md:inline">
              {health?.odbcConnected
                ? "Label Traxx Connected"
                : health?.reachable
                ? "Gateway Up / LT API Down"
                : "Label Traxx Disconnected"}
            </span>
          </div>
          <div className="hidden sm:flex items-center font-mono">
            {health?.latencyMs ? `${health.latencyMs}ms` : "---"}
            <Activity className="w-3.5 h-3.5 ml-1.5" />
          </div>
          <UserMenu />
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        <div className="max-w-[1600px] mx-auto p-4 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">{children}</div>
      </main>
    </div>
  );
}


/** Signed-in identity + sign-out, fed by the Better Auth session. */
function UserMenu() {
  const { data: session } = authClient.useSession();
  if (!session?.user) return null;
  return (
    <div className="flex items-center gap-2 pl-2 border-l border-border">
      <span className="hidden md:inline text-muted-foreground max-w-[14rem] truncate" title={session.user.email}>
        {session.user.name || session.user.email}
      </span>
      <button
        type="button"
        onClick={() => void signOutEverywhere()}
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        title="Sign out"
      >
        <LogOut className="w-3.5 h-3.5" />
        <span className="hidden lg:inline">Sign out</span>
      </button>
    </div>
  );
}
