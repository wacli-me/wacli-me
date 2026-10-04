// Plans, quota and the usage counter behind them.
//
// The thing worth remembering: cost here is per linked account, not per
// request. A store holds a permanently running `wacli sync --follow` and the
// whole history on disk, so an account that links once and never asks anything
// still costs every month. A request limit alone would cap the wrong number.
// That is why the free plan also has a history window and an idle expiry — the
// request count is only the part people notice.

import fs from "node:fs";
import path from "node:path";

export const PLANS = {
  free: {
    id: "free",
    label: "Free",
    requestsPerMonth: 50,
    // Older messages are pruned; the store never grows without bound.
    historyDays: 30,
    // No request for this long and the store is deleted, after a warning if we
    // have an address. Also what Article 5(1)(e) asks for.
    idleDays: 14,
  },
  "self-hosted": {
    id: "self-hosted",
    label: "Self-hosted",
    requestsPerMonth: Infinity,
    // The operator owns the store and is responsible for its retention.
    historyDays: null,
    idleDays: null,
  },
  pro: {
    id: "pro",
    label: "Pro",
    requestsPerMonth: Infinity,
    historyDays: null,
    idleDays: null,
  },
};

// A Pro grant carries the date the paid period runs to. Past that date the
// account falls back to free on its own, so a missed cancellation webhook can
// never leave someone on Pro forever — the grant expires rather than needing
// to be revoked. Self-hosted tenants are controlled by the local operator.
export function planFor(tenant) {
  if (!tenant) return PLANS.free;
  const plan = PLANS[tenant.plan];
  if (!plan || plan.id === "free") return PLANS.free;
  if (plan.id === "pro" && tenant.planUntil && Date.parse(tenant.planUntil) < Date.now()) {
    return PLANS.free;
  }
  return plan;
}

function monthKey(at = new Date()) {
  return at.toISOString().slice(0, 7); // YYYY-MM, UTC
}

export class Usage {
  constructor(file) {
    this.file = file;
    this.dirty = false;
    this.data = this.#read();
    // Writing on every tool call would mean a disk write per request for no
    // benefit; losing a few seconds of counts on a crash is the better trade.
    this.timer = setInterval(() => this.flush(), 10_000);
    this.timer.unref?.();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  #entry(tenantId) {
    let entry = this.data[tenantId];
    if (!entry) {
      entry = { month: monthKey(), count: 0, lastSeenAt: null };
      this.data[tenantId] = entry;
    }
    const now = monthKey();
    if (entry.month !== now) {
      entry.month = now;
      entry.count = 0;
    }
    return entry;
  }

  // Read the counter without touching it, for status output.
  peek(tenantId) {
    const entry = this.#entry(tenantId);
    return { used: entry.count, month: entry.month, lastSeenAt: entry.lastSeenAt };
  }

  // Count one billable call. Returns whether it was allowed — the caller
  // rejects, so an over-quota request never reaches wacli.
  consume(tenantId, plan) {
    const entry = this.#entry(tenantId);
    entry.lastSeenAt = new Date().toISOString();
    this.dirty = true;
    if (entry.count >= plan.requestsPerMonth) {
      return { ok: false, used: entry.count, limit: plan.requestsPerMonth };
    }
    entry.count += 1;
    return { ok: true, used: entry.count, limit: plan.requestsPerMonth };
  }

  // Any authenticated contact keeps an account alive, even one over quota —
  // being out of requests must not also delete the store.
  touch(tenantId) {
    this.#entry(tenantId).lastSeenAt = new Date().toISOString();
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      this.dirty = false;
    } catch (err) {
      console.error(`[usage] could not write ${this.file}: ${err.message}`);
    }
  }
}
