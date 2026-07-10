// Serverless entry: exports the Express app without starting a listener or
// node-cron — snapshot scheduling runs via Vercel Cron (GET /api/cron/snapshots).
import app from "./app";

export default app;
