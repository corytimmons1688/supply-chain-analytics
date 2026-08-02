import * as React from "react";
import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";

const CHECK_THROTTLE_MS = 60_000;
const PERIODIC_CHECK_MS = 15 * 60_000;

/**
 * Detects version skew in long-lived tabs. The running bundle carries
 * __BUILD_ID__; every deploy also ships a version.json with the id it was
 * built with. When the tab regains focus (and every 15 min while visible) we
 * compare the two — a mismatch means the user is running yesterday's frontend
 * against today's API, so we offer a one-click refresh. Renders nothing.
 */
export function VersionWatcher() {
  React.useEffect(() => {
    if (import.meta.env.DEV) return;
    let lastCheck = 0;
    let notified = false;

    const check = async () => {
      if (notified || document.visibilityState !== "visible") return;
      if (Date.now() - lastCheck < CHECK_THROTTLE_MS) return;
      lastCheck = Date.now();
      try {
        const r = await fetch(`${import.meta.env.BASE_URL}version.json`, { cache: "no-store" });
        if (!r.ok) return;
        const v = (await r.json()) as { buildId?: string };
        if (v.buildId && v.buildId !== __BUILD_ID__) {
          notified = true;
          toast({
            title: "Update available",
            description: "A newer version of the dashboard has been deployed. Refresh to pick it up.",
            duration: 60 * 60_000,
            action: (
              <ToastAction altText="Refresh now" onClick={() => window.location.reload()}>
                Refresh
              </ToastAction>
            ),
          });
        }
      } catch {
        // Offline or transient network error — try again on the next trigger.
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const interval = window.setInterval(() => void check(), PERIODIC_CHECK_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(interval);
    };
  }, []);
  return null;
}
