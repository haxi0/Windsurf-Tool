"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const accountsStore_1 = __importStar(require("./accountsStore"));
const constants_1 = __importStar(require("./constants"));
const log_1 = __importStar(require("./log"));
const importParser_1 = __importStar(require("./importParser"));
const memoryCreds_1 = __importStar(require("./memoryCreds"));
const dpapi_1 = __importStar(require("./dpapi"));
const seamlessSwitch_1 = __importStar(require("./seamlessSwitch"));
const sidebar_1 = __importStar(require("./sidebar"));
const tokens_1 = __importStar(require("./tokens"));
const windsurfApi_1 = __importStar(require("./windsurfApi"));
const windsurfPatcher_1 = __importStar(require("./windsurfPatcher"));
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const https = __importStar(require("https"));
const path = __importStar(require("path"));
const autoSwitch_1 = __importStar(require("./autoSwitch"));
const smartSwitch_1 = __importStar(require("./smartSwitch"));
const bundle_1 = __importStar(require("./bundle"));
// ---------------------------------------------------------------------------
// globalState keys for smart switch / Free throttle / current account.
// ---------------------------------------------------------------------------
const GS = {
    currentAccountId: 'wm.currentAccountId',
    activeEmail: 'wm.activeEmail',
    /**
     * Maps Windsurf's session display-name (account.label, e.g. "Ashley Lee")
     * to the corresponding email in accounts.json.  Populated every time we
     * perform a seamless switch (we know both sides at that moment) and by
     * the "claim current session" flow.  Used as the authoritative fallback
     * when Windsurf's session doesn't expose the email (accessToken is opaque).
     */
    sessionLabelMap: 'wm.sessionLabelMap',
    smartHistory: 'wm.smartSwitchHistory',
    refreshAllCounter: 'wm.refreshAllCounter'
};
/** Every 10th refreshAll includes Free accounts; others skip them. */
const FREE_REFRESH_EVERY_N = 10;
// ---------------------------------------------------------------------------
// Cross-window active-account synchronisation.
//
// VSCode's `globalState` (Memento) is *per-window, in-memory-cached*. The
// underlying SQLite is shared across windows but each window's extension host
// doesn't observe writes from sibling hosts — so if the user has multiple
// Windsurf windows open, a `doSwitch` in window A never reaches window B.
//
// To make "current account" consistent across windows we shadow-write it to a
// disk file (`<accountsDir>/active.json`) and fs.watch it for changes. Writes
// carry a per-window `WRITER_TOKEN` so the watcher can skip self-triggered
// events.
// ---------------------------------------------------------------------------
const ACTIVE_FILE_NAME = 'active.json';
/** A per-extension-host random token, so we can tell our own writes apart
 *  from writes issued by a sibling Windsurf window. */
const WRITER_TOKEN = crypto.randomBytes(8).toString('hex');
/** Coalesce bursty disk writes (a single doSwitch calls setCurrentAccountId +
 *  setActiveEmail back-to-back; we want one fs event, not two). */
let activeFileWriteTimer = null;
function getActiveFilePath() {
    return path.join((0, constants_1.getAccountsDir)(), ACTIVE_FILE_NAME);
}
/** Read the cross-window active-account file. Returns null on ENOENT or
 *  unparseable content; otherwise the `{ id, email, writer, updatedAt }`
 *  payload. */
function readActiveFileSync() {
    try {
        const raw = fs.readFileSync(getActiveFilePath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            return {
                id: typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : null,
                email: typeof parsed.email === 'string' && parsed.email.length > 0 ? parsed.email : null,
                writer: typeof parsed.writer === 'string' ? parsed.writer : '',
                updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
            };
        }
    }
    catch (e) {
        if (e?.code !== 'ENOENT') {
            (0, log_1.log)(`active.json read failed: ${e?.message || e}`);
        }
    }
    return null;
}
/** Persist the current memento values to `active.json`. Atomic temp+rename. */
function scheduleActiveFileWrite(ctx) {
    if (activeFileWriteTimer)
        return;
    activeFileWriteTimer = setTimeout(() => {
        activeFileWriteTimer = null;
        try {
            (0, accountsStore_1.ensureAccountsDir)();
            const payload = {
                id: ctx.globalState.get(GS.currentAccountId, null) || null,
                email: ctx.globalState.get(GS.activeEmail, null) || null,
                writer: WRITER_TOKEN,
                updatedAt: Date.now()
            };
            const file = getActiveFilePath();
            const tmp = file + '.tmp.' + process.pid;
            fs.writeFileSync(tmp, JSON.stringify(payload));
            fs.renameSync(tmp, file);
        }
        catch (e) {
            (0, log_1.log)(`active.json write failed: ${e?.message || e}`);
        }
    }, 25);
}
/** Pull from active.json into memento at startup, before any sync() runs. */
async function hydrateFromActiveFile(ctx) {
    const payload = readActiveFileSync();
    if (!payload)
        return;
    const curId = ctx.globalState.get(GS.currentAccountId, null) || null;
    const curEmail = ctx.globalState.get(GS.activeEmail, null) || null;
    // Only overwrite if the shared file has a *newer* / *different* value; we
    // don't want to resurrect a stale entry on top of a fresher local write.
    if (payload.id && payload.id !== curId) {
        await ctx.globalState.update(GS.currentAccountId, payload.id);
        (0, log_1.log)(`hydrate active.json → currentAccountId = ${payload.id}`);
    }
    if (payload.email && payload.email !== curEmail) {
        await ctx.globalState.update(GS.activeEmail, payload.email);
        (0, log_1.log)(`hydrate active.json → activeEmail = ${payload.email}`);
    }
}
/** Watch `active.json` for cross-window updates. Returns a disposable. */
function installActiveFileWatcher(ctx, sidebarProvider) {
    const file = getActiveFilePath();
    try {
        (0, accountsStore_1.ensureAccountsDir)();
    }
    catch { /* best-effort */ }
    let watcher = null;
    const pullFromFile = async () => {
        const payload = readActiveFileSync();
        if (!payload)
            return;
        if (payload.writer === WRITER_TOKEN)
            return; // our own write, already applied
        const curId = ctx.globalState.get(GS.currentAccountId, null) || null;
        const curEmail = ctx.globalState.get(GS.activeEmail, null) || null;
        let changed = false;
        if (payload.id && payload.id !== curId) {
            await ctx.globalState.update(GS.currentAccountId, payload.id);
            changed = true;
        }
        if (payload.email && payload.email !== curEmail) {
            await ctx.globalState.update(GS.activeEmail, payload.email);
            changed = true;
        }
        if (changed) {
            (0, log_1.log)(`active.json changed externally (writer=${payload.writer.slice(0, 4)}…) → id=${payload.id ?? '∅'}, email=${payload.email ?? '∅'}`);
            sidebarProvider?.invalidatePostCache?.();
            void sidebarProvider?.reload?.();
        }
    };
    const start = () => {
        try {
            watcher = fs.watch(file, { persistent: false }, () => { void pullFromFile(); });
            watcher.on('error', (e) => { (0, log_1.log)(`active.json watcher error: ${e?.message || e}`); });
        }
        catch (e) {
            // File may not exist yet; create empty so watch can succeed, then retry.
            if (e?.code === 'ENOENT') {
                try {
                    scheduleActiveFileWrite(ctx);
                    setTimeout(start, 100);
                }
                catch { /* give up */ }
            }
            else {
                (0, log_1.log)(`active.json watcher install failed: ${e?.message || e}`);
            }
        }
    };
    start();
    return {
        dispose() {
            try {
                watcher?.close();
            }
            catch { }
        }
    };
}
function getCurrentAccountId(ctx) {
    return ctx.globalState.get(GS.currentAccountId, null) || null;
}
/**
 * Write the cached current-account id. DEFENSIVELY REJECTS writes of null /
 * empty — clearing the current account must go through `clearCurrentAccount`
 * which takes an explicit reason. This plugs the "mysterious null" bug where
 * some background code path (shared-status reader, VSCode memento namespacing
 * quirk, Windsurf S()-chain re-render, etc.) kept nuking the value we'd just
 * set in doSwitch and leaving the user with a "No current account detected" UI.
 *
 * `callerHint` is printed in the log whenever a null slip-through is caught,
 * so we can finally identify what's trying to clear us.
 */
async function setCurrentAccountId(ctx, id, callerHint) {
    if (id === null || id === undefined || id === '') {
        const stack = new Error().stack?.split('\n').slice(2, 6).join(' | ') || '(no stack)';
        (0, log_1.log)(`[guard] blocked null write to currentAccountId via ${callerHint || 'unknown'} — stack: ${stack}`);
        return;
    }
    await ctx.globalState.update(GS.currentAccountId, id);
    scheduleActiveFileWrite(ctx);
}
function getActiveEmail(ctx) {
    return ctx.globalState.get(GS.activeEmail, null) || null;
}
/** Same defensive contract as setCurrentAccountId. See that function's docs. */
async function setActiveEmail(ctx, email, callerHint) {
    if (email === null || email === undefined || email === '') {
        const stack = new Error().stack?.split('\n').slice(2, 6).join(' | ') || '(no stack)';
        (0, log_1.log)(`[guard] blocked null write to activeEmail via ${callerHint || 'unknown'} — stack: ${stack}`);
        return;
    }
    await ctx.globalState.update(GS.activeEmail, email);
    scheduleActiveFileWrite(ctx);
}
/**
 * Explicit clear path. Use this (NOT setCurrentAccountId(ctx, null)) from
 * logout / deleteAccount / any genuine "user is no longer logged in" flow.
 * Writes both keys to null atomically and logs the reason.
 */
async function clearCurrentAccount(ctx, reason) {
    const prevId = ctx.globalState.get(GS.currentAccountId, null) || null;
    const prevEmail = ctx.globalState.get(GS.activeEmail, null) || null;
    await ctx.globalState.update(GS.currentAccountId, null);
    await ctx.globalState.update(GS.activeEmail, null);
    scheduleActiveFileWrite(ctx);
    if (prevId !== null || prevEmail !== null) {
        (0, log_1.log)(`clearCurrentAccount (${reason}): id=${prevId ?? '∅'} email=${prevEmail ?? '∅'} → ∅`);
    }
}
function getSessionLabelMap(ctx) {
    return ctx.globalState.get(GS.sessionLabelMap, {}) || {};
}
function normalizeLabel(label) {
    return (label || '').trim().toLowerCase();
}
/**
 * Record a `session.account.label` → email mapping.  Called whenever we
 * learn both sides (seamless switch, manual claim).  Cheap, idempotent.
 */
async function rememberSessionLabel(ctx, label, email) {
    const key = normalizeLabel(label);
    const val = (email || '').trim().toLowerCase();
    if (!key || !val)
        return;
    const map = getSessionLabelMap(ctx);
    if (map[key] === val)
        return;
    map[key] = val;
    await ctx.globalState.update(GS.sessionLabelMap, map);
    (0, log_1.log)(`sessionLabelMap: learned "${label}" → ${val}`);
}
function lookupEmailByLabel(ctx, label) {
    const key = normalizeLabel(label);
    if (!key)
        return null;
    const map = getSessionLabelMap(ctx);
    return map[key] || null;
}
/**
 * Returns the currently active Windsurf session via VS Code's auth API.
 * Returns undefined on any error or when there's no active session.
 *
 * Note: do NOT rely on session.account.label — Windsurf sets it to the
 * user's display name (e.g. "William Johnson"), not the email. Use
 * `extractEmailFromSession` below to get the real email.
 */
async function resolveActiveSession() {
    try {
        return await vscode.authentication.getSession(constants_1.WINDSURF_AUTH_PROVIDER_ID, ['Login'], { silent: true });
    }
    catch (e) {
        (0, log_1.log)('resolveActiveSession failed:', e?.message || e);
        return undefined;
    }
}
/**
 * Decode a JWT payload without signature validation. We only read claims
 * (`email`) to match against our local account list — verifying the signature
 * isn't necessary for that.
 */
function decodeJwtPayload(token) {
    if (!token || typeof token !== 'string')
        return null;
    const parts = token.split('.');
    if (parts.length < 2)
        return null;
    try {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
        const json = Buffer.from(b64 + pad, 'base64').toString('utf8');
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
}
/** Track sessions we've already diagnosed so the log isn't spammed on heartbeat. */
const _sessionDiagnoseCache = new Set();
/**
 * Pull the logged-in email from a session, trying multiple claim locations.
 * We've seen Windsurf builds that set `account.label` to the display name
 * ("William Johnson") rather than the email, so we go to the JWT directly.
 */
function extractEmailFromSession(session) {
    if (!session)
        return null;
    const payload = decodeJwtPayload(session.accessToken);
    // Known email-bearing claims across common providers:
    //   email         — Firebase / OAuth standard
    //   emails[0]     — Azure AD / Microsoft
    //   preferred_username — OIDC (sometimes email)
    //   upn           — Windows / AD
    const candidates = [];
    if (payload) {
        const pushIfStr = (v) => {
            if (typeof v === 'string' && v.trim())
                candidates.push(v.trim());
        };
        pushIfStr(payload.email);
        const emails = payload.emails;
        if (Array.isArray(emails))
            emails.forEach(pushIfStr);
        pushIfStr(payload.preferred_username);
        pushIfStr(payload.upn);
    }
    pushOnce(candidates, (session.account?.label || '').trim());
    pushOnce(candidates, (session.account?.id || '').trim());
    for (const c of candidates) {
        if (/@/.test(c))
            return c.toLowerCase();
    }
    // One-time diagnostic dump per session.id so the user can share logs if
    // matching fails. Avoid per-heartbeat spam.
    if (session.id && !_sessionDiagnoseCache.has(session.id)) {
        _sessionDiagnoseCache.add(session.id);
        const payloadKeys = payload ? Object.keys(payload).join(',') : '(no jwt)';
        (0, log_1.log)(`session diagnose: id=${session.id.slice(0, 8)}…` +
            ` label="${session.account?.label || ''}"` +
            ` account.id="${session.account?.id || ''}"` +
            ` jwtKeys=[${payloadKeys}]` +
            ` candidates=[${candidates.join('|')}]`);
    }
    return null;
}
function pushOnce(list, v) {
    if (v && !list.includes(v))
        list.push(v);
}
function readSharedJsonObject(context, key) {
    const raw = context.globalState.get(key);
    if (raw === undefined)
        return { exists: false, value: null };
    if (raw === null)
        return { exists: true, value: null };
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return {
                exists: true,
                value: parsed && typeof parsed === 'object'
                    ? parsed
                    : null
            };
        }
        catch {
            return { exists: true, value: null };
        }
    }
    return {
        exists: true,
        value: typeof raw === 'object' ? raw : null
    };
}
function readVarint(buf, offset) {
    let value = 0;
    let shift = 0;
    let i = offset;
    while (i < buf.length && shift <= 35) {
        const byte = buf[i++];
        value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0)
            return { value, next: i };
        shift += 7;
    }
    return null;
}
function collectProtoStrings(buf, out, depth = 0) {
    if (depth > 6)
        return;
    let offset = 0;
    while (offset < buf.length) {
        const tag = readVarint(buf, offset);
        if (!tag)
            return;
        offset = tag.next;
        const wireType = tag.value & 7;
        if (wireType === 0) {
            const scalar = readVarint(buf, offset);
            if (!scalar)
                return;
            offset = scalar.next;
            continue;
        }
        if (wireType === 1) {
            offset += 8;
            continue;
        }
        if (wireType === 2) {
            const len = readVarint(buf, offset);
            if (!len)
                return;
            offset = len.next;
            const end = offset + len.value;
            if (end > buf.length)
                return;
            const slice = buf.subarray(offset, end);
            offset = end;
            const text = slice.toString('utf8');
            if (/^[\x20-\x7e]{3,}$/.test(text)) {
                out.push(text);
            }
            else {
                collectProtoStrings(slice, out, depth + 1);
            }
            continue;
        }
        if (wireType === 5) {
            offset += 4;
            continue;
        }
        return;
    }
}
function readSharedLastLoginEmail(context) {
    for (const key of ['lastLoginEmail', 'lastLoginEmail.staging']) {
        const value = context.globalState.get(key);
        if (typeof value === 'string' && /@/.test(value)) {
            return value.trim().toLowerCase();
        }
    }
    return null;
}
function extractEmailFromSharedAuthStatus(context, accounts, prevEmail) {
    const shared = readSharedJsonObject(context, 'windsurfAuthStatus');
    if (!shared.value)
        return null;
    const base64 = shared.value.userStatusProtoBinaryBase64;
    if (typeof base64 !== 'string' || !base64)
        return null;
    let decoded;
    try {
        decoded = Buffer.from(base64, 'base64');
    }
    catch {
        return null;
    }
    const strings = [];
    collectProtoStrings(decoded, strings);
    const uniqueAccountEmails = Array.from(new Set(accounts
        .map(a => (a.email || '').trim().toLowerCase())
        .filter(Boolean)));
    const matched = uniqueAccountEmails.filter(email => strings.some(s => s.toLowerCase().includes(email)));
    const prev = (prevEmail || '').trim().toLowerCase();
    if (prev && matched.includes(prev))
        return prev;
    if (matched.length > 0)
        return matched[0];
    const extracted = Array.from(new Set(strings.flatMap(s => {
        const hits = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
        return hits ? hits.map(hit => hit.toLowerCase()) : [];
    })));
    if (prev && extracted.includes(prev))
        return prev;
    return extracted[0] || null;
}
/**
 * Read the authoritative Windsurf session and sync our cached
 * `currentAccountId` / `activeEmail`. Returns the resolved values.
 *
 * This is the single source of truth for "which account is logged in".
 * It's called on activation, on session-change events, and at the start
 * of user-initiated "refresh current" so the UI never drifts from reality.
 */
async function syncCurrentAccountFromSession(context, accountsOverride) {
    // Design rule (post-fix): sync is *purely additive*. It will only upgrade
    // our local currentAccountId / activeEmail when it finds *positive
    // evidence* of a new account. It will NEVER clear our cache.
    //
    // Why: clearing inside sync turned out to be systematically wrong.
    //   (a) `windsurfAuthStatus` is written by Windsurf at the SQLite top
    //       level, and on some builds it isn't exposed to Pro's per-extension
    //       Memento at all — making `context.globalState.get(...)` return
    //       `undefined` or an unexpected shape. Any "clear on unknown" path
    //       then nuked the state we'd JUST set in doSwitch.
    //   (b) Windsurf's own S()-chain intermittently re-writes the status
    //       object in ways that look like logout to a naive reader (missing
    //       keys, transient empty accessToken while a background refresh is
    //       in flight, etc.).
    // The authoritative source of truth for "which account is active in
    // Pro" is therefore the explicit user actions:
    //   - doSwitch writes currentAccountId / activeEmail on success.
    //   - LOGOUT / delete-account commands clear them explicitly.
    // Anything else (heartbeat, window focus, onDidChangeSessions, accounts
    // file watcher) is *best-effort read* that can only overwrite our cache
    // with *better* data, never erase it.
    const prevId = getCurrentAccountId(context);
    const prevEmail = getActiveEmail(context);
    const accounts = accountsOverride && accountsOverride.length > 0
        ? accountsOverride
        : await (0, accountsStore_1.loadManagerAccounts)();
    const sharedAuth = readSharedJsonObject(context, 'windsurfAuthStatus');
    let email = sharedAuth.exists
        ? extractEmailFromSharedAuthStatus(context, accounts, prevEmail) || readSharedLastLoginEmail(context)
        : null;
    let session;
    if (!email) {
        session = await resolveActiveSession();
        email = extractEmailFromSession(session);
        if (!email) {
            email = lookupEmailByLabel(context, session?.account?.label);
            if (email)
                (0, log_1.log)(`session sync: resolved via label map "${session?.account?.label}" → ${email}`);
        }
    }
    if (!email) {
        // Nothing found. Preserve whatever the caller/doSwitch already wrote.
        // (`hint` is only useful when we have zero previous email; we still
        // never wipe an existing one.)
        const hint = (session?.account?.label || '').trim();
        const prevLooksLikeEmail = !!prevEmail && /@/.test(prevEmail);
        if (!prevLooksLikeEmail && !prevEmail && hint) {
            await setActiveEmail(context, hint, 'sync-hint');
        }
        return { id: prevId, email: prevLooksLikeEmail ? prevEmail : (hint || prevEmail) };
    }
    const match = accounts.find(a => (a.email || '').trim().toLowerCase() === email);
    if (!match) {
        // Found an email in the shared status but it isn't in our accounts.
        // Don't touch currentAccountId — the user may have just deleted the
        // account from Pro's side but is still signed into Windsurf with it,
        // or Windsurf's cache is reporting a different (stale) account than
        // the one we just switched to. Preserve prev; just log.
        (0, log_1.log)(`session sync: email ${email} not found in ${accounts.length} accounts; keeping prev id=${prevId ?? '∅'}`);
        return { id: prevId, email: prevEmail };
    }
    const id = match.id;
    if (prevId !== id)
        await setCurrentAccountId(context, id, 'sync-match');
    if (prevEmail !== email)
        await setActiveEmail(context, email, 'sync-match');
    if (prevId !== id || prevEmail !== email) {
        (0, log_1.log)(`session sync: id ${prevId ?? '∅'} → ${id}, email ${prevEmail ?? '∅'} → ${email}`);
    }
    return { id, email };
}
/**
 * Debounced "resync current account + reload sidebar".
 *
 * Called from every cross-window trigger: file-watcher, session-change,
 * window focus, heartbeat.  Multiple calls within SYNC_DEBOUNCE_MS coalesce
 * so we don't hammer the auth provider or disk when, e.g., fs.watch fires
 * many events for a single atomic write.
 */
const SYNC_DEBOUNCE_MS = 250;
let syncScheduleTimer = null;
function scheduleSyncAndReload(context, sidebar, reason) {
    if (syncScheduleTimer)
        return; // coalesce
    syncScheduleTimer = setTimeout(async () => {
        syncScheduleTimer = null;
        try {
            await syncCurrentAccountFromSession(context, sidebar.accounts);
            // sidebar.reload() is cheap when nothing changed: disk read then
            // postState(), whose payload dedup will drop the webview message.
            // We intentionally DON'T log each tick (heartbeat fires every
            // 30s) — the inner sync logs on real state transitions.
            await sidebar.reload();
        }
        catch (e) {
            (0, log_1.log)(`cross-window sync (${reason}) failed:`, e?.message || e);
        }
    }, SYNC_DEBOUNCE_MS);
}
function getSmartHistory(ctx) {
    return ctx.globalState.get(GS.smartHistory, {}) || {};
}
function saveSmartHistory(ctx, h) {
    return ctx.globalState.update(GS.smartHistory, h);
}
function clearSmartHistory(ctx) {
    return ctx.globalState.update(GS.smartHistory, {});
}
let autoSwitch;
let sidebar;
// ---------------------------------------------------------------------------
// Bottom status bar — single item, click → switchAccount QuickPick.
// Per-axis quota color is achieved with emoji circles (🔴🟡🟢⚪) which carry
// their own intrinsic color from the OS emoji font, independent of the
// item's foreground color. So one item can still show two differently
// colored dots side by side.
// ---------------------------------------------------------------------------
let statusBarItem;
function initStatusBar(context) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'windsurfSwitch.switchAccount';
    statusBarItem.name = 'Windsurf Switch';
    context.subscriptions.push(statusBarItem);
    updateStatusBar(context);
}
/**
 * Emoji circle whose intrinsic color matches the sidebar's `quotaTone()`
 * thresholds (≤20 red · ≤60 yellow · others green). Unknown quota → ⚪.
 */
function quotaDot(pct) {
    if (typeof pct !== 'number') {
        return '⚪';
    }
    if (pct <= 20) {
        return '🔴';
    }
    if (pct <= 60) {
        return '🟡';
    }
    return '🟢';
}
/**
 * Refresh the status-bar text from the current account id + sidebar's cached
 * accounts list. Safe to call any time — no-ops if the bar isn't initialized
 * (e.g. activation failed early).
 */
function updateStatusBar(context) {
    if (!statusBarItem) {
        return;
    }
    try {
        const id = getCurrentAccountId(context);
        const accounts = sidebar?.accounts || [];
        const acc = id ? accounts.find(a => a.id === id) : undefined;
        if (!acc) {
            statusBarItem.text = '$(account) Windsurf';
            statusBarItem.tooltip = `${getActiveEmail(context) || 'Not logged in'}\nClick to switch account`;
            statusBarItem.show();
            return;
        }
        const d = typeof acc.dailyRemainPct === 'number' ? acc.dailyRemainPct : null;
        const w = typeof acc.weeklyRemainPct === 'number' ? acc.weeklyRemainPct : null;
        const dStr = d === null ? '-' : `${d}%`;
        const wStr = w === null ? '-' : `${w}%`;
        statusBarItem.text = `${quotaDot(d)} D ${dStr} · ${quotaDot(w)} W ${wStr}`;
        const ttLines = [`Windsurf: ${acc.email}`];
        if (acc.planName) {
            ttLines.push(`Plan: ${acc.planName}`);
        }
        ttLines.push(`Daily: ${dStr}  ·  Weekly: ${wStr}`);
        ttLines.push('Click to switch account');
        statusBarItem.tooltip = ttLines.join('\n');
        statusBarItem.show();
    }
    catch (e) {
        (0, log_1.log)('updateStatusBar failed:', e?.message || e);
    }
}
function activate(context) {
    (0, log_1.log)(`Windsurf Switch v${context.extension.packageJSON.version} activating on VS Code ${vscode.version}. Accounts file: ${(0, accountsStore_1.getAccountsFilePath)()}`);
    try {
        (0, accountsStore_1.ensureAccountsDir)();
        // Wire the SecretStorage-backed credential cache. From here on,
        // tokens.ts and friends can pull plaintext without hitting DPAPI
        // on most runs (only the first-ever decrypt or a ciphertext change
        // forces a PowerShell round-trip).
        (0, memoryCreds_1.attachSecretStorage)(context.secrets);
        (0, dpapi_1.attachSecretStorage)(context.secrets);
        const unsubscribe = (0, memoryCreds_1.onStatusChange)(status => {
            if (status.state === 'ready') {
                (0, log_1.log)(`creds cache ready: total=${status.total} hit=${status.hitCount} miss=${status.missCount} in ${status.durationMs}ms`);
            }
            else if (status.state === 'error') {
                (0, log_1.log)(`creds cache error: ${status.message}`);
            }
        });
        context.subscriptions.push({ dispose: unsubscribe });
        (0, memoryCreds_1.kickoffBackgroundDecrypt)(); // fire-and-forget
        sidebar = new sidebar_1.SidebarProvider(context);
        context.subscriptions.push(vscode.window.registerWebviewViewProvider(sidebar_1.SidebarProvider.viewId, sidebar, {
            webviewOptions: { retainContextWhenHidden: true }
        }));
        (0, log_1.log)(`registered webview view provider: ${sidebar_1.SidebarProvider.viewId}`);
        // AutoSwitch controller (polling + log watcher). Starts whichever
        // monitors are currently enabled in globalState; both default to off.
        autoSwitch = new autoSwitch_1.AutoSwitch(context, {
            getCurrentAccountId: () => getCurrentAccountId(context),
            trigger: (trigger) => runSmartSwitch(context, sidebar, { trigger }),
            probeCurrentQuota: () => probeCurrentQuota(context)
        });
        autoSwitch.start();
        context.subscriptions.push(autoSwitch);
        registerCommands(context, sidebar);
        (0, log_1.log)('commands registered. Ready.');
        // Bottom status bar — must come after sidebar exists; updates piggy-back
        // on every sidebar.reload() via the onDidReload hook.
        initStatusBar(context);
        sidebar.setOnDidReload(() => updateStatusBar(context));
        // Auto-patch Windsurf core on startup so a fresh install doesn't
        // require the user to run "Patch Windsurf" by hand. Silent-fail:
        // if the app is read-only, or we're on a mismatched Windsurf version,
        // just log and move on; the user can still run the command manually.
        void tryAutoPatchOnStartup(context);
        // Cross-window active-account file — hydrate from the shared file so
        // a window opened AFTER the most recent switch inherits it, then wire
        // a watcher so live updates from sibling windows flow in.
        void (async () => {
            try {
                await hydrateFromActiveFile(context);
            }
            catch (e) {
                (0, log_1.log)('active.json hydrate failed:', e?.message || e);
            }
        })();
        context.subscriptions.push(installActiveFileWatcher(context, sidebar));
        // Initial session sync — trust Windsurf's auth provider over our
        // cached globalState. This fixes the "First install UI shows not switched" bug
        // when Windsurf is already logged in.
        void (async () => {
            try {
                await syncCurrentAccountFromSession(context);
                await sidebar.reload();
            }
            catch (e) {
                (0, log_1.log)('initial session sync failed:', e?.message || e);
            }
        })();
        // Multi-window sync strategy: VS Code runs a separate extension host
        // per window.  When window A changes account / refreshes quota,
        // window B's in-memory state is stale.  We wire four redundant
        // triggers so every window converges quickly:
        //
        //   1. accounts.json file watcher  → picks up cross-window writes
        //      (refresh quota / import / delete / switch).
        //   2. onDidChangeSessions          → Windsurf's auth provider event,
        //      if it propagates cross-window.
        //   3. onDidChangeWindowState       → when user refocuses the window,
        //      resync immediately (covers stale globalState cache).
        //   4. 30s heartbeat                → last-resort fallback if all of
        //      the above miss (edge cases, provider quirks).
        //
        // All four go through scheduleSyncAndReload which debounces + coalesces.
        context.subscriptions.push(vscode.authentication.onDidChangeSessions(ev => {
            if (ev.provider.id !== constants_1.WINDSURF_AUTH_PROVIDER_ID)
                return;
            scheduleSyncAndReload(context, sidebar, 'onDidChangeSessions');
        }));
        try {
            const accountsFile = (0, accountsStore_1.getAccountsFilePath)();
            const accountsDir = path.dirname(accountsFile);
            const baseName = path.basename(accountsFile);
            if (fs.existsSync(accountsDir)) {
                const watcher = fs.watch(accountsDir, { persistent: false }, (_ev, filename) => {
                    if (filename && String(filename) === baseName) {
                        scheduleSyncAndReload(context, sidebar, 'accounts.json changed');
                    }
                });
                context.subscriptions.push({
                    dispose: () => {
                        try {
                            watcher.close();
                        }
                        catch { /* ignore */ }
                    }
                });
            }
        }
        catch (e) {
            (0, log_1.log)('accounts.json watcher setup failed:', e?.message || e);
        }
        context.subscriptions.push(vscode.window.onDidChangeWindowState(ev => {
            if (ev.focused) {
                scheduleSyncAndReload(context, sidebar, 'window focused');
            }
        }));
        const heartbeat = setInterval(() => scheduleSyncAndReload(context, sidebar, 'heartbeat'), 30000);
        context.subscriptions.push({ dispose: () => clearInterval(heartbeat) });
    }
    catch (e) {
        (0, log_1.log)('activate() failed:', e?.stack || e?.message || e);
        (0, log_1.getOutputChannel)().show(true);
        vscode.window.showErrorMessage(`Windsurf Switch activation failed: ${e?.message || e}. Please check Output → Windsurf Switch`);
        throw e;
    }
}
function deactivate() {
    (0, log_1.disposeOutput)();
}
// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------
function registerCommands(context, sidebar) {
    const sub = context.subscriptions;
    sub.push(vscode.commands.registerCommand('windsurfSwitch.reloadSidebar', () => sidebar.reload()));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.openAccountsFile', () => {
        void vscode.env.openExternal(vscode.Uri.file((0, accountsStore_1.getAccountsDir)()));
    }));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.showOutput', () => {
        (0, log_1.getOutputChannel)().show(true);
    }));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.switchAccount', () => pickAndSwitch(context, sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.switchAccountById', (accountId) => switchById(context, sidebar, accountId)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.switchByIdToken', () => cmdSwitchByIdToken()));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.addAccount', () => cmdAddAccount(sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.addAccountGitHub', () => cmdAddAccountGitHub(sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.batchImport', () => cmdBatchImport(sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch._submitAddFromModal', (args) => cmdSubmitAddFromModal(sidebar, args)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch._submitBatchFromModal', (args) => cmdSubmitBatchFromModal(sidebar, args)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.deleteAccountById', (accountId) => deleteById(context, sidebar, accountId)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.editRemarkById', (accountId) => editRemarkById(sidebar, accountId)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.showCredentials', (accountId) => showCredentials(sidebar, accountId)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.refreshAccount', (accountId) => refreshOne(context, sidebar, accountId)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.refreshAll', () => refreshAll(context, sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.fixCredentialsById', (accountId) => fixCredentialsById(sidebar, accountId)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.listAccounts', () => cmdListAccounts()));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.exportAccounts', () => cmdExportAccounts()));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.importAccounts', () => cmdImportAccounts(sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.clearExpiredAccounts', () => cmdClearExpiredAccounts(context, sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.checkUpdate', () => cmdCheckUpdate(context)));
    // --- Smart switch / auto switch ---
    sub.push(vscode.commands.registerCommand('windsurfSwitch.smartSwitch', () => cmdSmartSwitch(context, sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch._refreshCurrentSynced', () => cmdRefreshCurrentSynced(context, sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.diagnoseSession', () => cmdDiagnoseSession(context)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch._smartSwitchFromSidebar', (args) => cmdSmartSwitchFromSidebar(context, sidebar, args)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.resetSmartCooldown', () => cmdResetSmartCooldown(context, sidebar)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.editLogPatterns', () => cmdEditLogPatterns(context)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch._toggleAuto', (args) => cmdToggleAuto(context, sidebar, args)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch._setPollingInterval', (args) => cmdSetPollingInterval(context, sidebar, args)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch._setLowQuotaThreshold', (args) => cmdSetLowQuotaThreshold(context, sidebar, args)));
    // --- Windsurf core patch (no-browser smart switch) ---
    sub.push(vscode.commands.registerCommand('windsurfSwitch.patchWindsurf', () => cmdPatchWindsurf(context)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.unpatchWindsurf', () => cmdUnpatchWindsurf(context)));
    sub.push(vscode.commands.registerCommand('windsurfSwitch.checkPatchStatus', () => cmdCheckPatchStatus()));
}
// ---------------------------------------------------------------------------
// Windsurf core patch — apply / restore / status
// ---------------------------------------------------------------------------
/**
 * globalState flags for patcher autopilot.
 *   `wm.patcher.userDisabled` — set to true when the user explicitly unpatches.
 *       Auto-apply skips when this is true so we don't fight the user.
 *   `wm.patcher.lastAutoAppliedVersion` — the `packageJSON.version` of
 *       Windsurf's core extension the last time we auto-applied. When Windsurf
 *       is upgraded the version changes and we'll retry auto-apply once.
 */
const PATCHER_FLAGS = {
    userDisabled: 'wm.patcher.userDisabled',
    lastAutoAppliedVersion: 'wm.patcher.lastAutoAppliedVersion'
};
async function tryAutoPatchOnStartup(context) {
    try {
        const extPath = (0, windsurfPatcher_1.findWindsurfExtensionPath)();
        if (!extPath) {
            (0, log_1.log)('[auto-patch] skipped: Windsurf core extension.js not found');
            return;
        }
        if ((0, windsurfPatcher_1.isPatchApplied)(extPath)) {
            (0, log_1.log)('[auto-patch] already applied, nothing to do');
            return;
        }
        const userDisabled = context.globalState.get(PATCHER_FLAGS.userDisabled, false);
        if (userDisabled) {
            (0, log_1.log)('[auto-patch] skipped: user has explicitly unpatched previously (run "Patch Windsurf" to re-enable auto)');
            return;
        }
        (0, log_1.log)('[auto-patch] patch missing, attempting silent apply...');
        const r = await (0, windsurfPatcher_1.applyPatch)();
        if (!r.success) {
            (0, log_1.log)(`[auto-patch] failed (user can run "Patch Windsurf" to retry): ${r.error}`);
            return;
        }
        if (r.alreadyApplied) {
            (0, log_1.log)('[auto-patch] already-applied (concurrent run?)');
            return;
        }
        try {
            const extDir = path.dirname(path.dirname(extPath));
            const pkgPath = path.join(extDir, 'package.json');
            if (fs.existsSync(pkgPath)) {
                const ver = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))?.version;
                if (typeof ver === 'string') {
                    await context.globalState.update(PATCHER_FLAGS.lastAutoAppliedVersion, ver);
                }
            }
        }
        catch { /* best effort */ }
        (0, log_1.log)(`[auto-patch] applied successfully → ${extPath}`);
        // Defer the reload prompt so it doesn't fight with the sidebar's
        // initial render.
        setTimeout(async () => {
            const choice = await vscode.window.showInformationMessage('Windsurf Switch has automatically patched Windsurf (enabled no-browser switching). Reload window to take effect.', 'Reload Window', 'Later');
            if (choice === 'Reload Window') {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }, 1500);
    }
    catch (e) {
        (0, log_1.log)(`[auto-patch] unexpected error (ignored): ${e?.stack || e?.message || e}`);
    }
}
async function cmdPatchWindsurf(context) {
    const extPath = (0, windsurfPatcher_1.findWindsurfExtensionPath)();
    if (!extPath) {
        vscode.window.showErrorMessage('Windsurf core extension (codeium.windsurf) dist/extension.js not found');
        return;
    }
    if ((0, windsurfPatcher_1.isPatchApplied)(extPath)) {
        // User explicitly requested patch → clear the "don't auto-apply" flag.
        if (context)
            await context.globalState.update(PATCHER_FLAGS.userDisabled, false);
        vscode.window.showInformationMessage('Windsurf core is already patched, no need to patch again.');
        return;
    }
    const consent = await vscode.window.showWarningMessage('Will modify Windsurf app dist/extension.js to enable "no-browser switching" (will write .aliu-backup). Continue?\n\nNote: Need to re-patch after Windsurf upgrades.', { modal: true }, 'Continue');
    if (consent !== 'Continue') {
        return;
    }
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Patching Windsurf...', cancellable: false }, () => (0, windsurfPatcher_1.applyPatch)());
    if (!r.success) {
        vscode.window.showErrorMessage(`Patch failed: ${r.error}`);
        (0, log_1.log)(`patchWindsurf failed: ${r.error}`);
        return;
    }
    // Successful manual patch → re-enable autopilot for future activations.
    if (context)
        await context.globalState.update(PATCHER_FLAGS.userDisabled, false);
    if (r.alreadyApplied) {
        vscode.window.showInformationMessage('Already patched version (reload window to take effect).');
        return;
    }
    (0, log_1.log)(`patchWindsurf applied → ${extPath}`);
    // showWarningMessage MUST be outside the withProgress callback so the
    // notification dismisses promptly and the user can see / click the prompt.
    const reload = await vscode.window.showWarningMessage('Patch applied, need to reload window to take effect.', 'Reload Window', 'Later');
    if (reload === 'Reload Window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}
async function cmdUnpatchWindsurf(context) {
    const extPath = (0, windsurfPatcher_1.findWindsurfExtensionPath)();
    if (!extPath) {
        vscode.window.showErrorMessage('Windsurf core extension dist/extension.js not found');
        return;
    }
    if (!(0, windsurfPatcher_1.isPatchApplied)(extPath)) {
        // Patch already absent; remember the user's preference so autopilot
        // doesn't silently re-apply on the next activation.
        if (context)
            await context.globalState.update(PATCHER_FLAGS.userDisabled, true);
        vscode.window.showInformationMessage('No patch currently applied (already original Windsurf). Auto-patching disabled (patch again to re-enable).');
        return;
    }
    const consent = await vscode.window.showWarningMessage('Will restore original Windsurf extension.js from .aliu-backup. Continue?', { modal: true }, 'Continue');
    if (consent !== 'Continue') {
        return;
    }
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Restoring Windsurf...', cancellable: false }, () => (0, windsurfPatcher_1.restorePatch)());
    if (!r.success) {
        vscode.window.showErrorMessage(`Restore failed: ${r.error}`);
        return;
    }
    // User has explicitly unpatched → stop autopilot from re-applying.
    if (context)
        await context.globalState.update(PATCHER_FLAGS.userDisabled, true);
    const reload = await vscode.window.showWarningMessage('Windsurf restored, need to reload window to take effect. Smart switch will fall back to browser login.', 'Reload Window', 'Later');
    if (reload === 'Reload Window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}
async function cmdCheckPatchStatus() {
    const extPath = (0, windsurfPatcher_1.findWindsurfExtensionPath)();
    if (!extPath) {
        vscode.window.showErrorMessage('Windsurf core extension dist/extension.js not found');
        return;
    }
    const applied = (0, windsurfPatcher_1.isPatchApplied)(extPath);
    const cmdAvailable = (await vscode.commands.getCommands(true)).includes(windsurfPatcher_1.PATCH_COMMAND_ID);
    const lines = [
        `Windsurf Core: ${extPath}`,
        `Patch File: ${applied ? 'Applied ✓' : 'Not Applied ✗'}`,
        `Runtime Command: ${cmdAvailable ? 'Registered ✓ (No-browser switching available)' : 'Not Registered ✗'}`,
    ];
    if (applied && !cmdAvailable) {
        lines.push('');
        lines.push('Patch written but runtime command not yet registered——please reload window (Cmd+Shift+P → Developer: Reload Window).');
    }
    if (!applied) {
        lines.push('');
        lines.push('Run Windsurf Switch: Patch Windsurf to enable no-browser switching.');
    }
    vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
}
// ---------------------------------------------------------------------------
// Notification helpers — prefer short-lived status bar messages for success
// paths to stop the bottom-right from piling up.
// ---------------------------------------------------------------------------
function statusOk(msg) {
    vscode.window.setStatusBarMessage(`$(check) ${msg}`, 4000);
}
function statusWarn(msg) {
    vscode.window.setStatusBarMessage(`$(warning) ${msg}`, 5000);
}
// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------
async function pickAndSwitch(context, sidebar) {
    const accounts = sidebar.accounts.length > 0 ? sidebar.accounts : await (0, accountsStore_1.loadManagerAccounts)();
    if (!(0, accountsStore_1.accountsFileExists)() || accounts.length === 0) {
        const action = await vscode.window.showInformationMessage('No accounts yet. Add one now?', 'Add Account', 'Open accounts.json Directory');
        if (action === 'Add Account') {
            await vscode.commands.executeCommand('windsurfSwitch.addAccount');
        }
        else if (action === 'Open accounts.json Directory') {
            await vscode.commands.executeCommand('windsurfSwitch.openAccountsFile');
        }
        return;
    }
    const usable = accounts.filter(isSwitchable);
    if (usable.length === 0) {
        vscode.window.showWarningMessage('No switchable accounts: need password / refreshToken / auth1Token (at least one). Use "Fix Credentials" to add password.');
        return;
    }
    const picks = usable
        .slice()
        .sort((a, b) => (b.lastQueryTime || '').localeCompare(a.lastQueryTime || ''))
        .map(a => ({
        label: a.email,
        description: a.remark ? `📝 ${a.remark}` : undefined,
        detail: describeAccount(a),
        account: a
    }));
    const pick = await vscode.window.showQuickPick(picks, {
        title: 'Switch Windsurf Account (Windsurf window will not close)',
        placeHolder: 'Select target account'
    });
    if (!pick) {
        return;
    }
    await doSwitch(context, sidebar, pick.account);
}
async function switchById(context, sidebar, accountId) {
    let account = sidebar.findAccount(accountId);
    if (!account) {
        const all = await (0, accountsStore_1.loadManagerAccounts)();
        account = all.find(a => a.id === accountId);
    }
    if (!account) {
        vscode.window.showErrorMessage(`Account not found: id=${accountId}`);
        return;
    }
    await doSwitch(context, sidebar, account);
}
async function doSwitch(context, sidebar, account) {
    const previousAccountId = (await syncCurrentAccountFromSession(context, sidebar.accounts.length > 0 ? sidebar.accounts : undefined)).id;
    // ProgressLocation.Window = subtle spinner in the status bar, not a big
    // bottom-right toast that lingers.
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: `Windsurf: Switch to ${account.email}`,
        cancellable: false
    }, async (progress) => {
        try {
            progress.report({ message: 'Getting IdToken...' });
            const idToken = await (0, tokens_1.ensureFreshIdToken)(context, account);
            progress.report({ message: 'Notifying Windsurf to switch session...' });
            const session = await (0, seamlessSwitch_1.seamlessSwitch)(idToken, { email: account.email, displayName: account.displayName });
            await setCurrentAccountId(context, account.id, 'doSwitch');
            await setActiveEmail(context, account.email, 'doSwitch');
            // Learn the label → email mapping so future external switches
            // (user logs in again via Windsurf UI, other windows, ...)
            // can be resolved even though the session carries no email.
            await rememberSessionLabel(context, session?.account?.label, account.email);
            // Stop polling from immediately re-triggering on the very next tick.
            autoSwitch?.noteExternalSwitch();
            statusOk(`Switched to ${session?.account?.label ?? account.email}`);
            (0, log_1.log)(`switched to ${session?.account?.label ?? account.email}`);
            if (previousAccountId && previousAccountId !== account.id) {
                void refreshAccountQuotaSilently(context, sidebar, previousAccountId);
            }
        }
        catch (e) {
            (0, log_1.log)('doSwitch failed:', e);
            await (0, tokens_1.invalidateToken)(context, account.id);
            vscode.window.showErrorMessage(`Switch failed: ${e?.message || e}`);
        }
        finally {
            await sidebar.reload();
        }
    });
}
async function cmdSwitchByIdToken() {
    const token = await vscode.window.showInputBox({
        title: 'Switch with Firebase IdToken (Debug)',
        prompt: 'Paste Firebase IdToken',
        password: true,
        ignoreFocusOut: true
    });
    if (!token) {
        return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Windsurf: Switching session...' }, async () => {
        try {
            const session = await (0, seamlessSwitch_1.seamlessSwitch)(token);
            statusOk(`Switched to ${session?.account?.label ?? 'account'}`);
        }
        catch (e) {
            (0, log_1.log)('cmdSwitchByIdToken failed:', e);
            vscode.window.showErrorMessage(`Switch failed: ${e?.message || e}`);
        }
    });
}
// ---------------------------------------------------------------------------
// Add account
// ---------------------------------------------------------------------------
async function cmdAddAccount(sidebar) {
    // Prefer the in-sidebar modal overlay. `openModal` reveals the view
    // container, waits for the webview to resolve, then posts the open
    // message.
    await sidebar.openModal('add');
}
/**
 * Internal command invoked by the sidebar modal's "Add" button.
 * Validates args, runs the login + store flow, and reports back to the
 * webview so the modal can close or show an inline error.
 */
async function cmdSubmitAddFromModal(sidebar, args) {
    const email = (args?.email || '').trim();
    const password = args?.password || '';
    if (!email || !email.includes('@')) {
        sidebar.postModalError('Please enter a valid email');
        return;
    }
    if (!password) {
        sidebar.postModalError('Password cannot be empty');
        return;
    }
    try {
        const result = await addOneAccount(email, password);
        sidebar.postModalClose();
        statusOk(`Added ${result.email}`);
        (0, log_1.log)(`addAccount(modal): ${result.email}`);
    }
    catch (e) {
        (0, log_1.log)('cmdSubmitAddFromModal failed:', e);
        sidebar.postModalError(String(e?.message || e));
    }
    finally {
        await sidebar.reload();
    }
}
/**
 * Shared helper used both by add single and batch import.
 * Tries Firebase first, falls back to Auth1 — see `windsurfApi.login`.
 */
async function addOneAccount(email, password) {
    const loginResult = await (0, windsurfApi_1.login)(email, password);
    const now = Date.now();
    const account = {
        id: `${now}-${crypto.randomBytes(3).toString('hex')}`,
        email,
        displayName: loginResult.displayName || '',
        authProvider: loginResult.authProvider || constants_1.FIREBASE_PROVIDER,
        accountId: loginResult.accountId || '',
        primaryOrgId: loginResult.primaryOrgId || '',
        password,
        idToken: loginResult.idToken,
        refreshToken: loginResult.refreshToken || '',
        auth1Token: loginResult.auth1Token || '',
        idTokenExpiresAt: now + loginResult.expiresInSeconds * 1000,
        createdAt: new Date().toISOString(),
        planName: 'Free',
        dailyRemainPct: null,
        weeklyRemainPct: null,
        dailyResetUnix: null,
        weeklyResetUnix: null,
        expiresAt: '',
        gracePeriodStatus: '',
        lastQueryTime: '',
        quotaError: false,
        remark: '',
        hasWindsurfSessionSnapshot: false,
        windsurfSessionCapturedAt: '',
        hasCredentials: true
    };
    await (0, accountsStore_1.addAccount)(account);
    // Keep the in-memory + SecretStorage cache in sync so this account works
    // immediately without a full kickoffBackgroundDecrypt pass.
    try {
        await (0, memoryCreds_1.putCreds)(account.id, {
            email: account.email,
            password: account.password,
            idToken: account.idToken,
            refreshToken: account.refreshToken,
            auth1Token: account.auth1Token,
            idTokenExpiresAt: account.idTokenExpiresAt
        });
    }
    catch (e) {
        (0, log_1.log)(`putCreds after addAccount failed for ${email}:`, e?.message || e);
    }
    try {
        const snap = await (0, windsurfApi_1.getPlanStatus)(loginResult.idToken);
        await (0, accountsStore_1.applySnapshot)(account.id, snap);
    }
    catch (e) {
        (0, log_1.log)(`initial getPlanStatus failed for ${email}:`, e?.message || e);
    }
    return account;
}
// ---------------------------------------------------------------------------
// Add account via the Windsurf website (browser sign-in flow).
//
// Windsurf's signin page (windsurf.com/windsurf/signin) lets the user pick
// any auth method — GitHub, Google, email/password on the website, etc. The
// Windsurf auth provider receives the callback via the windsurf:// URI scheme
// and emits a session whose accessToken is the firebase idToken (or, for
// auth1/devin-backed accounts, a `devin-session-token$...`).
//
// We trigger getSession(forceNewSession) to run that full browser flow, then
// read the resulting accessToken and import the account just like addOneAccount.
// The legacy command id `addAccountGitHub` is retained for backward compat.
// ---------------------------------------------------------------------------
async function cmdAddAccountGitHub(sidebar) {
    try {
        // forceNewSession opens the Windsurf signin page in the browser. The
        // user can choose any sign-in method offered there. Windsurf handles
        // the OAuth callback internally and resolves getSession with the new
        // session containing the resulting accessToken.
        const session = await vscode.authentication.getSession(constants_1.WINDSURF_AUTH_PROVIDER_ID, ['Login'], { forceNewSession: true });
        if (!session?.accessToken) {
            vscode.window.showErrorMessage('Browser sign-in cancelled or did not return a token.');
            return;
        }
        const idToken = session.accessToken;
        const displayName = session.account?.label || '';
        // Import the account using the token from the new session.
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Windsurf Switch: Importing browser-signed account…',
            cancellable: false
        }, async () => {
            await addOneAccountFromToken(idToken, displayName);
        });
        statusOk(`Added ${displayName || 'browser-signed account'}`);
        (0, log_1.log)(`addAccountBrowser: ${displayName}`);
        await sidebar.reload();
    }
    catch (e) {
        (0, log_1.log)('cmdAddAccountGitHub failed:', e);
        vscode.window.showErrorMessage(`Browser sign-in failed: ${e?.message || e}`);
    }
}
/**
 * Import an account from a Windsurf api key (session.accessToken).
 *
 * Windsurf's auth provider stores the api key as accessToken — it is already
 * the fully resolved credential (sk-ws-01... for firebase accounts or
 * devin-session-token$... for Auth1/devin accounts). We store it directly
 * as idToken; no auth1PostAuth or registerUser call is needed.
 *
 * authProvider is determined by the token prefix:
 *   devin-session-token$ → auth1   (Auth1 / devin / browser OAuth)
 *   anything else        → firebase (firebase api key)
 */
async function addOneAccountFromToken(apiKey, displayNameHint) {
    const DEVIN_PREFIX = 'devin-session-token$';
    const isDevin = typeof apiKey === 'string' && apiKey.startsWith(DEVIN_PREFIX);
    const authProvider = isDevin ? constants_1.AUTH1_PROVIDER : constants_1.FIREBASE_PROVIDER;
    // Auth1 tokens are valid for 14 days; firebase api keys don't expire via time
    // but we flag a generous TTL so ensureFreshIdToken doesn't prematurely invalidate.
    const expiresInSeconds = isDevin ? constants_1.AUTH1_EXPIRES_IN_SECONDS : 3600;
    const now = Date.now();
    const email = displayNameHint || 'browser-user';
    const account = {
        id: `${now}-${crypto.randomBytes(3).toString('hex')}`,
        email,
        displayName: displayNameHint || '',
        authProvider,
        accountId: '',
        primaryOrgId: '',
        password: '',
        idToken: apiKey,
        refreshToken: '',
        auth1Token: isDevin ? apiKey : '',
        idTokenExpiresAt: now + expiresInSeconds * 1000,
        createdAt: new Date().toISOString(),
        planName: 'Free',
        dailyRemainPct: null,
        weeklyRemainPct: null,
        dailyResetUnix: null,
        weeklyResetUnix: null,
        expiresAt: '',
        gracePeriodStatus: '',
        lastQueryTime: '',
        quotaError: false,
        remark: '',
        hasWindsurfSessionSnapshot: false,
        windsurfSessionCapturedAt: '',
        hasCredentials: true
    };
    await (0, accountsStore_1.addAccount)(account);
    try {
        await (0, memoryCreds_1.putCreds)(account.id, {
            email: account.email,
            password: '',
            idToken: account.idToken,
            refreshToken: account.refreshToken,
            auth1Token: account.auth1Token,
            idTokenExpiresAt: account.idTokenExpiresAt
        });
    }
    catch (e) {
        (0, log_1.log)(`putCreds after browser sign-in addAccount failed for ${email}:`, e?.message || e);
    }
    try {
        const snap = await (0, windsurfApi_1.getPlanStatus)(apiKey);
        await (0, accountsStore_1.applySnapshot)(account.id, snap);
    }
    catch (e) {
        (0, log_1.log)(`initial getPlanStatus failed for ${email}:`, e?.message || e);
    }
    return account;
}
// ---------------------------------------------------------------------------
// Batch import  (port of desktop BatchImportWindow + MainWindowViewModel.BatchImportAsync)
// ---------------------------------------------------------------------------
async function cmdBatchImport(sidebar) {
    // Prefer the in-sidebar modal overlay; the textarea inside the modal
    // replaces the old openTextDocument + showInformationMessage flow.
    await sidebar.openModal('batch');
}
/**
 * Internal command invoked by the sidebar batch-import modal's
 * "Start Import" button. Parses the raw text with the existing importParser
 * and kicks off the shared progress-tracked import loop.
 */
async function cmdSubmitBatchFromModal(sidebar, args) {
    const text = args?.text || '';
    const pairs = (0, importParser_1.parseBatch)(text);
    if (pairs.length === 0) {
        statusWarn('No accounts parsed');
        return;
    }
    await runBatchImport(sidebar, pairs);
}
async function runBatchImport(sidebar, pairs) {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Batch Import 0/${pairs.length}`,
        cancellable: true
    }, async (progress, token) => {
        let ok = 0;
        let skip = 0;
        let fail = 0;
        for (let i = 0; i < pairs.length; i++) {
            if (token.isCancellationRequested) {
                break;
            }
            const p = pairs[i];
            progress.report({
                message: `${i + 1}/${pairs.length} · ${p.email}`,
                increment: 100 / pairs.length
            });
            try {
                // Token-only entries (exported from browser sign-in / OAuth
                // accounts) carry the credential in `idToken` instead of a
                // password — skip the email/password login round-trip and
                // import the token directly.
                if (p.idToken && !p.password) {
                    await addOneAccountFromToken(p.idToken, p.displayName || p.email);
                }
                else {
                    await addOneAccount(p.email, p.password);
                }
                ok++;
            }
            catch (e) {
                const msg = String(e?.message || e);
                if (msg.includes('already exists')) {
                    skip++;
                }
                else {
                    fail++;
                    (0, log_1.log)(`batchImport failed for ${p.email}: ${msg}`);
                }
            }
        }
        vscode.window.showInformationMessage(`Batch Import Complete: Added ${ok} · Skipped ${skip} · Failed ${fail}${fail ? ' (see logs)' : ''}`);
        await sidebar.reload();
    });
}
// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
async function deleteById(context, sidebar, accountId) {
    const account = sidebar.findAccount(accountId);
    const label = account?.email || accountId;
    const confirmed = await vscode.window.showWarningMessage(`Confirm delete ${label}? This action cannot be undone.`, { modal: true }, 'Delete');
    if (confirmed !== 'Delete') {
        return;
    }
    try {
        await (0, accountsStore_1.deleteAccount)(accountId);
        await (0, tokens_1.invalidateToken)(context, accountId);
        await (0, memoryCreds_1.removeCreds)(accountId);
        statusOk(`Deleted ${label}`);
    }
    catch (e) {
        (0, log_1.log)('deleteById failed:', e);
        vscode.window.showErrorMessage(`Delete failed: ${e?.message || e}`);
    }
    finally {
        await sidebar.reload();
    }
}
// ---------------------------------------------------------------------------
// Remark
// ---------------------------------------------------------------------------
async function editRemarkById(sidebar, accountId) {
    const account = sidebar.findAccount(accountId);
    if (!account) {
        vscode.window.showErrorMessage('Account not found, please refresh and try again');
        return;
    }
    const value = await vscode.window.showInputBox({
        title: `Remark - ${account.email}`,
        prompt: 'Up to 4 characters',
        value: account.remark,
        ignoreFocusOut: true,
        validateInput: v => (v.length <= 4 ? undefined : 'No more than 4 characters')
    });
    if (value === undefined) {
        return;
    }
    try {
        await (0, accountsStore_1.updateRemark)(accountId, value);
        statusOk(`Remark saved`);
    }
    catch (e) {
        (0, log_1.log)('editRemarkById failed:', e);
        vscode.window.showErrorMessage(`Update failed: ${e?.message || e}`);
    }
    finally {
        await sidebar.reload();
    }
}
// ---------------------------------------------------------------------------
// Credentials (decrypted display of email/password, with copy button) — port of CredentialsWindow
// ---------------------------------------------------------------------------
async function showCredentials(sidebar, accountId) {
    const account = sidebar.findAccount(accountId);
    if (!account) {
        vscode.window.showErrorMessage('Account not found, please refresh and try again');
        return;
    }
    await sidebar.openModal('creds', { id: accountId, email: account.email });
}
// ---------------------------------------------------------------------------
// Refresh plan / quota
// ---------------------------------------------------------------------------
function isMigratedPlanStatusError(error) {
    const msg = String(error?.message || error || '');
    return /has been migrated/i.test(msg) || /please log in again/i.test(msg);
}
async function getPlanStatusWithRecovery(context, account) {
    const idToken = await (0, tokens_1.ensureFreshIdToken)(context, account);
    try {
        return await (0, windsurfApi_1.getPlanStatus)(idToken);
    }
    catch (e) {
        if (!isMigratedPlanStatusError(e)) {
            throw e;
        }
        (0, log_1.log)(`getPlanStatus requires re-login for ${account.email}:`, e?.message || e);
        try {
            await (0, tokens_1.invalidateToken)(context, account.id);
        }
        catch {
            // ignore
        }
        const retryToken = await (0, tokens_1.ensureFreshIdToken)(context, account, {
            forceRelogin: true,
            preferAuth1: true
        });
        return await (0, windsurfApi_1.getPlanStatus)(retryToken);
    }
}
async function refreshOne(context, sidebar, accountId) {
    let account = sidebar.findAccount(accountId);
    if (!account) {
        const all = await (0, accountsStore_1.loadManagerAccounts)();
        account = all.find(a => a.id === accountId);
    }
    if (!account) {
        vscode.window.showErrorMessage('Account not found');
        return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Windsurf: Refresh ${account.email}...` }, async () => {
        try {
            const snap = await getPlanStatusWithRecovery(context, account);
            await (0, accountsStore_1.applySnapshot)(account.id, snap);
            statusOk(`${account.email}: ${snap.planName} · Daily ${snap.dailyRemainPct ?? '-'}% · Weekly ${snap.weeklyRemainPct ?? '-'}%`);
        }
        catch (e) {
            (0, log_1.log)('refreshOne failed:', e);
            try {
                await (0, accountsStore_1.markQuotaError)(account.id);
            }
            catch {
                // ignore
            }
            vscode.window.showErrorMessage(`${account.email}: ${e?.message || e}`);
        }
        finally {
            await sidebar.reload();
        }
    });
}
const REFRESH_ALL_CONCURRENCY = 4;
async function refreshAll(context, sidebar) {
    const accounts = await (0, accountsStore_1.loadManagerAccounts)();
    if (accounts.length === 0) {
        return;
    }
    // As requested: always clear smart switch cooldown pool when refreshing all.
    await clearSmartHistory(context);
    // Free account throttling: only include Free accounts when counter % N === 0.
    const counter = (context.globalState.get(GS.refreshAllCounter) || 0) + 1;
    await context.globalState.update(GS.refreshAllCounter, counter);
    const includeFree = counter % FREE_REFRESH_EVERY_N === 0;
    const switchable = accounts
        .filter(isSwitchable)
        .filter(a => includeFree || (a.planName || '').toLowerCase() !== 'free');
    if (switchable.length === 0) {
        // Only Free accounts and skipped this round, or no refreshable accounts.
        if (!includeFree && accounts.some(a => (a.planName || '').toLowerCase() === 'free')) {
            statusOk(`Skipping free accounts this round (1 in every ${FREE_REFRESH_EVERY_N} refreshes)`); // Translated
        }
        else {
            vscode.window.showInformationMessage('No accounts to refresh');
        }
        // Even if not refreshing, notify sidebar to reload (cooldown cleared)
        await sidebar.reload();
        return;
    }
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Batch Refresh 0/${switchable.length}`,
        cancellable: true
    }, async (progress, token) => {
        const total = switchable.length;
        const results = [];
        let done = 0;
        let failed = 0;
        let index = 0;
        async function worker() {
            while (!token.isCancellationRequested) {
                const i = index++;
                if (i >= total)
                    return;
                const account = switchable[i];
                try {
                    const snap = await getPlanStatusWithRecovery(context, account);
                    results.push({ accountId: account.id, snapshot: snap });
                }
                catch (e) {
                    (0, log_1.log)(`refreshAll: ${account.email} failed -`, e?.message || e);
                    failed++;
                    results.push({ accountId: account.id, error: true });
                }
                done++;
                progress.report({
                    message: `${done}/${total} · ${account.email}`,
                    increment: 100 / total
                });
            }
        }
        const concurrency = Math.min(REFRESH_ALL_CONCURRENCY, total);
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
        try {
            await (0, accountsStore_1.applyManySnapshots)(results);
        }
        catch (e) {
            (0, log_1.log)('applyManySnapshots failed:', e?.message || e);
        }
        vscode.window.showInformationMessage(`Batch Refresh Complete: Success ${done - failed} · Failed ${failed}`);
        await sidebar.reload();
    });
}
// ---------------------------------------------------------------------------
// Fix credentials: prompt for password, login, and overwrite idToken/refreshToken/password.
// ---------------------------------------------------------------------------
async function fixCredentialsById(sidebar, accountId) {
    const records = await (0, accountsStore_1.loadAccountsEncrypted)();
    const rec = records.find(r => r.id === accountId);
    if (!rec) {
        vscode.window.showErrorMessage('Account does not exist');
        return;
    }
    const email = rec.email || '';
    if (!email) {
        vscode.window.showErrorMessage('Account missing email, cannot fix. Please delete and re-add.');
        return;
    }
    const password = await vscode.window.showInputBox({
        title: `Fix Credentials - ${email}`,
        prompt: 'Enter password for this account (to re-login and get refreshToken)',
        password: true,
        ignoreFocusOut: true
    });
    if (!password) {
        return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Windsurf: Re-login ${email}...` }, async () => {
        try {
            const login = await (0, windsurfApi_1.login)(email, password);
            const expiresAt = Date.now() + login.expiresInSeconds * 1000;
            await (0, accountsStore_1.applyLoginTokens)(accountId, login.idToken, login.refreshToken, expiresAt, login.displayName || rec.displayName || '', password, login.authProvider, login.auth1Token || '', login.accountId || '', login.primaryOrgId || '');
            await (0, memoryCreds_1.putCreds)(accountId, {
                email,
                password,
                idToken: login.idToken,
                refreshToken: login.refreshToken || '',
                auth1Token: login.auth1Token || '',
                idTokenExpiresAt: expiresAt
            });
            await (0, memoryCreds_1.updateTokenFields)(accountId, login.idToken, login.refreshToken || '', expiresAt);
            statusOk(`Fixed credentials for ${email}`);
        }
        catch (e) {
            (0, log_1.log)('fixCredentialsById failed:', e);
            vscode.window.showErrorMessage(`Fix failed: ${e?.message || e}`);
        }
        finally {
            await sidebar.reload();
        }
    });
}
// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
async function cmdListAccounts() {
    const accounts = await (0, accountsStore_1.loadManagerAccounts)();
    const channel = (0, log_1.getOutputChannel)();
    channel.show(true);
    (0, log_1.log)('--- Accounts ---');
    if (accounts.length === 0) {
        (0, log_1.log)('(empty)');
        return;
    }
    for (const a of accounts) {
        (0, log_1.log)(`- ${a.email}`, `[${a.authProvider}]`, a.displayName ? `(${a.displayName})` : '', `plan=${a.planName}`, `d=${a.dailyRemainPct ?? '-'}%`, `w=${a.weeklyRemainPct ?? '-'}%`, a.remark ? `note=${a.remark}` : '', a.lastQueryTime ? `updated=${a.lastQueryTime}` : '');
    }
}
// ---------------------------------------------------------------------------
// Export accounts as a portable encrypted bundle (`.wssbundle`).
//
// Single-file, password-protected snapshot of every account that has a
// usable credential (password or any session token). The bundle works
// identically on Windows / macOS / Linux because the encryption is plain
// Node `crypto` (PBKDF2-SHA256 + AES-256-GCM) — no DPAPI / Keychain
// platform-specific behaviour leaks into the file.
//
// Flow:
//   1. Batched cross-platform decrypt of every password + token field.
//   2. Build a flat JSON array of `BundleAccountEntry`.
//   3. Ask for an optional password (empty = unencrypted envelope).
//   4. Save dialog → write the envelope JSON to disk.
//
// Re-import on any machine via `cmdImportAccounts` (see below).
// ---------------------------------------------------------------------------
async function cmdExportAccounts() {
    const records = await (0, accountsStore_1.loadAccountsEncrypted)();
    if (records.length === 0) {
        vscode.window.showInformationMessage('No accounts to export.');
        return;
    }
    // Decrypt every secret field for every record in one batch.
    const FIELDS_PER_RECORD = 4;
    const ciphers = [];
    for (const r of records) {
        ciphers.push(r.passwordProtected || '');
        ciphers.push(r.idTokenProtected || '');
        ciphers.push(r.refreshTokenProtected || '');
        ciphers.push(r.auth1TokenProtected || '');
    }
    let plains;
    try {
        plains = await (0, dpapi_1.dpapiUnprotectBatch)(ciphers);
    }
    catch (e) {
        vscode.window.showErrorMessage(`Decryption failed: ${e?.message || e}`);
        (0, log_1.log)('exportAccounts: decrypt batch failed -', e?.message || e);
        return;
    }
    const entries = [];
    let pwdCount = 0;
    let tokenCount = 0;
    let skipped = 0;
    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        const base = i * FIELDS_PER_RECORD;
        const pwd = plains[base] || '';
        const idToken = plains[base + 1] || '';
        const refreshToken = plains[base + 2] || '';
        const auth1Token = plains[base + 3] || '';
        if (!r.email) {
            skipped++;
            continue;
        }
        const entry = { email: r.email };
        if (pwd) {
            entry.password = pwd;
            pwdCount++;
        }
        else if (idToken || auth1Token) {
            entry.idToken = idToken || auth1Token;
            if (refreshToken)
                entry.refreshToken = refreshToken;
            if (auth1Token)
                entry.auth1Token = auth1Token;
            tokenCount++;
        }
        else {
            // No credential we could re-import.
            skipped++;
            continue;
        }
        if (r.authProvider)
            entry.authProvider = r.authProvider;
        if (r.displayName)
            entry.displayName = r.displayName;
        if (r.remark)
            entry.remark = r.remark;
        entries.push(entry);
    }
    if (entries.length === 0) {
        vscode.window.showWarningMessage('No exportable accounts (none have a password or session token). Use "Fix Credentials" to add credentials first.');
        return;
    }
    // Ask for an optional password. Empty input = unencrypted envelope (still
    // valid `.wssbundle`, just `encryption: "none"`).
    const password = await vscode.window.showInputBox({
        title: `Export ${entries.length} accounts \u2014 set a bundle password`,
        prompt: 'Enter a password to encrypt the bundle (leave empty to skip encryption).',
        password: true,
        placeHolder: 'Bundle password (optional)',
        ignoreFocusOut: true
    });
    if (password === undefined) {
        // User pressed Esc.
        return;
    }
    if (password) {
        const confirm = await vscode.window.showInputBox({
            title: 'Confirm bundle password',
            prompt: 'Re-enter the same password to confirm.',
            password: true,
            placeHolder: 'Repeat password',
            ignoreFocusOut: true
        });
        if (confirm === undefined) {
            return;
        }
        if (confirm !== password) {
            vscode.window.showErrorMessage('Passwords do not match. Export cancelled.');
            return;
        }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const suggestedName = `windsurf-accounts-${stamp}.${bundle_1.BUNDLE_FILE_EXTENSION}`;
    const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri
        || vscode.Uri.file(require('os').homedir());
    const target = await vscode.window.showSaveDialog({
        title: 'Save accounts bundle',
        defaultUri: vscode.Uri.joinPath(defaultDir, suggestedName),
        filters: {
            'Windsurf Switch bundle': [bundle_1.BUNDLE_FILE_EXTENSION],
            'All files': ['*']
        },
        saveLabel: password ? 'Save encrypted bundle' : 'Save bundle'
    });
    if (!target) {
        return;
    }
    let envelope;
    try {
        envelope = bundle_1.packBundle(entries, password || undefined);
    }
    catch (e) {
        vscode.window.showErrorMessage(`Failed to pack bundle: ${e?.message || e}`);
        (0, log_1.log)('exportAccounts: pack failed -', e?.message || e);
        return;
    }
    try {
        await vscode.workspace.fs.writeFile(target, Buffer.from(bundle_1.serializeBundle(envelope), 'utf8'));
    }
    catch (e) {
        vscode.window.showErrorMessage(`Failed to write bundle: ${e?.message || e}`);
        (0, log_1.log)('exportAccounts: write failed -', e?.message || e);
        return;
    }
    const enc = password ? 'encrypted' : 'unencrypted';
    const tail = skipped > 0 ? ` (skipped ${skipped} without credentials)` : '';
    const open = 'Reveal in OS';
    vscode.window.showInformationMessage(`Exported ${entries.length} accounts (${pwdCount} password \u00b7 ${tokenCount} token) as ${enc} bundle${tail}.`, open).then(pick => {
        if (pick === open) {
            void vscode.commands.executeCommand('revealFileInOS', target);
        }
    });
    (0, log_1.log)(`exportAccounts: ${entries.length} ok (${pwdCount} pwd, ${tokenCount} token), ${skipped} skipped, enc=${enc}, path=${target.fsPath}`);
}
// ---------------------------------------------------------------------------
// Import accounts from a portable `.wssbundle` file. Reverse of
// `cmdExportAccounts`.
//
//   1. Open dialog → pick a `.wssbundle`.
//   2. Parse the JSON envelope.
//   3. If encrypted, prompt for the password and decrypt (AES-GCM auth tag
//      validates the password — wrong password fails fast).
//   4. Loop over entries with a progress notification, dispatching each to
//      `addOneAccount` (password) or `addOneAccountFromToken` (idToken).
// ---------------------------------------------------------------------------
async function cmdImportAccounts(sidebar) {
    const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri
        || vscode.Uri.file(require('os').homedir());
    const picked = await vscode.window.showOpenDialog({
        title: 'Import accounts bundle',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri: defaultDir,
        filters: {
            'Windsurf Switch bundle': [bundle_1.BUNDLE_FILE_EXTENSION],
            'All files': ['*']
        },
        openLabel: 'Import bundle'
    });
    if (!picked || picked.length === 0) {
        return;
    }
    const fileUri = picked[0];
    let raw;
    try {
        raw = await vscode.workspace.fs.readFile(fileUri);
    }
    catch (e) {
        vscode.window.showErrorMessage(`Failed to read bundle: ${e?.message || e}`);
        return;
    }
    let envelope;
    try {
        envelope = JSON.parse(Buffer.from(raw).toString('utf8'));
    }
    catch (e) {
        vscode.window.showErrorMessage(`Bundle is not valid JSON: ${e?.message || e}`);
        return;
    }
    let password;
    if (bundle_1.isBundleEncrypted(envelope)) {
        const pwd = await vscode.window.showInputBox({
            title: `Unlock ${path.basename(fileUri.fsPath)}`,
            prompt: 'Enter the password that was used to encrypt this bundle.',
            password: true,
            placeHolder: 'Bundle password',
            ignoreFocusOut: true
        });
        if (pwd === undefined) {
            return;
        }
        if (!pwd) {
            vscode.window.showErrorMessage('A password is required to import this bundle.');
            return;
        }
        password = pwd;
    }
    let entries;
    try {
        entries = bundle_1.unpackBundle(envelope, password);
    }
    catch (e) {
        vscode.window.showErrorMessage(`Import failed: ${e?.message || e}`);
        (0, log_1.log)('importAccounts: unpack failed -', e?.message || e);
        return;
    }
    if (!entries || entries.length === 0) {
        vscode.window.showInformationMessage('Bundle is empty \u2014 nothing to import.');
        return;
    }
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Importing 0/${entries.length}`,
        cancellable: true
    }, async (progress, token) => {
        let ok = 0;
        let skip = 0;
        let fail = 0;
        for (let i = 0; i < entries.length; i++) {
            if (token.isCancellationRequested) {
                break;
            }
            const e = entries[i];
            progress.report({
                message: `${i + 1}/${entries.length} \u00b7 ${e.email || '(no email)'}`,
                increment: 100 / entries.length
            });
            if (!e || !e.email) {
                skip++;
                continue;
            }
            try {
                if (e.idToken) {
                    await addOneAccountFromToken(e.idToken, e.displayName || e.email);
                }
                else if (e.password) {
                    await addOneAccount(e.email, e.password);
                }
                else {
                    // Nothing we can act on.
                    skip++;
                    continue;
                }
                ok++;
            }
            catch (err) {
                const msg = String(err?.message || err);
                if (msg.includes('already exists')) {
                    skip++;
                }
                else {
                    fail++;
                    (0, log_1.log)(`importAccounts: failed for ${e.email}: ${msg}`);
                }
            }
        }
        vscode.window.showInformationMessage(`Import complete \u2014 added ${ok} \u00b7 skipped ${skip} \u00b7 failed ${fail}${fail ? ' (see logs)' : ''}`);
        await sidebar.reload();
    });
}
// ---------------------------------------------------------------------------
// Clear accounts — by category (Expired / Free). Users can check both categories to clear.
//   · Expired: expiresAt passed — subscriptions expired but not auto-downgraded to Free
//   · Free: planName === 'free' — includes accounts downgraded after trial (plan API
//     gives these accounts a ~30 day planEnd as next billing cycle reset, so
//     isExpired alone can't catch them)
// Deduplicate union of both categories then delete. If current active account
// is in the delete list, follow standard clearCurrentAccount flow.
// ---------------------------------------------------------------------------
async function cmdClearExpiredAccounts(context, sidebar) {
    const accounts = await (0, accountsStore_1.loadManagerAccounts)();
    const now = Date.now();
    const isExpired = (a) => {
        if (!a.expiresAt) {
            return false;
        }
        const t = Date.parse(a.expiresAt);
        return Number.isFinite(t) && t < now;
    };
    const isFree = (a) => (a.planName || '').toLowerCase() === 'free';
    const expired = accounts.filter(isExpired);
    const free = accounts.filter(isFree);
    if (expired.length === 0 && free.length === 0) {
        vscode.window.showInformationMessage('No accounts to clear (no expired · no free accounts).');
        return;
    }
    // Build category options. Free unchecked by default to avoid deleting intentionally kept Free backup accounts.
    const items = [];
    if (expired.length > 0) {
        items.push({
            label: 'Expired Accounts',
            description: `${expired.length} · Subscription expiresAt passed`,
            picked: true,
            kind: 'expired'
        });
    }
    if (free.length > 0) {
        items.push({
            label: 'Free Accounts',
            description: `${free.length} · Includes trial-ended downgrades`,
            picked: false,
            kind: 'free'
        });
    }
    let picked;
    if (items.length === 1) {
        // Only one category candidate, go directly to confirm, don't force another Enter press.
        picked = items;
    }
    else {
        const sel = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            title: 'Select account categories to clear',
            placeHolder: 'Space to toggle, Enter to confirm'
        });
        if (!sel || sel.length === 0) {
            return;
        }
        picked = sel;
    }
    // Two categories may overlap (both expired and Free), deduplicate by id.
    const targetMap = new Map();
    if (picked.some(p => p.kind === 'expired')) {
        for (const a of expired)
            targetMap.set(a.id, a);
    }
    if (picked.some(p => p.kind === 'free')) {
        for (const a of free)
            targetMap.set(a.id, a);
    }
    const targets = Array.from(targetMap.values());
    if (targets.length === 0) {
        return;
    }
    const preview = targets.slice(0, 5).map(a => a.email).join('\n  · ');
    const more = targets.length > 5 ? `\n  · ...and ${targets.length - 5} more` : '';
    const ans = await vscode.window.showWarningMessage(`Will delete ${targets.length} accounts:\n\n  · ${preview}${more}\n\nThis action cannot be undone.`, { modal: true }, 'Delete');
    if (ans !== 'Delete') {
        return;
    }
    let ok = 0;
    let fail = 0;
    const deletedIds = new Set();
    for (const a of targets) {
        try {
            await (0, accountsStore_1.deleteAccount)(a.id);
            await (0, tokens_1.invalidateToken)(context, a.id);
            await (0, memoryCreds_1.removeCreds)(a.id);
            deletedIds.add(a.id);
            ok++;
        }
        catch (e) {
            fail++;
            (0, log_1.log)(`clearExpired: delete ${a.email} failed -`, e?.message || e);
        }
    }
    // If the active account was among the deletions, wipe currentAccountId /
    // activeEmail so the sidebar / status bar don't keep pointing at a
    // tombstone. Mirrors the explicit clear path used by logout flows.
    const currentId = getCurrentAccountId(context);
    if (currentId && deletedIds.has(currentId)) {
        await clearCurrentAccount(context, 'clearExpiredAccounts');
    }
    if (fail > 0) {
        vscode.window.showWarningMessage(`Cleared ${ok}, ${fail} failed. See logs for details.`);
    }
    else {
        statusOk(`Cleared ${ok} accounts`);
    }
    await sidebar.reload();
}
// ---------------------------------------------------------------------------
// Check for updates — query GitHub Releases API and compare with the
// version baked into package.json. Manual trigger only.
// ---------------------------------------------------------------------------
function compareVersions(a, b) {
    const pa = a.split('.').map(n => parseInt(n, 10) || 0);
    const pb = b.split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const da = pa[i] || 0;
        const db = pb[i] || 0;
        if (da !== db) {
            return da < db ? -1 : 1;
        }
    }
    return 0;
}
async function cmdCheckUpdate(context) {
    const currentVersion = String(context.extension.packageJSON.version || '0.0.0');
    const repoUrl = String(context.extension.packageJSON.repository?.url || '');
    const m = repoUrl.match(/github\.com[:/]+([^/]+)\/([^/.]+)/);
    if (!m) {
        vscode.window.showWarningMessage('Cannot parse repository.url, skipping update check');
        return;
    }
    const owner = m[1];
    const repo = m[2];
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    try {
        const data = await new Promise((resolve, reject) => {
            const req = https.get(apiUrl, {
                headers: {
                    'User-Agent': `windsurf-switch/${currentVersion}`,
                    'Accept': 'application/vnd.github+json'
                }
            }, res => {
                // 200 is the only valid success path. 3xx (no follow) and 4xx/5xx
                // are all treated as failures so the user gets an actionable
                // message instead of a confusing JSON.parse error downstream.
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`GitHub HTTP ${res.statusCode}`));
                    return;
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    }
                    catch (e) {
                        reject(new Error(`GitHub response parse failed: ${e?.message || e}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(10000, () => {
                req.destroy(new Error('Request timed out (10s)'));
                req.destroy(new Error('Request timed out (10s)'));
            });
        });
        const tag = String(data?.tag_name || '').replace(/^v/, '');
        if (!tag) {
            throw new Error('GitHub response missing tag_name');
        }
        if (compareVersions(tag, currentVersion) <= 0) {
            vscode.window.showInformationMessage(`Already on latest version v${currentVersion}`);
            return;
        }
        const action = await vscode.window.showInformationMessage(`Windsurf Switch found new version v${tag} (current v${currentVersion})`, 'View Release', 'Later');
        if (action === 'View Release') {
            const url = String(data?.html_url || `https://github.com/${owner}/${repo}/releases/tag/v${tag}`);
            void vscode.env.openExternal(vscode.Uri.parse(url));
        }
    }
    catch (e) {
        const msg = e?.message || String(e);
        vscode.window.showWarningMessage(`Update check failed: ${msg}`);
        (0, log_1.log)(`checkUpdate failed: ${msg}`);
    }
}
function isSwitchable(a) {
    if (!a.email) {
        return false;
    }
    const provider = (a.authProvider || constants_1.FIREBASE_PROVIDER).toLowerCase();
    if (provider !== constants_1.FIREBASE_PROVIDER && provider !== constants_1.AUTH1_PROVIDER) {
        return false;
    }
    return a.hasCredentials;
}
function describeAccount(a) {
    const parts = [];
    if (a.planName) {
        parts.push(`plan: ${a.planName}`);
    }
    if (a.dailyRemainPct !== null) {
        parts.push(`D ${a.dailyRemainPct}%`);
    }
    if (a.weeklyRemainPct !== null) {
        parts.push(`W ${a.weeklyRemainPct}%`);
    }
    if (a.remark) {
        parts.push(`note: ${a.remark}`);
    }
    return parts.join(' · ');
}
async function runSmartSwitch(context, sidebar, opts) {
    const allAccounts = sidebar.accounts.length > 0 ? sidebar.accounts : await (0, accountsStore_1.loadManagerAccounts)();
    await syncCurrentAccountFromSession(context, allAccounts.length > 0 ? allAccounts : undefined);
    // Pick the candidate source: explicit > sidebar cache > all.
    let source = allAccounts;
    const ids = opts.filteredIds ?? sidebar.getLastCandidateIds();
    if (ids && ids.length > 0) {
        const set = new Set(ids);
        source = allAccounts.filter(a => set.has(a.id));
    }
    const history = getSmartHistory(context);
    const previousAccountId = getCurrentAccountId(context);
    const decision = (0, smartSwitch_1.decide)({
        accounts: source,
        currentAccountId: previousAccountId,
        history
    });
    if (!decision.picked) {
        const msg = `Smart Switch: ${decision.reason}`;
        if (opts.trigger === 'manual') {
            vscode.window.showWarningMessage(msg);
        }
        else {
            vscode.window.setStatusBarMessage(`$(warning) ${msg}`, 30000);
            (0, log_1.log)(msg);
        }
        return false;
    }
    const tried = [];
    for (const cand of decision.candidates.slice(0, 3)) {
        tried.push(cand.email);
        try {
            const idToken = await (0, tokens_1.ensureFreshIdToken)(context, cand);
            const session = await (0, seamlessSwitch_1.seamlessSwitch)(idToken, { email: cand.email, displayName: cand.displayName });
            await setCurrentAccountId(context, cand.id, 'smartSwitch');
            await setActiveEmail(context, cand.email, 'smartSwitch');
            await rememberSessionLabel(context, session?.account?.label, cand.email);
            const newHistory = (0, smartSwitch_1.recordSwitch)(history, cand.id);
            await saveSmartHistory(context, newHistory);
            autoSwitch?.noteExternalSwitch();
            const label = opts.trigger === 'manual' ? 'Smart Switch' : `Auto·${opts.trigger}`;
            const msg = `[${label}] Switched to ${cand.email} · ${decision.reason}`;
            if (opts.trigger === 'manual') {
                statusOk(msg);
            }
            else {
                vscode.window.showInformationMessage(msg);
            }
            (0, log_1.log)(msg);
            await sidebar.reload();
            // Refresh the previous account's quota so the candidate pool reflects
            // accurate numbers next time. Fire-and-forget: do NOT block the
            // switch UX, and do NOT touch the cooldown history.
            if (previousAccountId && previousAccountId !== cand.id) {
                void refreshAccountQuotaSilently(context, sidebar, previousAccountId);
            }
            return true;
        }
        catch (e) {
            (0, log_1.log)(`smartSwitch: candidate ${cand.email} failed -`, e?.message || e);
            try {
                await (0, tokens_1.invalidateToken)(context, cand.id);
            }
            catch {
                /* ignore */
            }
        }
    }
    const failMsg = `Smart Switch failed: Tried ${tried.length} candidates, all failed (${tried.join(', ')})`;
    vscode.window.showErrorMessage(failMsg);
    (0, log_1.log)(failMsg);
    await sidebar.reload();
    return false;
}
/**
 * Query plan-status for the current account. Returns null if no current account
 * is known. Throws on network / API errors so AutoSwitch can count failures.
 */
async function probeCurrentQuota(context) {
    const synced = await syncCurrentAccountFromSession(context, sidebar && sidebar.accounts.length > 0 ? sidebar.accounts : undefined);
    const id = synced.id ?? getCurrentAccountId(context);
    if (!id)
        return null;
    const accounts = sidebar && sidebar.accounts.length > 0
        ? sidebar.accounts
        : await (0, accountsStore_1.loadManagerAccounts)();
    const acc = accounts.find(a => a.id === id);
    if (!acc)
        return null;
    const snap = await getPlanStatusWithRecovery(context, acc);
    await (0, accountsStore_1.applySnapshot)(id, snap);
    // Fire-and-forget reload so UI reflects the polled values.
    void sidebar?.reload();
    // Trigger threshold switch: when off, polling still refreshes data but doesn't trigger switch.
    // Default true, backward compatible with existing users.
    const thresholdEnabled = context.globalState.get(autoSwitch_1.STATE_KEYS.lowQuotaThresholdEnabled, true);
    if (!thresholdEnabled) {
        return { dailyZero: false, weeklyZero: false, error: false };
    }
    // Trigger threshold: Windsurf backend starts rejecting requests before quota reaches 0% (cache + threshold protection),
    // waiting for exact zero is too late. Threshold can be adjusted in sidebar, default 10%.
    const threshold = context.globalState.get(autoSwitch_1.STATE_KEYS.lowQuotaThreshold, autoSwitch_1.DEFAULT_LOW_QUOTA_THRESHOLD);
    const dailyZero = typeof snap.dailyRemainPct === 'number' && snap.dailyRemainPct < threshold;
    const weeklyZero = typeof snap.weeklyRemainPct === 'number' && snap.weeklyRemainPct < threshold;
    return { dailyZero, weeklyZero, error: false };
}
/**
 * Refresh a single account's plan/quota snapshot without any UI noise.
 * Used right after a smart switch to update the "previous" account so the
 * candidate pool stays fresh. Never touches smartHistory / cooldowns.
 */
async function refreshAccountQuotaSilently(context, sidebar, accountId) {
    try {
        const accounts = await (0, accountsStore_1.loadManagerAccounts)();
        const acc = accounts.find(a => a.id === accountId);
        if (!acc || !isSwitchable(acc))
            return;
        const snap = await getPlanStatusWithRecovery(context, acc);
        await (0, accountsStore_1.applySnapshot)(accountId, snap);
        (0, log_1.log)(`post-switch refresh: ${acc.email} D=${snap.dailyRemainPct ?? '-'}% W=${snap.weeklyRemainPct ?? '-'}%`);
    }
    catch (e) {
        (0, log_1.log)(`post-switch refresh of ${accountId} failed:`, e?.message || e);
        try {
            await (0, accountsStore_1.markQuotaError)(accountId);
        }
        catch { /* ignore */ }
    }
    finally {
        void sidebar.reload();
    }
}
async function cmdSmartSwitch(context, sidebar) {
    await runSmartSwitch(context, sidebar, { trigger: 'manual' });
}
/**
 * Debug helper: dump everything we can learn about the current Windsurf
 * auth session to the Output channel. Invoked via the command palette
 * ("Windsurf: Diagnose Login Session") when account identification is misbehaving.
 *
 * Never prints the raw accessToken — only its first 12 characters and the
 * decoded JWT claim keys / values, redacted for long tokens.
 */
async function cmdDiagnoseSession(context) {
    // Clear the diagnose-once cache so extractEmailFromSession re-logs.
    _sessionDiagnoseCache.clear();
    const lines = [];
    lines.push('--- Windsurf Session Diagnose ---');
    ;
    lines.push(`cached currentAccountId = ${getCurrentAccountId(context) ?? '∅'}`);
    lines.push(`cached activeEmail      = ${getActiveEmail(context) ?? '∅'}`);
    const accounts = await (0, accountsStore_1.loadManagerAccounts)();
    const sharedAuth = readSharedJsonObject(context, 'windsurfAuthStatus');
    lines.push(`shared windsurfAuthStatus = ${!sharedAuth.exists ? 'unavailable' : sharedAuth.value ? 'present' : 'null'}`);
    lines.push(`shared extracted email  = ${extractEmailFromSharedAuthStatus(context, accounts, getActiveEmail(context)) ?? '(null)'}`);
    lines.push(`shared lastLoginEmail   = ${readSharedLastLoginEmail(context) ?? '(null)'}`);
    // Silent probe first (the same call we use throughout).
    const silent = await resolveActiveSession();
    lines.push(`silent getSession: ${silent ? 'found' : 'undefined'}`);
    if (silent)
        dumpSession(silent, 'silent', lines);
    // Non-silent as well, in case the extension doesn't have permission yet.
    try {
        const prompted = await vscode.authentication.getSession(constants_1.WINDSURF_AUTH_PROVIDER_ID, ['Login'], { createIfNone: false });
        if (prompted && prompted.id !== silent?.id) {
            dumpSession(prompted, 'prompted', lines);
        }
    }
    catch (e) {
        lines.push(`prompted getSession threw: ${e?.message || e}`);
    }
    lines.push(`accounts.json count = ${accounts.length}`);
    lines.push('accounts emails: ' + accounts.map(a => a.email).join(', '));
    const map = getSessionLabelMap(context);
    const mapEntries = Object.entries(map);
    lines.push(`sessionLabelMap (${mapEntries.length} entries):`);
    for (const [k, v] of mapEntries) {
        lines.push(`  "${k}" → ${v}`);
    }
    lines.push('--- End Diagnose ---');
    const channel = (0, log_1.getOutputChannel)();
    for (const l of lines)
        channel.appendLine(l);
    channel.show(true);
}
/**
 * "Claim Current Login": Windsurf session doesn't carry email, so when user switches
 * accounts through other means causing label to not match accounts.json entry, let user
 * manually select once here, writing "display-name → email" into sessionLabelMap.
 * After that, auto-recognition will work.
 */
async function cmdClaimCurrentSession(context, sidebar) {
    const session = await resolveActiveSession();
    if (!session) {
        vscode.window.showWarningMessage('Windsurf currently has no active login session.');
        return;
    }
    const label = session.account?.label || session.account?.id || '';
    const accounts = sidebar.accounts.length > 0 ? sidebar.accounts : await (0, accountsStore_1.loadManagerAccounts)();
    if (accounts.length === 0) {
        vscode.window.showWarningMessage('Account list is empty, please import accounts first.');
        return;
    }
    const items = accounts
        .slice()
        .sort((a, b) => a.email.localeCompare(b.email))
        .map(a => ({ label: a.email, description: a.remark || '', detail: a.planName || '', id: a.id }));
    const picked = await vscode.window.showQuickPick(items, {
        title: `Windsurf logged in as "${label}", please select matching account (will remember this mapping)`,
        placeHolder: 'Enter email keyword to filter, Enter to confirm',
        matchOnDescription: true,
        matchOnDetail: true
    });
    if (!picked)
        return;
    await rememberSessionLabel(context, label, picked.label);
    // Now immediately reflect the claim in UI.
    await setCurrentAccountId(context, picked.id, 'claimCurrent');
    await setActiveEmail(context, picked.label, 'claimCurrent');
    await sidebar.reload();
    vscode.window.showInformationMessage(`Claimed: ${label} → ${picked.label}`);
    (0, log_1.log)(`claim: "${label}" → ${picked.label}`);
}
function dumpSession(session, tag, out) {
    const token = session.accessToken || '';
    out.push(`[${tag}] session.id          = ${session.id}`);
    out.push(`[${tag}] account.id          = ${session.account?.id ?? ''}`);
    out.push(`[${tag}] account.label       = ${session.account?.label ?? ''}`);
    out.push(`[${tag}] scopes              = ${(session.scopes || []).join(',')}`);
    out.push(`[${tag}] accessToken prefix  = ${token.slice(0, 12)}…(len=${token.length})`);
    const payload = decodeJwtPayload(token);
    if (!payload) {
        out.push(`[${tag}] JWT decode          = FAILED (token is likely opaque, not JWT)`);
        return;
    }
    out.push(`[${tag}] JWT claim keys      = ${Object.keys(payload).join(',')}`);
    for (const k of ['email', 'preferred_username', 'upn', 'name', 'user_id', 'sub']) {
        if (k in payload)
            out.push(`[${tag}] jwt.${k} = ${String(payload[k])}`);
    }
    const extracted = extractEmailFromSession(session);
    out.push(`[${tag}] extracted email     = ${extracted ?? '(null)'}`);
}
/**
 * User clicked "Refresh" on the current-account card.
 * Flow:
 *   1. Re-probe Windsurf's auth session (authoritative).
 *   2. If it matches our cached id → just refresh that account's quota.
 *   3. If it differs → update the cached id/email first, then refresh the
 *      new account. The user sees the correct card the moment we reload.
 *   4. If the session's email is not in our account list → warn but do not
 *      silently refresh the stale id.
 */
async function cmdRefreshCurrentSynced(context, sidebar) {
    const { id, email } = await syncCurrentAccountFromSession(context, sidebar.accounts.length > 0 ? sidebar.accounts : undefined);
    // Reload immediately so the sidebar reflects any id/email correction
    // before we spend time hitting the plan-status API.
    await sidebar.reload();
    if (!id) {
        const looksLikeEmail = !!email && /@/.test(email);
        if (looksLikeEmail) {
            vscode.window.showWarningMessage(`Current Windsurf login ${email} not in extension account list, cannot refresh quota. Please import this account first.`);
        }
        else if (email) {
            vscode.window.showWarningMessage(`Windsurf current login hasn't synced recognizable email (currently showing: ${email}). Please retry later; if persistent, run "Diagnose Login Session (Debug)".`);
        }
        else {
            vscode.window.showWarningMessage('No Windsurf current login session detected.');
        }
        return;
    }
    await vscode.commands.executeCommand('windsurfSwitch.refreshAccount', id);
}
async function cmdSmartSwitchFromSidebar(context, sidebar, args) {
    const ids = Array.isArray(args?.filteredIds) ? args.filteredIds : undefined;
    await runSmartSwitch(context, sidebar, { trigger: 'manual', filteredIds: ids });
}
async function cmdResetSmartCooldown(context, sidebar) {
    await clearSmartHistory(context);
    statusOk('Reset smart switch cooldown');
    await sidebar.reload();
}
async function cmdEditLogPatterns(context) {
    const current = context.globalState.get(autoSwitch_1.STATE_KEYS.logWatchPatterns, autoSwitch_1.DEFAULT_LOG_PATTERNS);
    const raw = await vscode.window.showInputBox({
        title: 'Log Monitor Keywords (1 regex per line; leave empty to restore default)',
        value: current.join('\n'),
        prompt: 'Takes effect immediately. Leave empty to restore defaults.',
        ignoreFocusOut: true
    });
    if (raw === undefined)
        return;
    const next = raw
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
    const final = next.length > 0 ? next : autoSwitch_1.DEFAULT_LOG_PATTERNS;
    await autoSwitch?.setLogWatchPatterns(final);
    statusOk(`Updated ${final.length} log keywords`);
}
async function cmdToggleAuto(context, sidebar, args) {
    if (!autoSwitch)
        return;
    if (args?.kind === 'polling') {
        await autoSwitch.setPollingEnabled(!!args.enabled);
    }
    else if (args?.kind === 'logWatch') {
        await autoSwitch.setLogWatchEnabled(!!args.enabled);
    }
    else if (args?.kind === 'threshold') {
        // Threshold toggle doesn't affect timer, only changes globalState. probeCurrentQuota reads it.
        await context.globalState.update(autoSwitch_1.STATE_KEYS.lowQuotaThresholdEnabled, !!args.enabled);
    }
    await sidebar.reload();
}
async function cmdSetPollingInterval(context, sidebar, args) {
    if (!autoSwitch)
        return;
    const ms = args?.intervalMs;
    if (typeof ms !== 'number' || ms < 15000)
        return;
    await autoSwitch.setPollingInterval(ms);
    await sidebar.reload();
}
// Set auto switch trigger threshold (remaining quota percentage). Called by sidebar input.
// Range 0-99, aligned with frontend UI (input maxlength=2).
async function cmdSetLowQuotaThreshold(context, sidebar, args) {
    const v = args?.threshold;
    if (typeof v !== 'number' || v < 0 || v > 99)
        return;
    await context.globalState.update(autoSwitch_1.STATE_KEYS.lowQuotaThreshold, v);
    await sidebar?.reload();
}
//# sourceMappingURL=extension.js.map