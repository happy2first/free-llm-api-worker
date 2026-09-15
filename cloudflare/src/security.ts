// Access performs administrator authentication. Ordinary API admission is
// ephemeral: rate-limit binding at the edge, bounded memory fallback in the DO.
export class Admission {
  private buckets = new Map<string, { count: number; expires: number }>();
  admit(ip: string, now = Date.now()): boolean {
    let entry = this.buckets.get(ip);
    if (!entry || entry.expires <= now) {
      if (this.buckets.size >= 4096) {
        for (const [key, value] of this.buckets) if (value.expires <= now) this.buckets.delete(key);
        // Fail closed when full; do not evict a live bucket and reset its budget.
        if (this.buckets.size >= 4096) return false;
      }
      entry = { count: 0, expires: now + 60_000 };
      this.buckets.set(ip, entry);
    }
    return ++entry.count <= 240;
  }
}
