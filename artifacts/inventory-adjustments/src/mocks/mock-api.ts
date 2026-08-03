/**
 * DEV-ONLY mock API. Installed from main.tsx only when VITE_MOCK_API is set,
 * so it is inert in every normal build.
 *
 * It patches window.fetch and answers anything under /api/** from invented
 * data — including /api/auth/get-session, so the app opens without a real
 * Better Auth session. Nothing reaches Postgres, NetSuite, LabelTraxx or the
 * ODBC gateway, and no page or hook needed changing: the interception happens
 * below the generated Orval client.
 *
 * Demand figures are derived from the SAME material list the Forecasting tab
 * uses (./forecasting-data), so Demand Planning and Forecasting agree with
 * each other instead of telling two different stories.
 *
 * Unmatched /api paths fall through to `{ items: [] }`, which the pages render
 * as their normal empty state. That is deliberate: a sparse tab is honest,
 * whereas invented vendor scorecards could be mistaken for real numbers.
 */

import { MATERIALS, buildAllForecasts, DEMAND_LINES } from "./forecasting-data";

const MOCK_USER = {
  id: "mock-user-1",
  email: "mrajani@calyxcontainers.com",
  name: "Mirhaan Rajani (mock)",
  emailVerified: true,
  image: null,
  role: "admin",
  createdAt: "2026-01-05T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
};

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400000).toISOString();
}

/** Shared so /cycle-counts/kpi and /cycle-counts/schedule cannot disagree. */
const CYCLE_KPI = {
  quarter: "2026-Q3",
  status: "behind" as const,
  expectedThroughLastCompletedWeek: 12,
  completedThroughLastCompletedWeek: 10,
  deficit: 2,
  totalExpectedThisQuarter: 26,
  totalCompletedThisQuarter: 10,
  currentWeek: 6,
  totalWeeks: 13,
};

/* ------------------------------------------------------- demand summary --- */

/** Build DemandStockMetrics rows from the shared material list. */
function demandItems() {
  const forecasts = buildAllForecasts({ scenarios: 600 });
  return forecasts.map((f) => {
    const m = f.material;
    const avgWeekly = Math.round(
      f.weeks.reduce((a, w) => a + w.expectedDemand, 0) / f.weeks.length,
    );
    const openPoFootage = m.onOrder.reduce((a, p) => a + p.footageFt, 0);
    const available = m.onHandFt - f.weeks[0]!.namedDemand;
    return {
      stockId: m.stockId,
      description: m.description,
      onHandFootage: m.onHandFt,
      onHandRollCount: Math.round(m.onHandFt / m.typicalRollFt),
      totalDemandFootage: Math.round(avgWeekly * 26),
      weeksOfHistory: 26,
      avgWeeklyDemand: avgWeekly,
      weeklyDemandStdDev: Math.round(avgWeekly * m.baselineCv),
      demandCv: Number(f.demandCv.toFixed(3)),
      autoDemandCv: Number(f.demandCv.toFixed(3)),
      demandCvOverridden: false,
      avgLeadTimeDays: m.leadTimeDays,
      autoLeadTimeDays: m.leadTimeDays,
      leadTimeDaysOverridden: false,
      leadTimeSource: "stock" as const,
      leadTimeObservations: 6,
      leadTimeStdDev: m.leadTimeSigmaDays,
      leadTimeCv: Number((m.leadTimeSigmaDays / m.leadTimeDays).toFixed(3)),
      autoLeadTimeCv: Number((m.leadTimeSigmaDays / m.leadTimeDays).toFixed(3)),
      leadTimeCvOverridden: false,
      seasonalityWeights: [0.25, 0.25, 0.5],
      defaultSeasonalityWeights: [0.25, 0.25, 0.5],
      seasonalityWeightsOverridden: false,
      poObservations: 6,
      typicalRollFootage: m.typicalRollFt,
      autoTypicalRollFootage: m.typicalRollFt,
      typicalRollFootageOverridden: false,
      safetyStockFootage: m.safetyStockFt,
      reorderPointFootage: Math.round(m.safetyStockFt + avgWeekly * (m.leadTimeDays / 7)),
      autoReorderPointFootage: Math.round(
        m.safetyStockFt + avgWeekly * (m.leadTimeDays / 7),
      ),
      reorderPointOverridden: false,
      maxFootage: Math.round(m.safetyStockFt * 3),
      autoMaxFootage: Math.round(m.safetyStockFt * 3),
      maxFootageOverridden: false,
      eoqFootage: m.typicalRollFt * 2,
      eoqRolls: 2,
      orderQtySource: "eoq" as const,
      discontinued: false,
      inactive: false,
      demandFromStockId: null,
      alternateStockIds: m.alternateStockIds.join(","),
      availableFootage: Math.round(available),
      suggestedOrderFootage: f.recommendFt,
      suggestedOrderRolls: f.recommendRolls,
      suggestedWidths: f.recommendRolls
        ? [
            {
              width: m.masterWidthIn,
              footage: f.recommendFt,
              rolls: f.recommendRolls,
              reason: "master width",
            },
          ]
        : [],
      belowMin: m.onHandFt < m.safetyStockFt + avgWeekly * (m.leadTimeDays / 7),
      openTicketFootage: Math.round(f.weeks[0]!.namedDemand),
      committedWithinLeadFootage: Math.round(f.weeks[1]!.namedDemand),
      committedShortageFootage: 0,
      reorderMethod: "statistical" as const,
      leadTimeDemandSamples: 6,
      reorderReason: f.recommendRolls > 0 ? ("below_rop" as const) : ("none" as const),
      daysOfCover:
        avgWeekly > 0 ? Math.round((m.onHandFt / avgWeekly) * 7) : 999,
      openPoCount: m.onOrder.length,
      openPoRolls: Math.round(openPoFootage / m.typicalRollFt),
      openPoFootage,
      lastUsedDate: iso(3),
      daysSinceLastUse: 3,
      activityStatus: "active" as const,
      customized: false,
      dazpak: null,
    };
  });
}

/* -------------------------------------------------------------- routing --- */

function route(path: string, search: URLSearchParams, method: string): unknown {
  // ---- Better Auth session (lets RequireAuth through without a real login)
  if (path.endsWith("/api/auth/get-session")) {
    return {
      user: MOCK_USER,
      session: {
        id: "mock-session-1",
        token: "mock-token",
        userId: MOCK_USER.id,
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      },
    };
  }
  if (path.includes("/api/auth/")) return { status: true };

  const p = path.replace(/^.*\/api/, "");

  switch (true) {
    case p === "/me":
      return {
        email: MOCK_USER.email,
        name: MOCK_USER.name,
        appRole: "admin",
        appStatus: "active",
      };

    case p === "/healthz":
      return { ok: true };

    case p === "/gateway/health":
      return {
        reachable: true,
        odbcConnected: true,
        latencyMs: 118,
        error: null,
        gatewayDegraded: false,
        gatewayImpact: null,
        syncAges: [
          { source: "labeltraxx_rolls", label: "Label Traxx rolls", syncedAt: iso(0), minutesAgo: 12 },
          { source: "labeltraxx_api", label: "Label Traxx API", syncedAt: iso(0), minutesAgo: 47 },
          { source: "netsuite", label: "NetSuite", syncedAt: iso(0), minutesAgo: 63 },
        ],
      };

    case p.startsWith("/demand/summary"): {
      const items = demandItems();
      return {
        windowFrom: iso(180),
        windowTo: iso(0),
        monthsBack: Number(search.get("monthsBack") ?? 6),
        serviceLevel: Number(search.get("serviceLevel") ?? 0.95),
        forecastWeeks: 12,
        generatedAt: new Date().toISOString(),
        items,
      };
    }

    case p.startsWith("/inventory/on-hand"): {
      const total = MATERIALS.reduce(
        (a, m) => a + (m.onHandFt * 12 * m.masterWidthIn * m.costMsi) / 1000,
        0,
      );
      return {
        totalValue: Math.round(total),
        rollCount: MATERIALS.reduce(
          (a, m) => a + Math.round(m.onHandFt / m.typicalRollFt),
          0,
        ),
      };
    }

    // Shape per GetAdjustmentsTimeseries200 + TimeseriesPoint.
    case p.startsWith("/adjustments/timeseries"): {
      const bucket = search.get("bucket") ?? "week";
      const n = bucket === "month" ? 6 : 12;
      const step = bucket === "month" ? 30 : 7;
      return {
        bucket,
        from: iso(n * step).slice(0, 10),
        to: iso(0).slice(0, 10),
        points: Array.from({ length: n }, (_, i) => {
          const k = n - 1 - i;
          const added = 1200 + ((k * 137) % 900);
          const removed = 1500 + ((k * 211) % 1100);
          return {
            periodStart: iso(k * step + step - 1).slice(0, 10),
            periodEnd: iso(k * step).slice(0, 10),
            label: iso(k * step).slice(0, 10),
            added,
            removed,
            net: added - removed,
            addedCount: 3 + (k % 5),
            removedCount: 4 + (k % 6),
          };
        }),
      };
    }

    // Shape per AdjustmentTotals — the Overview reads `net` directly.
    case p.startsWith("/adjustments/totals"):
      return {
        added: 16580,
        removed: 21612,
        net: -5032,
        addedCount: 44,
        removedCount: 68,
      };

    // Shape per CycleCountKpi. `status` must be one of the three enum values —
    // CycleCountKpi indexes STATUS_COPY with it and only guards `!data`.
    case p === "/cycle-counts/kpi":
      return CYCLE_KPI;

    // Shape per CycleCountScheduleResponse.
    case p.startsWith("/cycle-counts/schedule"):
      return {
        quarter: "2026-Q3",
        startDate: "2026-07-01",
        endDate: "2026-09-30",
        consolidated: true,
        generatedAt: new Date().toISOString(),
        kpi: CYCLE_KPI,
        weeks: Array.from({ length: 13 }, (_, i) => ({
          week: i + 1,
          weekStart: iso(-(i * 7)).slice(0, 10),
          weekEnd: iso(-(i * 7 + 6)).slice(0, 10),
          expected: 2,
          completed: i < 5 ? 2 : 0,
          tasks: MATERIALS.slice(i % 4, (i % 4) + 2).map((m, j) => ({
            stockId: m.stockId,
            description: m.description,
            abcClass: j === 0 ? "A" : "B",
            onHandFootage: m.onHandFt,
            completedAt: i < 5 ? iso(i * 7).slice(0, 10) : null,
          })),
        })),
      };

    case p.startsWith("/demand/purchasing"):
      return { items: [], generatedAt: new Date().toISOString() };

    case p.startsWith("/demand/po-agent"):
      return { drafts: [], needsAttention: [], lessons: [] };

    // Shape per MrpResult / MrpRow / MrpCell / MrpDrivers.
    case p.startsWith("/demand/mrp"): {
      const forecasts = buildAllForecasts({ scenarios: 400 });
      const weeks = forecasts[0]!.weeks.map((w) => ({
        weekStart: iso(-w.week * 7).slice(0, 10),
        weekEnd: iso(-w.week * 7 - 6).slice(0, 10),
        label: `W${w.week}`,
      }));
      let shortageCount = 0;
      const rows = forecasts.map((f) => {
        const m = f.material;
        const avgWeekly = Math.round(
          f.weeks.reduce((a, w) => a + w.expectedDemand, 0) / f.weeks.length,
        );
        const firstShortage = f.weeks.find((w) => w.p50 < 0)?.week;
        if (firstShortage != null) shortageCount++;
        return {
          stockId: m.stockId,
          description: m.description,
          widthKey: m.masterWidthIn <= 14 ? "le13" : String(m.masterWidthIn),
          widthLabel: `${m.masterWidthIn}"`,
          width: m.masterWidthIn,
          pooled: m.masterWidthIn <= 14,
          vendorName: m.supplierName,
          openingOnHand: m.onHandFt,
          cells: f.weeks.map((w, i) => ({
            weekStart: weeks[i]!.weekStart,
            weekEnd: weeks[i]!.weekEnd,
            label: weeks[i]!.label,
            bookedFootage: Math.round(w.namedDemand * 0.6),
            pendingFootage: Math.round(w.namedDemand * 0.4),
            statisticalFootage: Math.round(w.baselineNet),
            grossRequirement: Math.round(w.expectedDemand),
            scheduledReceipts: w.receipts,
            projectedOnHand: Math.round(w.p50),
            plannedOrderRelease:
              f.orderByWeek === w.week && f.gate === "OK" ? f.recommendFt : 0,
            plannedOrderRolls:
              f.orderByWeek === w.week && f.gate === "OK" ? f.recommendRolls : 0,
            plannedOrderReceipt: 0,
          })),
          drivers: {
            leadTimeDays: m.leadTimeDays,
            leadTimeSource: "stock",
            leadTimeOverridden: false,
            typicalRollFootage: m.typicalRollFt,
            typicalRollFootageOverridden: false,
            orderQuantityRolls: f.recommendRolls,
            serviceLevel: 0.95,
            reorderPointFootage: Math.round(
              m.safetyStockFt + avgWeekly * (m.leadTimeDays / 7),
            ),
            maxFootage: Math.round(m.safetyStockFt * 3),
            reorderBasis: "statistical",
            observations: 6,
            discontinued: false,
            alternates: m.alternateStockIds,
          },
          firstShortageWeek: firstShortage ?? null,
          firstShortageDate:
            firstShortage != null ? weeks[firstShortage]!.weekStart : null,
          plannedTotalFootage: f.gate === "OK" ? f.recommendFt : 0,
          lateReleaseFootage: f.lateByWeeks > 0 ? f.recommendFt : 0,
          orderQuantityIgnored: false,
          undatedReceiptFootage: 0,
        };
      });
      return {
        generatedAt: new Date().toISOString(),
        weeks,
        rows,
        shortageCount,
        lateReleaseCount: forecasts.filter((f) => f.lateByWeeks > 0).length,
        configWarnings: [],
      };
    }

    // Shape per EoReport / EoReportItem.
    case p.startsWith("/demand/eo-report"):
      return {
        windowFrom: iso(365).slice(0, 10),
        items: MATERIALS.filter((m) => m.isCustom || m.baselineWeeklyFt < 400).map(
          (m) => {
            const avgMonthly = m.baselineWeeklyFt * 4.33;
            return {
              stockId: m.stockId,
              description: m.description,
              inactive: false,
              discontinued: false,
              onHandFootage: m.onHandFt,
              rollCount: Math.max(1, Math.round(m.onHandFt / m.typicalRollFt)),
              valueUsd: Math.round(
                (m.onHandFt * 12 * m.masterWidthIn * m.costMsi) / 1000,
              ),
              valueIsEstimate: true,
              avgMonthlyFootage: Math.round(avgMonthly),
              monthsOfSupply:
                avgMonthly > 0 ? Number((m.onHandFt / avgMonthly).toFixed(1)) : null,
              lastUsedIso: m.isCustom ? iso(96).slice(0, 10) : iso(9).slice(0, 10),
              notes: null,
            };
          },
        ),
      };

    // Shape per SnapshotSummary. weekEnding must be a string — the Overview
    // sorts with localeCompare — and onHandValue/netAdjustment/adjustmentPct
    // are read without optional chaining once `latest` exists.
    case p.startsWith("/snapshots"):
      return {
        items: Array.from({ length: 12 }, (_, i) => {
          const wk = 11 - i;
          const onHandValue = 292000 + wk * 1600;
          const net = wk % 3 === 0 ? -5032 + wk * 210 : 2140 - wk * 90;
          return {
            id: `snap-${wk}`,
            weekStart: iso(wk * 7 + 6).slice(0, 10),
            weekEnding: iso(wk * 7).slice(0, 10),
            capturedAt: iso(wk * 7),
            onHandValue,
            rollCount: 690 + wk * 3,
            added: 16580 - wk * 120,
            removed: 21612 - wk * 90,
            netAdjustment: net,
            adjustmentPct: Number(((net / onHandValue) * 100).toFixed(2)),
          };
        }).reverse(),
      };

    case p.startsWith("/monthly-snapshots"):
      return {
        items: ["2026-05", "2026-06", "2026-07"].map((monthKey, i) => {
          const onHandValue = 296000 + i * 5400;
          const net = -3100 + i * 900;
          return {
            id: `msnap-${monthKey}`,
            monthKey,
            monthStart: `${monthKey}-01`,
            monthEnd: `${monthKey}-28`,
            capturedAt: `${monthKey}-28T23:59:00.000Z`,
            onHandValue,
            rollCount: 700 + i * 6,
            added: 61200 + i * 800,
            removed: 64300 - i * 100,
            netAdjustment: net,
            adjustmentPct: Number(((net / onHandValue) * 100).toFixed(2)),
          };
        }),
      };

    // Shape per GoalsResponse: { global, perStock }.
    case p === "/goals":
      return {
        global: {
          min: 250000,
          max: 420000,
          serviceLevel: 0.95,
          monthsBack: 6,
          demandCv: 0.3,
          leadTimeCv: 0.25,
          orderingCost: 250,
          carryingRatePct: 18,
          aslVendorGoal: 50,
        },
        perStock: [],
      };

    default:
      // Honest empty state rather than invented numbers.
      //
      // Every common collection key is present and empty on purpose. Several
      // components guard only `!data` and then do `data.<key>.map(...)`, so an
      // object missing the key crashes where an empty array renders fine. This
      // is why the fallback is not simply `{}`.
      return {
        items: [],
        points: [],
        rows: [],
        weeks: [],
        drafts: [],
        needsAttention: [],
        lessons: [],
        pipeline: [],
        rawMaterials: [],
        finishedGoods: [],
        aslSuppliers: [],
      };
  }
}

/* ------------------------------------------------------------- install --- */

let installed = false;

export function installMockApi(): void {
  if (installed) return;
  installed = true;

  const realFetch = window.fetch.bind(window);

  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    let pathname: string;
    try {
      pathname = new URL(rawUrl, window.location.origin).pathname;
    } catch {
      return realFetch(input, init);
    }

    if (!pathname.includes("/api/")) return realFetch(input, init);

    const method = (
      init?.method ??
      (typeof input === "object" && "method" in input ? input.method : "GET")
    ).toUpperCase();

    const search = new URL(rawUrl, window.location.origin).searchParams;

    let body: unknown;
    try {
      body = route(pathname, search, method);
    } catch (err) {
      // A mock that throws would look like a server error; surface it loudly
      // in the console but keep the page rendering.
      console.error("[mock-api] route failed", pathname, err);
      body = { items: [] };
    }

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-auth-token": "mock-token",
      },
    });
  };

  console.info(
    "%c[mock-api] active — all /api calls are invented. No live connections.",
    "color:#b45309;font-weight:600",
  );
}
