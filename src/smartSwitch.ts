import type { CooldownHistory } from "./types";

/**
 * Smart switch algorithm — picks the next best account given the current UI
 * state (filtered candidates), the current account and the cooldown history.
 *
 * Rules (v5 plan, 2026-04):
 *
 *  Hard exclude (never switched to):
 *    - id === currentAccountId
 *    - within 15-minute cooldown
 *    - not synced (quotaError OR lastQueryTime empty)
 *    - yahoo email (yahoo.com / yahoo.co.jp / yahoo.co.uk / ...)
 *    - Free plan
 *    - weeklyRemainPct is null or 0
 *    - dailyRemainPct is null or 0
 *
 *  Soft exclude (relaxed if no candidate passes):
 *    - dailyRemainPct < 10
 *
 *  Time-based pool + sort (local system time):
 *    - within 24h before NEXT Saturday 16:00:
 *        pool = candidates.filter(weekly > 50); fallback to candidates
 *        sort by weekly desc -> daily desc -> email asc
 *    - within 24h before NEXT Sunday 16:00:
 *        pool = candidates (no weekly-tier filtering)
 *        sort by weighted score desc -> email asc
 *        score = min(weeklyRemainPct * 2, dailyRemainPct * 1)
 *    - otherwise (normal):
 *        pool = candidates.filter(weekly > 50); fallback to candidates
 *        sort by weekly desc -> daily desc -> email asc
 *
 *  Return up to top-3 for the caller to retry on switch failure.
 */
export const SMART_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
export const HISTORY_TTL_MS = 24 * 60 * 60 * 1000; // drop entries older than 24h
const YAHOO_REGEX = /@yahoo\.[a-z.]+$/i;
export function isYahooEmail(email) {
    return YAHOO_REGEX.test(email || '');
}
export function isFreePlan(plan) {
    return (plan || '').toLowerCase() === 'free';
}
export function isSynced(a) {
    return !a.quotaError && !!a.lastQueryTime;
}
/** Returns true iff the account is in the 15-min smart-switch cooldown. */
export function isInCooldown(accountId: string, history: CooldownHistory, now = Date.now()): boolean {
    const t = history[accountId];
    if (!t)
        return false;
    return now - t < SMART_COOLDOWN_MS;
}
/** Lazy-clean cooldown history (keep < 24h entries). Returns a NEW object. */
export function pruneHistory(history: CooldownHistory, now = Date.now()): CooldownHistory {
    const out: CooldownHistory = {};
    for (const [id, t] of Object.entries(history)) {
        if (now - t < HISTORY_TTL_MS) {
            out[id] = t;
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
// Time window detection
// ---------------------------------------------------------------------------
/**
 * Returns ms from `now` to the next occurrence of the given weekday at 16:00
 * local time. dayOfWeek: 0=Sun, 1=Mon, ..., 6=Sat.
 *
 * If today is the target day and it's still before 16:00, returns ms until
 * today 16:00; if it's past 16:00 today, returns ms until next week same day.
 */
export function msUntilNextDayAt16(now, targetDay) {
    const target = new Date(now);
    target.setHours(16, 0, 0, 0);
    const currentDay = now.getDay();
    let daysAhead = (targetDay - currentDay + 7) % 7;
    if (daysAhead === 0 && now.getTime() >= target.getTime()) {
        daysAhead = 7;
    }
    target.setDate(target.getDate() + daysAhead);
    return target.getTime() - now.getTime();
}
export function currentStrategy(now = new Date()) {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const msToSat = msUntilNextDayAt16(now, 6);
    const msToSun = msUntilNextDayAt16(now, 0);
    // Both windows may exist simultaneously (Sat 16:00 - Sun 16:00), msToSun is smaller then, use sun24h.
    if (msToSun > 0 && msToSun <= DAY_MS)
        return 'sun24h';
    if (msToSat > 0 && msToSat <= DAY_MS)
        return 'sat24h';
    return 'normal';
}
function emptyStats() {
    return { self: 0, cooldown: 0, unsynced: 0, yahoo: 0, free: 0, noWeekly: 0, noDaily: 0, lowDaily: 0 };
}
function hasValue(n) {
    return typeof n === 'number' && n > 0;
}
/**
 * Apply hard excludes. Returns candidates and a stats object so the caller
 * can compose a helpful "no candidates" message.
 */
function applyHardExclude(accounts, opts) {
    const stats = emptyStats();
    const pool = [];
    for (const a of accounts) {
        if (a.id === opts.currentAccountId) {
            stats.self++;
            continue;
        }
        if (isInCooldown(a.id, opts.history, opts.now)) {
            stats.cooldown++;
            continue;
        }
        if (!isSynced(a)) {
            stats.unsynced++;
            continue;
        }
        if (isYahooEmail(a.email)) {
            stats.yahoo++;
            continue;
        }
        if (isFreePlan(a.planName)) {
            stats.free++;
            continue;
        }
        if (!hasValue(a.weeklyRemainPct)) {
            stats.noWeekly++;
            continue;
        }
        if (!hasValue(a.dailyRemainPct)) {
            stats.noDaily++;
            continue;
        }
        pool.push(a);
    }
    return { pool, stats };
}
function partitionByDaily10(pool) {
    const poolA = [];
    const poolB = [];
    for (const a of pool) {
        if ((a.dailyRemainPct ?? 0) >= 10) {
            poolA.push(a);
        }
        else {
            poolB.push(a);
        }
    }
    return { poolA, poolB };
}
const byEmailAsc = (a, b) => (a.email || '').localeCompare(b.email || '');
function byNumberDesc(getter) {
    return (a, b) => (getter(b) ?? 0) - (getter(a) ?? 0);
}
function chain(...cmps) {
    return (a, b) => {
        for (const c of cmps) {
            const d = c(a, b);
            if (d !== 0)
                return d;
        }
        return 0;
    };
}
/**
 * sun24h weighted score:
 *   Weekly 1% = 2 pts, Daily 1% = 1 pt, take lower of both as account score.
 *   Sort by score desc; tie-break by email asc.
 *   Example: W 80 / D 5 → min(160, 5) = 5; W 40 / D 60 → min(80, 60) = 60.
 *   This makes daily quota an effective filter for bottleneck accounts.
 */
function sun24hScore(a) {
    const w = a.weeklyRemainPct ?? 0;
    const d = a.dailyRemainPct ?? 0;
    return Math.min(w * 2, d * 1);
}
function sortForStrategy(list, strategy) {
    const weeklyDesc = byNumberDesc(a => a.weeklyRemainPct);
    const dailyDesc = byNumberDesc(a => a.dailyRemainPct);
    if (strategy === 'sun24h') {
        const scoreDesc = (a, b) => sun24hScore(b) - sun24hScore(a);
        return list.slice().sort(chain(scoreDesc, byEmailAsc));
    }
    // sat24h + normal share the same sort: weekly desc -> daily desc -> email
    return list.slice().sort(chain(weeklyDesc, dailyDesc, byEmailAsc));
}
function applyWeeklyTier(pool, strategy) {
    if (strategy === 'sun24h')
        return pool;
    const high = pool.filter(a => (a.weeklyRemainPct ?? 0) > 50);
    return high.length ? high : pool;
}
function strategyReason(strategy) {
    switch (strategy) {
        case 'sat24h':
            return 'Less than 24h until Sat 16:00, prioritize high weekly quota accounts';
        case 'sun24h':
            return 'Less than 24h until Sun 16:00 (weekly quota resetting soon), sort by weighted score (W×2 / D×1 take lower)';
        default:
            return 'Prioritize high weekly quota accounts to avoid post-weekend waste';
    }
}
function formatExcludeReason(stats) {
    const parts = [];
    if (stats.self)
        parts.push(`Self×1`);
    if (stats.cooldown)
        parts.push(`Cooldown×${stats.cooldown}`);
    if (stats.unsynced)
        parts.push(`Unsynced×${stats.unsynced}`);
    if (stats.yahoo)
        parts.push(`Yahoo×${stats.yahoo}`);
    if (stats.free)
        parts.push(`Free×${stats.free}`);
    if (stats.noWeekly)
        parts.push(`Weekly=0×${stats.noWeekly}`);
    if (stats.noDaily)
        parts.push(`Daily=0×${stats.noDaily}`);
    return parts.length ? `Excluded ${parts.join(' · ')}` : '';
}
/**
 * Runs the full smart-switch pipeline and returns a decision object.
 * The caller is responsible for:
 *   - attempting to switch to `picked`; on failure, walking `candidates[1..]`.
 *   - calling `recordSwitch` to update history after success.
 */
export function decide(opts) {
    const now = opts.now ?? new Date();
    const nowMs = now.getTime();
    const strategy = currentStrategy(now);
    const { pool: afterHard, stats } = applyHardExclude(opts.accounts, {
        currentAccountId: opts.currentAccountId,
        history: opts.history,
        now: nowMs
    });
    const { poolA, poolB } = partitionByDaily10(afterHard);
    const mainPool = poolA.length ? poolA : poolB;
    if (poolA.length === 0 && poolB.length > 0) {
        stats.lowDaily = poolB.length;
    }
    if (mainPool.length === 0) {
        const reason = formatExcludeReason(stats) || 'No switchable accounts';
        return { picked: null, candidates: [], reason, strategy };
    }
    const tier = applyWeeklyTier(mainPool, strategy);
    const ordered = sortForStrategy(tier, strategy);
    return {
        picked: ordered[0] ?? null,
        candidates: ordered,
        reason: strategyReason(strategy),
        strategy
    };
}
/** Record a successful smart switch into a NEW history map. */
export function recordSwitch(history, accountId, now = Date.now()) {
    const pruned = pruneHistory(history, now);
    pruned[accountId] = now;
    return pruned;
}
