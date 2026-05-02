"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map