// Bundles the Express app into /api/index.mjs for Vercel serverless.
// Mirrors build.mjs but uses the no-listener entry (no cron) and skips the
// pino worker plugin — in production pino logs synchronously with no
// transport, so plain bundling is safe. @google-cloud/* stays external
// (unbundleable) and is declared in the root package.json so it resolves
// from the /api directory at runtime.
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
  external: ["*.node", "pg-native", "@google-cloud/*", "googleapis"],
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
