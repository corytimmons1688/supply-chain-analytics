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
import { authClient, getAuthToken, clearAuthToken } from "@/lib/auth-client";

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
  return <>{children}</>;
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
