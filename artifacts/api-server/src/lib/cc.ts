/** Parse a CC date string like "CC 4/16/26" or "cc 04/22/26." → ISO YYYY-MM-DD. */
const CC_REGEX = /^\s*cc\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\.?/i;

export function parseCcDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = CC_REGEX.exec(input);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  if (year < 100) year = 2000 + year;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

export type Bucket = "day" | "week" | "month" | "quarter" | "year";

/** Returns [periodStart, periodEnd] inclusive YYYY-MM-DD strings for the bucket containing isoDate. Week starts on Monday. */
export function bucketRange(isoDate: string, bucket: Bucket): { start: string; end: string; label: string } {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  switch (bucket) {
    case "day":
      return { start: isoDate, end: isoDate, label: isoDate };
    case "week": {
      const dow = date.getUTCDay(); // 0=Sun..6=Sat
      const offsetToMonday = (dow + 6) % 7;
      const start = new Date(date);
      start.setUTCDate(date.getUTCDate() - offsetToMonday);
      const end = new Date(start);
      end.setUTCDate(start.getUTCDate() + 6);
      return { start: fmt(start), end: fmt(end), label: `Wk of ${fmt(start)}` };
    }
    case "month": {
      const start = new Date(Date.UTC(y!, m! - 1, 1));
      const end = new Date(Date.UTC(y!, m!, 0));
      return { start: fmt(start), end: fmt(end), label: `${y}-${String(m).padStart(2, "0")}` };
    }
    case "quarter": {
      const q = Math.floor((m! - 1) / 3);
      const start = new Date(Date.UTC(y!, q * 3, 1));
      const end = new Date(Date.UTC(y!, q * 3 + 3, 0));
      return { start: fmt(start), end: fmt(end), label: `${y} Q${q + 1}` };
    }
    case "year": {
      const start = new Date(Date.UTC(y!, 0, 1));
      const end = new Date(Date.UTC(y!, 11, 31));
      return { start: fmt(start), end: fmt(end), label: String(y) };
    }
  }
}

function fmt(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Iterate buckets between fromIso and toIso inclusive; yields period start ISO. */
export function* eachBucket(fromIso: string, toIso: string, bucket: Bucket): Generator<string> {
  let cursor = bucketRange(fromIso, bucket).start;
  while (cursor <= toIso) {
    yield cursor;
    const { end } = bucketRange(cursor, bucket);
    const next = addDays(end, 1);
    cursor = bucketRange(next, bucket).start;
    if (cursor > toIso) break;
  }
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return fmt(dt);
}
