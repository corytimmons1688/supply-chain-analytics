import * as React from "react";
import { Layout } from "@/components/layout";
import {
  useGetGoals,
  getGetGoalsQueryKey,
  useSetGlobalGoal,
  useSetStockGoal,
  useDeleteStockGoal
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/format";
import { Plus, Trash2, Save, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export const DEFAULT_GLOBAL_BUDGET_MIN = -6000;
export const DEFAULT_GLOBAL_BUDGET_MAX = 6000;

export default function Goals() {
  const queryClient = useQueryClient();
  const { data: goals, isLoading } = useGetGoals({ query: { queryKey: getGetGoalsQueryKey() } });

  const setGlobalGoal = useSetGlobalGoal();
  const setStockGoal = useSetStockGoal();
  const deleteStockGoal = useDeleteStockGoal();

  // Global editing state
  const [isEditingGlobal, setIsEditingGlobal] = React.useState(false);
  const [globalMin, setGlobalMin] = React.useState("");
  const [globalMax, setGlobalMax] = React.useState("");

  const handleEditGlobal = () => {
    setGlobalMin(
      goals?.global?.min != null
        ? goals.global.min.toString()
        : DEFAULT_GLOBAL_BUDGET_MIN.toString(),
    );
    setGlobalMax(
      goals?.global?.max != null
        ? goals.global.max.toString()
        : DEFAULT_GLOBAL_BUDGET_MAX.toString(),
    );
    setIsEditingGlobal(true);
  };

  const handleSaveGlobal = async () => {
    try {
      const min = globalMin.trim() === "" ? null : Number(globalMin);
      const max = globalMax.trim() === "" ? null : Number(globalMax);
      
      if ((min !== null && isNaN(min)) || (max !== null && isNaN(max))) {
        toast.error("Invalid numbers provided");
        return;
      }

      await setGlobalGoal.mutateAsync({ data: { min, max } });
      queryClient.invalidateQueries({ queryKey: getGetGoalsQueryKey() });
      setIsEditingGlobal(false);
      toast.success("Global budget updated");
    } catch (e) {
      toast.error("Failed to update global budget");
    }
  };

  // Add stock goal state
  const [isAddingStock, setIsAddingStock] = React.useState(false);
  const [newStockId, setNewStockId] = React.useState("");
  const [newStockMin, setNewStockMin] = React.useState("");
  const [newStockMax, setNewStockMax] = React.useState("");

  const handleAddStockGoal = async () => {
    if (!newStockId.trim()) {
      toast.error("Stock ID is required");
      return;
    }

    try {
      const min = newStockMin.trim() === "" ? null : Number(newStockMin);
      const max = newStockMax.trim() === "" ? null : Number(newStockMax);
      
      if ((min !== null && isNaN(min)) || (max !== null && isNaN(max))) {
        toast.error("Invalid numbers provided");
        return;
      }

      await setStockGoal.mutateAsync({ 
        stockId: newStockId.trim(), 
        data: { min, max } 
      });
      
      queryClient.invalidateQueries({ queryKey: getGetGoalsQueryKey() });
      setIsAddingStock(false);
      setNewStockId("");
      setNewStockMin("");
      setNewStockMax("");
      toast.success("Stock budget override added");
    } catch (e) {
      toast.error("Failed to add stock budget override");
    }
  };

  const handleDeleteStockGoal = async (stockId: string) => {
    if (!confirm(`Remove budget override for ${stockId}?`)) return;

    try {
      await deleteStockGoal.mutateAsync({ stockId });
      queryClient.invalidateQueries({ queryKey: getGetGoalsQueryKey() });
      toast.success("Stock budget removed");
    } catch (e) {
      toast.error("Failed to remove stock budget");
    }
  };

  return (
    <Layout>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Budget Configuration</h1>
        <p className="text-muted-foreground text-sm">Set target ranges for acceptable net adjustment amounts.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="border-primary/20 shadow-md">
          <CardHeader>
            <CardTitle>Global Target Range</CardTitle>
            <CardDescription>
              Applied to all stocks unless overridden. Defaults to &plusmn;{formatCurrency(DEFAULT_GLOBAL_BUDGET_MAX)} if not set.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <div className="bg-card border rounded-md p-6">
                {!isEditingGlobal ? (
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm text-muted-foreground mb-1">
                        Target net adjustment range
                        {goals?.global?.min == null && goals?.global?.max == null && (
                          <span className="ml-2 text-xs italic">(default)</span>
                        )}
                      </div>
                      <div className="text-2xl font-mono font-bold">
                        {formatCurrency(goals?.global?.min ?? DEFAULT_GLOBAL_BUDGET_MIN)}
                        <span className="text-muted-foreground mx-2 font-sans text-lg">to</span>
                        {formatCurrency(goals?.global?.max ?? DEFAULT_GLOBAL_BUDGET_MAX)}
                      </div>
                    </div>
                    <Button onClick={handleEditGlobal} variant="outline">Edit</Button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="global-min">Minimum $</Label>
                        <Input id="global-min" placeholder={`e.g. ${DEFAULT_GLOBAL_BUDGET_MIN}`} value={globalMin} onChange={e => setGlobalMin(e.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="global-max">Maximum $</Label>
                        <Input id="global-max" placeholder={`e.g. ${DEFAULT_GLOBAL_BUDGET_MAX}`} value={globalMax} onChange={e => setGlobalMax(e.target.value)} />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => setIsEditingGlobal(false)}>Cancel</Button>
                      <Button onClick={handleSaveGlobal} disabled={setGlobalGoal.isPending}>
                        <Save className="w-4 h-4 mr-2" /> Save Budget
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div>
              <CardTitle>Per-Stock Overrides</CardTitle>
              <CardDescription>Custom target ranges for specific high-value items</CardDescription>
            </div>
            <Dialog open={isAddingStock} onOpenChange={setIsAddingStock}>
              <DialogTrigger asChild>
                <Button size="sm" className="bg-primary text-primary-foreground">
                  <Plus className="w-4 h-4 mr-1" /> Add Override
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Stock Budget Override</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="stock-id">Stock ID</Label>
                    <Input id="stock-id" placeholder="Enter exact Stock ID" value={newStockId} onChange={e => setNewStockId(e.target.value)} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="stock-min">Minimum $</Label>
                      <Input id="stock-min" placeholder="e.g. -100" value={newStockMin} onChange={e => setNewStockMin(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="stock-max">Maximum $</Label>
                      <Input id="stock-max" placeholder="e.g. 100" value={newStockMax} onChange={e => setNewStockMax(e.target.value)} />
                    </div>
                  </div>
                  <Button className="w-full" onClick={handleAddStockGoal} disabled={setStockGoal.isPending}>
                    Save Override
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : goals?.perStock?.length ? (
              <div className="border rounded-md">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>Stock ID</TableHead>
                      <TableHead>Min</TableHead>
                      <TableHead>Max</TableHead>
                      <TableHead className="w-[50px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {goals.perStock.map(goal => (
                      <TableRow key={goal.stockId}>
                        <TableCell className="font-mono font-medium">{goal.stockId}</TableCell>
                        <TableCell className="font-mono text-muted-foreground">{goal.min !== null ? formatCurrency(goal.min) : "-\u221E"}</TableCell>
                        <TableCell className="font-mono text-muted-foreground">{goal.max !== null ? formatCurrency(goal.max) : "+\u221E"}</TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10" onClick={() => handleDeleteStockGoal(goal.stockId)}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="bg-muted/30 border border-dashed rounded-md p-8 text-center text-muted-foreground">
                No stock overrides configured.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
