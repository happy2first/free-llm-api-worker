import type { Db } from '../db/types.js';
// Host opt-in. Desktop/Docker retain their original persistence and health policy.
export interface RuntimePolicy {
  cloudflare?: boolean;
  emit?: (event: { type: string; platform: string; model: string; status: string; requestType?: string; input?: number; output?: number; latency?: number; fallback?: number }) => void;
}
export const runtimePolicy: RuntimePolicy = {};
export function configureRuntime(policy: RuntimePolicy): void { Object.assign(runtimePolicy, policy); }
export const recentHealthyKeys = new Map<number, number>();
export function requestRelation(): string {
  return runtimePolicy.cloudflare
    ? `(SELECT platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms, error, created_at, request_type FROM requests UNION ALL SELECT platform, model_id, key_id, 'success' AS status, input_tokens, output_tokens, latency_ms, ttfb_ms, NULL AS error, created_at, request_type FROM cloudflare_routing_events)`
    : 'requests';
}

// Dashboard-only month totals: avoid rescanning a month of traffic on every
// fallback page poll. Router scoring and admission do not use this cache.
let displayUsage: { db: Db; month: string; until: number; rows: { platform: string; model_id: string; used: number }[] } | undefined;
export function monthlyUsageForDisplay(db: Db, read: () => { platform: string; model_id: string; used: number }[]) {
  if (!runtimePolicy.cloudflare) return read();
  const now = Date.now(), month = new Date(now).toISOString().slice(0, 7);
  if (!displayUsage || displayUsage.db !== db || displayUsage.month !== month || now >= displayUsage.until) displayUsage = { db, month, until: now + 60_000, rows: read() };
  return displayUsage.rows;
}
