import * as React from "react";
import { Link, useLocation } from "wouter";
import { Factory, BarChart3, Target, Camera, Boxes, ChevronDown, Activity, TrendingUp, ClipboardList, ListChecks, Award, ClipboardCheck, Users, Network, LogOut, LayoutDashboard, Archive, ShieldCheck, LineChart } from "lucide-react";
import { authClient, signOutEverywhere } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { useGatewayHealth, useGetMe } from "@workspace/api-client-react";
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
  // Forecasting owns the forward-looking demand signal; /demand keeps execution
  // (suggested POs, vendor email, releases).
  { href: "/forecasting", label: "Forecasting", icon: LineChart },
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
  const demandActive =
    location === "/demand" ||
    location.startsWith("/demand/") ||
    location === "/excess-obsolete" ||
    location === "/forecasting";
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
          {/* The LT Cloud API can be healthy while the ODBC gateway is dead.
              The gateway is the only source for PO requested-delivery dates and
              per-roll cost, so a silent outage makes those quietly stale — say
              so rather than letting the green dot imply everything is fine. */}
          {health?.gatewayDegraded && (
            <div
              className="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400"
              title={
                health.gatewayImpact ??
                "The ODBC gateway is reachable but not answering queries."
              }
            >
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              <span className="font-mono hidden md:inline">ODBC gateway down</span>
            </div>
          )}
          <div className="hidden sm:flex items-center font-mono">
            {health?.latencyMs ? `${health.latencyMs}ms` : "---"}
            <Activity className="w-3.5 h-3.5 ml-1.5" />
          </div>
          <DataAge ages={health?.syncAges} />
          <UserMenu />
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        <div className="max-w-[1600px] mx-auto p-4 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">{children}</div>
      </main>
    </div>
  );
}


function fmtAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  return h < 48 ? `${h}h ${minutes % 60}m` : `${Math.floor(h / 24)}d`;
}

/**
 * How old the data behind the dashboard is. The headline number is the
 * freshest Label Traxx pull (the 15-min roll refresh or the hourly full
 * sync — whichever ran last); hovering lists every source. Makes "refreshing
 * the page won't change this number" visible instead of silent.
 */
function DataAge({ ages }: { ages?: { source: string; label: string; minutesAgo: number }[] }) {
  if (!ages?.length) return null;
  const lt = ages.filter((a) => a.source === "labeltraxx_rolls" || a.source === "labeltraxx_api");
  const headline = (lt.length ? lt : ages).reduce((a, b) => (b.minutesAgo < a.minutesAgo ? b : a));
  const stale = headline.minutesAgo > 120;
  return (
    <div
      className={cn("hidden md:flex items-center gap-1.5 font-mono", stale && "text-amber-600 dark:text-amber-500")}
      title={ages.map((a) => `${a.label}: ${fmtAge(a.minutesAgo)} ago`).join("\n")}
    >
      <span>Data {fmtAge(headline.minutesAgo)}</span>
    </div>
  );
}

/** Signed-in identity + sign-out, fed by the Better Auth session. */
function UserMenu() {
  const { data: session } = authClient.useSession();
  const { data: me } = useGetMe();
  const [location] = useLocation();
  // Mock mode has no real session; fall back to /me so the header still reads
  // as it does in production. Dev-only flag.
  const user =
    session?.user ??
    (import.meta.env.VITE_MOCK_API && me
      ? { email: me.email, name: me.name ?? me.email }
      : null);
  if (!user) return null;
  return (
    <div className="flex items-center gap-2 pl-2 border-l border-border">
      <span className="hidden md:inline text-muted-foreground max-w-[14rem] truncate" title={user.email}>
        {user.name || user.email}
      </span>
      {me?.appRole === "admin" ? (
        <Link
          href="/admin"
          className={cn(
            "inline-flex items-center gap-1 hover:text-foreground",
            location === "/admin" ? "text-primary" : "text-muted-foreground"
          )}
          title="Administration"
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">Admin</span>
        </Link>
      ) : null}
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
