import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
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

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/stock/:stockId" component={StockDetails} />
      <Route path="/goals" component={Goals} />
      <Route path="/root-cause" component={RootCause} />
      <Route path="/snapshots" component={Snapshots} />
      <Route path="/demand" component={DemandPlanning} />
      <Route path="/demand/:stockId" component={DemandDetail} />
      <Route path="/cycle-counts" component={CycleCounts} />
      <Route path="/scorecards" component={Scorecards} />
      <Route path="/asl" component={Asl} />
      <Route path="/network" component={VendorNetwork} />
      <Route component={NotFound} />
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
