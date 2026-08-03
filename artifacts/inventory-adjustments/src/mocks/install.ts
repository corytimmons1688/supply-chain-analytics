/**
 * Side-effect module: patches window.fetch on import.
 *
 * Must be the FIRST import in main.tsx. Static imports are evaluated in order
 * and before any top-level await, so anything that captures a `fetch`
 * reference at module-eval time (better-auth does) must see the patched one.
 *
 * Inert unless VITE_MOCK_API is set.
 */

if (import.meta.env.VITE_MOCK_API) {
  const { installMockApi } = await import("./mock-api");
  installMockApi();
}

export {};
