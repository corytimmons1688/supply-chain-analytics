/**
 * Carrier/PRO tracking parsing now lives in @workspace/carrier-tracking so the
 * API server can render the same tracking links in the weekday digest email.
 * Re-exported here to keep existing imports stable.
 */
export * from "@workspace/carrier-tracking";
