import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from "@tanstack/react-query";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Overview from "@/pages/overview";
import StockDetails from "@/pages/stock-details";
import Goals from "@/pages/goals";
import RootCause from "@/pages/root-cause";
import Snapshots from "@/pages/snapshots";
import DemandPlanning from "@/pages/demand";
import DemandDetail from "@/pages/demand-detail";
import CycleCounts from "@/pages/cycle-counts";
import Scorecards from "@/pages/scorecards";
import Asl from "@/pages/asl";
import VendorNetwork from "@/pages/vendor-network";
import ExcessObsolete from "@/pages/excess-obsolete";
import AdminPage from "@/pages/admin";
import { LoginPage, RegisterPage, VerifyEmailPage, ForgotPasswordPage, ResetPasswordPage } from "@/pages/auth";
import { authClient, getAuthToken, clearAuthToken, signOutEverywhere } from "@/lib/auth-client";
import { useGetMe } from "@workspace/api-client-react";

// Every generated API call carries the Better Auth bearer token.
setAuthTokenGetter(() => getAuthToken());

/** A 401 from our API means the session died mid-use — drop the token and re-authenticate. */
function onAuthError(err: unknown): void {
  if ((err as { status?: number })?.status === 401 && !window.location.pathname.includes("/login")) {
    clearAuthToken();
    window.location.assign(`${import.meta.env.BASE_URL}login`);
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onAuthError }),
  mutationCache: new MutationCache({ onError: onAuthError }),
});

/**
 * Gate for the app proper: waits for the session check, bounces signed-out
 * visitors to /login. An unreachable auth server resolves to "no session"
 * (degrade to signed out) rather than hanging navigation.
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Checking your session…
      </div>
    );
  }
  if (!session?.user) return <Redirect to="/login" />;
  return <AccessGate>{children}</AccessGate>;
}

/**
 * App-level access check on top of the identity check: /me is the one API a
 * pending/blocked account may call, so a non-active status renders a friendly
 * holding screen instead of every page erroring with 403s. If /me itself
 * fails, render the app anyway — the server still enforces access.
 */
function AccessGate({ children }: { children: React.ReactNode }) {
  const { data: me, isPending, isError } = useGetMe();
  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Checking your session…
      </div>
    );
  }
  if (isError || !me || me.appStatus === "active") return <>{children}</>;
  const blocked = me.appStatus === "blocked";
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-lg font-semibold">{blocked ? "Access disabled" : "Awaiting approval"}</h1>
        <p className="text-sm text-muted-foreground">
          {blocked
            ? "Your access to this dashboard has been disabled by an administrator."
            : "Your account was created, but an administrator needs to approve it before you can use this dashboard. Check back once you've been approved."}
        </p>
        <p className="text-xs text-muted-foreground">Signed in as {me.email}</p>
        <button type="button" className="text-sm text-primary underline underline-offset-4" onClick={() => void signOutEverywhere()}>
          Sign out
        </button>
      </div>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      {/* Public auth pages */}
      <Route path="/login" component={LoginPage} />
      <Route path="/register" component={RegisterPage} />
      <Route path="/verify-email" component={VerifyEmailPage} />
      <Route path="/forgot-password" component={ForgotPasswordPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />
      {/* Everything else requires a session */}
      <Route>
        <RequireAuth>
          <Switch>
            <Route path="/" component={Overview} />
            <Route path="/adjustments" component={Dashboard} />
            <Route path="/stock/:stockId" component={StockDetails} />
            <Route path="/goals" component={Goals} />
            <Route path="/root-cause" component={RootCause} />
            <Route path="/snapshots" component={Snapshots} />
            <Route path="/demand" component={DemandPlanning} />
            <Route path="/demand/:stockId" component={DemandDetail} />
            <Route path="/excess-obsolete" component={ExcessObsolete} />
            <Route path="/admin" component={AdminPage} />
            <Route path="/cycle-counts" component={CycleCounts} />
            <Route path="/scorecards" component={Scorecards} />
            <Route path="/asl" component={Asl} />
            <Route path="/network" component={VendorNetwork} />
            <Route component={NotFound} />
          </Switch>
        </RequireAuth>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
