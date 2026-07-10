// Bundles the Express app into /api/index.mjs for Vercel serverless.
// Mirrors build.mjs but uses the no-listener entry (scheduling is handled by
// Vercel Cron hitting /api/cron/snapshots) and skips the pino worker plugin —
// in production pino logs synchronously with no transport, so plain bundling
// is safe.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

await esbuild({
  entryPoints: [path.resolve(artifactDir, "src/serverless.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outfile: path.resolve(artifactDir, "../../api/index.mjs"),
  logLevel: "info",
  external: ["*.node", "pg-native"],
  banner: {
    js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
`,
  },
});
