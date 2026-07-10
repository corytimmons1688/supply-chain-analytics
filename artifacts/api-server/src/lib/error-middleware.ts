import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger";

interface ZodIssue {
  path: (string | number)[];
  message: string;
  code: string;
}

interface ZodErrorLike {
  name: string;
  issues: ZodIssue[];
}

function isZodError(err: unknown): err is ZodErrorLike {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ZodError" &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (isZodError(err)) {
    res.status(400).json({
      error: "Invalid request",
      details: err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
        code: i.code,
      })),
    });
    return;
  }
  if (
    err instanceof Error &&
    /Invalid '(from|to)' parameter/.test(err.message)
  ) {
    res.status(400).json({ error: err.message });
    return;
  }
  logger.error({ err }, "API error");
  const message = err instanceof Error ? err.message : "Internal error";
  res.status(500).json({ error: message });
}
