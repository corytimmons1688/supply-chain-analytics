import cron from "node-cron";
import { captureSnapshot } from "./snapshot-service";
import { captureMonthlySnapshot } from "./monthly-snapshot-service";
import { logger } from "./logger";

let started = false;

/**
 * Schedules:
 *  - weekly snapshot every Sunday at 23:59 America/Denver
 *  - monthly snapshot at 23:59 America/Denver on the last day of each month
 */
export function startSnapshotCron(): void {
  if (started) return;
  started = true;

  // Weekly: every Sunday 23:59 MT
  cron.schedule(
    "59 23 * * 0",
    async () => {
      try {
        await captureSnapshot();
      } catch (err) {
        logger.error({ err }, "Weekly snapshot cron failed");
      }
    },
    { timezone: "America/Denver" },
  );

  // Monthly: 23:59 MT on days 28-31; only fire if tomorrow is a new month.
  cron.schedule(
    "59 23 28-31 * *",
    async () => {
      try {
        const fmt = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Denver",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const todayMonth = fmt.formatToParts(now).find((p) => p.type === "month")?.value;
        const tomorrowMonth = fmt
          .formatToParts(tomorrow)
          .find((p) => p.type === "month")?.value;
        if (todayMonth === tomorrowMonth) return;
        await captureMonthlySnapshot();
      } catch (err) {
        logger.error({ err }, "Monthly snapshot cron failed");
      }
    },
    { timezone: "America/Denver" },
  );

  logger.info(
    "Snapshot cron scheduled: weekly Sun 23:59 MT, monthly last-day 23:59 MT",
  );
}
