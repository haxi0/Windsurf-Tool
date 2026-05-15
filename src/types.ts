/**
 * Shared domain types. Restored from runtime usage (the original .d.ts is not
 * recoverable from compiled .js). Kept loose where the real shape varies — we
 * intentionally don't lock down every field so existing implicit-any code paths
 * don't break.
 *
 * The big ones:
 *   - Account                 — what the rest of the codebase passes around in memory
 *   - PersistedAccountRecord  — what's actually written to accounts.json on disk
 *   - LoginResult             — return shape of login / refresh / auth1PostAuth
 *   - PlanStatusSnapshot      — return shape of getPlanStatus (a Plan/quota slice)
 */

// ---------------------------------------------------------------------------
// Auth providers
// ---------------------------------------------------------------------------
export type AuthProvider = 'firebase' | 'auth1' | string;

// ---------------------------------------------------------------------------
// Plan / quota
// ---------------------------------------------------------------------------
/** Subset of an account that comes from the Windsurf plan API. Exactly the
 *  shape returned by `getPlanStatus`. Also written into Account on snapshot. */
export interface PlanStatusSnapshot {
    planName: string;
    /** 0..100 — remaining percentage of today's daily quota */
    dailyRemainPct: number;
    /** 0..100 — remaining percentage of this week's quota */
    weeklyRemainPct: number;
    /** Unix seconds — when daily quota resets next */
    dailyResetUnix: number | null;
    /** Unix seconds — when weekly quota resets next */
    weeklyResetUnix: number | null;
    /** ISO string or empty — plan period end */
    expiresAt: string;
    gracePeriodStatus: string;
    /** ISO string — when this snapshot was captured locally */
    lastQueryTime: string;
}

// ---------------------------------------------------------------------------
// Account (in-memory)
// ---------------------------------------------------------------------------
/** The decrypted, in-memory representation of an account. Used everywhere
 *  except in the actual on-disk file (which uses PersistedAccountRecord). */
export interface Account {
    id: string;
    email: string;
    /** Plain text password, only present after decryption / fresh login. */
    password?: string;
    displayName?: string;
    authProvider?: AuthProvider;

    /** Firebase localId (or auth1 user id), used to address the account remotely. */
    accountId?: string;
    primaryOrgId?: string;

    /** Tokens — empty string when missing. idToken is what authenticates API calls. */
    idToken?: string;
    refreshToken?: string;
    auth1Token?: string;
    /** Unix ms when the idToken expires. */
    idTokenExpiresAt?: number | null;

    createdAt?: string;

    /** Plan / quota cache (populated by snapshots). */
    planName?: string;
    dailyRemainPct?: number | null;
    weeklyRemainPct?: number | null;
    dailyResetUnix?: number | null;
    weeklyResetUnix?: number | null;
    expiresAt?: string;
    gracePeriodStatus?: string;
    lastQueryTime?: string;
    /** True if the most recent quota refresh failed; UI shows it as stale. */
    quotaError?: boolean;

    /** User remark / nickname shown above the account card. */
    remark?: string;

    /** Set after we've stashed a Windsurf session snapshot for this account. */
    hasWindsurfSessionSnapshot?: boolean;
    windsurfSessionCapturedAt?: string;

    /** True iff the account has any kind of credential we can re-authenticate with
     *  (password / refreshToken / auth1Token). Computed lazily. */
    hasCredentials?: boolean;
}

// ---------------------------------------------------------------------------
// Persisted record (what's on disk in accounts.json)
// ---------------------------------------------------------------------------
/** On-disk form. Secrets are stored as DPAPI/AES-encrypted base64 blobs. */
export interface PersistedAccountRecord {
    id: string;
    email: string;
    displayName?: string;
    authProvider?: AuthProvider;
    accountId?: string;
    primaryOrgId?: string;

    /** Encrypted blobs (base64). Null/empty when absent. */
    passwordProtected: string | null | undefined;
    idTokenProtected: string | null | undefined;
    refreshTokenProtected: string | null | undefined;
    auth1TokenProtected: string | null | undefined;

    idTokenExpiresAt?: number | null;
    createdAt?: string;

    planName?: string;
    dailyRemainPct?: number | null;
    weeklyRemainPct?: number | null;
    dailyResetUnix?: number | null;
    weeklyResetUnix?: number | null;
    expiresAt?: string;
    gracePeriodStatus?: string;
    lastQueryTime?: string;
    quotaError?: boolean;
    remark?: string;
    hasWindsurfSessionSnapshot?: boolean;
    windsurfSessionCapturedAt?: string;
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------
/** Unified return shape of firebaseLogin / auth1Login / login / firebaseRefresh /
 *  auth1PostAuth. Empty strings rather than undefined for tokens we didn't get. */
export interface LoginResult {
    idToken: string;
    refreshToken: string;
    authProvider: AuthProvider;
    auth1Token: string;
    accountId: string;
    primaryOrgId: string;
    displayName: string;
    /** How long the idToken is good for (seconds from now). */
    expiresInSeconds: number;
}

/** Plain credentials pair — what the user supplies on add / batch-import.
 *  For token-only accounts (browser sign-in / GitHub OAuth) the `password`
 *  field may be empty and `idToken` (a fully-resolved Windsurf api key,
 *  either `sk-ws-01...` for firebase or `devin-session-token$...` for
 *  auth1/devin) carries the credential instead. */
export interface Credentials {
    email: string;
    password: string;
    /** Optional Windsurf api key / firebase idToken / devin session token. */
    idToken?: string;
    /** Optional firebase refresh token (best-effort, may be empty). */
    refreshToken?: string;
    /** Optional auth1 token (best-effort, may be empty). */
    auth1Token?: string;
    /** Optional auth provider hint ('firebase' | 'auth1'). */
    authProvider?: AuthProvider;
    /** Optional display name hint. */
    displayName?: string;
}

// ---------------------------------------------------------------------------
// Smart switch
// ---------------------------------------------------------------------------
/** Map<accountId, lastSwitchedToAtMs>. Persisted in globalState. */
export interface CooldownHistory {
    [accountId: string]: number;
}

/** Stats returned by smartSwitch.decide describing why each candidate was filtered. */
export interface FilterStats {
    self: number;
    cooldown: number;
    unsynced: number;
    yahoo: number;
    free: number;
    noWeekly: number;
    noDaily: number;
    lowDaily: number;
}

// ---------------------------------------------------------------------------
// Auto-switch settings (mirrors the polling/log-watch sidebar toggles)
// ---------------------------------------------------------------------------
export interface AutoSwitchPolling {
    enabled: boolean;
    intervalMs: number;
}

export interface AutoSwitchLogWatch {
    enabled: boolean;
    patterns: string[];
}

export interface AutoSwitchState {
    polling: AutoSwitchPolling;
    logWatch: AutoSwitchLogWatch;
}

// ---------------------------------------------------------------------------
// Sidebar webview state (shared between extension host and webview)
// ---------------------------------------------------------------------------
export type SortMode = 'expiry' | 'quota';
export type SortDirection = 'asc' | 'desc';

export interface SortState {
    mode: SortMode;
    dir: SortDirection;
}

export interface FilterState {
    /** Each value is true when the filter is active. Shape is open — sidebar
     *  passes new keys through verbatim. */
    [key: string]: boolean;
}
