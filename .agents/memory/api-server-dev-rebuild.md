---
name: API server dev requires restart to rebuild
description: Why new api-server routes 404 until the workflow is restarted
---

The `artifacts/api-server` dev workflow runs `pnpm run build && pnpm run start`
(esbuild bundle, then `node dist/index.mjs`). There is **no watch/rebuild** — it
builds once at startup.

**Why:** After editing any api-server source (e.g. adding a route), the running
process still serves the old bundle, so new endpoints return 404 even though the
source is correct.

**How to apply:** After backend changes to `artifacts/api-server`, restart the
`artifacts/api-server: API Server` workflow before cur/testing. (The Vite web
artifact hot-reloads; the API server does not.) Routes are mounted under `/api`
(see `artifacts/api-server/src/app.ts`), and the internal port is 8080.
