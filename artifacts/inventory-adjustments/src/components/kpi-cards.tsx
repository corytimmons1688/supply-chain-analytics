import * as React from "react";
import { formatCurrency } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowDownRight, ArrowUpRight, Minus, Package, Percent } from "lucide-react";
import { cn } from "@/lib/utils";

interface KPICardsProps {
  totals?: {
    added: number;
    removed: number;
    net: number;
  };
  onHand?: {
    totalValue: number;
    rollCount: number;
  };
  isLoading?: boolean;
  onHandLoading?: boolean;
}

export function KPICards({ totals, onHand, isLoading, onHandLoading }: KPICardsProps) {
  const isNetNegative = totals ? totals.net < 0 : false;
  const isNetPositive = totals ? totals.net > 0 : false;
  const adjustmentPct =
    totals && onHand && onHand.totalValue > 0
      ? (totals.net / onHand.totalValue) * 100
      : null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            On-Hand Inventory Value
          </CardTitle>
          <Package className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {onHandLoading || !onHand ? (
            <div className="h-8 bg-muted rounded w-32 mb-2 animate-pulse" />
          ) : (
            <>
              <div className="text-3xl font-bold font-mono">{formatCurrency(onHand.totalValue)}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {onHand.rollCount.toLocaleString()} rolls currently in stock
              </p>
            </>
          )}
        </CardContent>
      </Card>
      <Card className={cn(
        "border-l-4",
        isNetNegative ? "border-l-red-500" : isNetPositive ? "border-l-green-500" : "border-l-muted"
      )}>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Net Adjustment
          </CardTitle>
          {isNetNegative ? (
            <ArrowDownRight className="h-4 w-4 text-red-600" />
          ) : isNetPositive ? (
            <ArrowUpRight className="h-4 w-4 text-green-600" />
          ) : (
            <Minus className="h-4 w-4 text-muted-foreground" />
          )}
        </CardHeader>
        <CardContent>
          {isLoading || !totals ? (
            <div className="h-8 bg-muted rounded w-32 mb-2 animate-pulse" />
          ) : (
            <>
              <div className={cn(
                "text-3xl font-bold font-mono",
                isNetNegative ? "text-red-600 dark:text-red-500" : isNetPositive ? "text-green-600 dark:text-green-500" : ""
              )}>
                {formatCurrency(totals.net)}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                <span className="text-green-600 dark:text-green-500">+{formatCurrency(totals.added)} added</span>
                <span className="mx-2">·</span>
                <span className="text-red-600 dark:text-red-500">-{formatCurrency(totals.removed)} removed</span>
              </p>
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">% of On-Hand</CardTitle>
          <Percent className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {isLoading || onHandLoading || !totals || !onHand ? (
            <div className="h-8 bg-muted rounded w-32 mb-2 animate-pulse" />
          ) : adjustmentPct === null ? (
            <div className="text-3xl font-bold font-mono text-muted-foreground">&mdash;</div>
          ) : (
            <div className={cn(
              "text-3xl font-bold font-mono",
              adjustmentPct < 0 ? "text-red-600 dark:text-red-500" : adjustmentPct > 0 ? "text-green-600 dark:text-green-500" : ""
            )}>
              {adjustmentPct >= 0 ? "+" : ""}
              {adjustmentPct.toFixed(2)}%
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
