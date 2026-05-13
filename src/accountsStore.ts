import * as fs from "fs";
import * as path from "path";
import * as constants_1 from "./constants";
import * as dpapi_1 from "./dpapi";
import * as log_1 from "./log";
import type {
    Account,
    PersistedAccountRecord,
} from "./types";

export { path };
export { getAccountsDir, getAccountsFilePath } from "./constants";
/**
 * Shared-with-manager accounts storage.
 *
 * We read accounts.json fresh before every mutation, apply our change, and
 * atomically write back via temp + rename. This keeps us safe w.r.t. the
 * desktop manager as long as the user doesn't manipulate the same account
 * in both UIs within the same instant. We do not hold a long-lived lock or
 * retain an in-memory mirror — "last write wins" is acceptable for low-rate
 * account edits.
 */
export async function loadAccountsEncrypted(): Promise<PersistedAccountRecord[]> {
    const file = (0, constants_1.getAccountsFilePath)();
    if (!fs.existsSync(file)) {
        return [];
    }
    const raw = await fs.promises.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
}
/**
 * Load account metadata only — sensitive fields (password, idToken, refreshToken,
 * auth1Token) are left as empty strings. This avoids the N-account × 4-field
 * × PowerShell-cold-start = multi-second freeze on activation / tree refresh.
 *
 * When you actually need to switch / refresh / login, call `loadAccountWithSecrets`
 * for the specific account to lazily DPAPI-decrypt its tokens in a single
 * PowerShell invocation.
 */
export async function loadManagerAccounts(): Promise<Account[]> {
    const records = await loadAccountsEncrypted();
    return records.map(recordToMetaOnly);
}
/** Decrypt a single account's sensitive fields on demand. */
export async function loadAccountWithSecrets(accountId: string): Promise<Account | undefined> {
    const records = await loadAccountsEncrypted();
    const rec = records.find(r => r.id === accountId);
    if (!rec) {
        return undefined;
    }
    const ciphers = [
        rec.passwordProtected || '',
        rec.idTokenProtected || '',
        rec.refreshTokenProtected || '',
        rec.auth1TokenProtected || ''
    ];
    let plains;
    try {
        plains = await (0, dpapi_1.dpapiUnprotectBatch)(ciphers);
    }
    catch (e) {
        (0, log_1.log)(`loadAccountWithSecrets: dpapi batch failed - ${e?.message || e}`);
        plains = ['', '', '', ''];
    }
    const meta = recordToMetaOnly(rec);
    meta.password = plains[0] || '';
    meta.idToken = plains[1] || '';
    meta.refreshToken = plains[2] || '';
    meta.auth1Token = plains[3] || '';
    return meta;
}
function recordToMetaOnly(r) {
    return {
        id: r.id || '',
        email: r.email || '',
        displayName: r.displayName || '',
        authProvider: r.authProvider || constants_1.FIREBASE_PROVIDER,
        accountId: r.accountId || '',
        primaryOrgId: r.primaryOrgId || '',
        password: '',
        idToken: '',
        refreshToken: '',
        auth1Token: '',
        idTokenExpiresAt: Number(r.idTokenExpiresAt) || 0,
        createdAt: r.createdAt || '',
        planName: r.planName || 'Free',
        dailyRemainPct: toNum(r.dailyRemainPct),
        weeklyRemainPct: toNum(r.weeklyRemainPct),
        dailyResetUnix: toNum(r.dailyResetUnix),
        weeklyResetUnix: toNum(r.weeklyResetUnix),
        expiresAt: r.expiresAt || '',
        gracePeriodStatus: r.gracePeriodStatus || '',
        lastQueryTime: r.lastQueryTime || '',
        quotaError: Boolean(r.quotaError),
        remark: r.remark || '',
        hasWindsurfSessionSnapshot: Boolean(r.hasWindsurfSessionSnapshot),
        windsurfSessionCapturedAt: r.windsurfSessionCapturedAt || '',
        hasCredentials: hasAnyCredential(r)
    };
}
/** Cheap check: does the record have any credential we could use to get an IdToken? */
export function hasAnyCredential(r: PersistedAccountRecord): boolean {
    return Boolean(r.passwordProtected ||
        r.idTokenProtected ||
        r.refreshTokenProtected ||
        r.auth1TokenProtected);
}
/** Which accounts (by id) have at least one usable credential on disk. */
export async function loadSwitchabilityMap() {
    const records = await loadAccountsEncrypted();
    const map = new Map();
    for (const r of records) {
        if (r.id) {
            map.set(r.id, hasAnyCredential(r));
        }
    }
    return map;
}
function toNum(v) {
    if (v === null || v === undefined) {
        return null;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
let mutationQueue = Promise.resolve();
function runSerializedMutation(work) {
    const run = mutationQueue.then(work, work);
    mutationQueue = run.then(() => undefined, () => undefined);
    return run;
}
export async function buildPersisted(account: Account): Promise<PersistedAccountRecord> {
    const [passwordProtected, idTokenProtected, refreshTokenProtected, auth1TokenProtected] = await (0, dpapi_1.dpapiProtectBatch)([
        account.password,
        account.idToken,
        account.refreshToken,
        account.auth1Token
    ]);
    return {
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        authProvider: account.authProvider || constants_1.FIREBASE_PROVIDER,
        accountId: account.accountId,
        primaryOrgId: account.primaryOrgId,
        passwordProtected,
        idTokenProtected,
        refreshTokenProtected,
        auth1TokenProtected,
        idTokenExpiresAt: account.idTokenExpiresAt,
        createdAt: account.createdAt,
        planName: account.planName || 'Free',
        dailyRemainPct: account.dailyRemainPct,
        weeklyRemainPct: account.weeklyRemainPct,
        dailyResetUnix: account.dailyResetUnix,
        weeklyResetUnix: account.weeklyResetUnix,
        expiresAt: account.expiresAt,
        gracePeriodStatus: account.gracePeriodStatus,
        lastQueryTime: account.lastQueryTime,
        quotaError: account.quotaError,
        remark: account.remark,
        hasWindsurfSessionSnapshot: account.hasWindsurfSessionSnapshot,
        windsurfSessionCapturedAt: account.windsurfSessionCapturedAt
    };
}
async function writeAtomic(records) {
    const file = (0, constants_1.getAccountsFilePath)();
    await fs.promises.mkdir((0, constants_1.getAccountsDir)(), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const json = JSON.stringify(records, null, 2);
    await fs.promises.writeFile(tmp, json, 'utf8');
    try {
        await fs.promises.rename(tmp, file);
    }
    catch (e) {
        try {
            await fs.promises.copyFile(tmp, file);
            await fs.promises.unlink(tmp);
        }
        catch (fallbackErr) {
            throw new Error(`${e?.message || e}; fallback copy failed: ${fallbackErr?.message || fallbackErr}`);
        }
    }
}
/**
 * Mutate accounts.json by re-reading the latest persisted array, applying the
 * mutator, and writing atomically. Fields in `account` that are already
 * encrypted on disk are preserved untouched unless the mutator supplies a
 * fully-built PersistedAccountRecord via `replace` semantics.
 */
export async function addAccount(newAccount: Account): Promise<void> {
    return runSerializedMutation(async () => {
        const records = await loadAccountsEncrypted();
        if (records.some(r => (r.email || '').toLowerCase() === newAccount.email.toLowerCase())) {
            throw new Error(`Account ${newAccount.email} already exists`);
        }
        const persisted = await buildPersisted(newAccount);
        records.push(persisted);
        await writeAtomic(records);
        (0, log_1.log)(`addAccount: ${newAccount.email}`);
    });
}
export async function deleteAccount(accountId: string): Promise<void> {
    return runSerializedMutation(async () => {
        const records = await loadAccountsEncrypted();
        const filtered = records.filter(r => r.id !== accountId);
        if (filtered.length === records.length) {
            return;
        }
        await writeAtomic(filtered);
        (0, log_1.log)(`deleteAccount: ${accountId}`);
    });
}
export async function updateRemark(accountId: string, remark: string): Promise<void> {
    return runSerializedMutation(async () => {
        const records = await loadAccountsEncrypted();
        const rec = records.find(r => r.id === accountId);
        if (!rec) {
            throw new Error(`Account does not exist: ${accountId}`);
        }
        rec.remark = remark.trim().slice(0, 4);
        await writeAtomic(records);
        (0, log_1.log)(`updateRemark: ${accountId} -> ${remark}`);
    });
}
export async function applySnapshot(accountId: string, snapshot: Partial<Account>): Promise<void> {
    return runSerializedMutation(async () => {
        const records = await loadAccountsEncrypted();
        const rec = records.find(r => r.id === accountId);
        if (!rec) {
            throw new Error(`Account does not exist: ${accountId}`);
        }
        rec.planName = snapshot.planName || 'Free';
        rec.dailyRemainPct = snapshot.dailyRemainPct;
        rec.weeklyRemainPct = snapshot.weeklyRemainPct;
        rec.dailyResetUnix = snapshot.dailyResetUnix;
        rec.weeklyResetUnix = snapshot.weeklyResetUnix;
        rec.expiresAt = snapshot.expiresAt || '';
        rec.gracePeriodStatus = snapshot.gracePeriodStatus || '';
        rec.lastQueryTime = snapshot.lastQueryTime;
        rec.quotaError = false;
        await writeAtomic(records);
        (0, log_1.log)(`applySnapshot: ${rec.email} plan=${rec.planName}`);
    });
}
/**
 * Batch-apply snapshots after a concurrent refreshAll: one read + merge +
 * one atomic write. Avoids N sequential read-modify-write passes that used
 * to dominate wall time with ~100 accounts.
 */
export async function applyManySnapshots(entries) {
    if (entries.length === 0) {
        return;
    }
    return runSerializedMutation(async () => {
        const records = await loadAccountsEncrypted();
        const byId = new Map(records.map(r => [r.id || '', r]));
        const nowIso = new Date().toISOString();
        let changed = false;
        for (const e of entries) {
            const rec = byId.get(e.accountId);
            if (!rec)
                continue;
            if (e.snapshot) {
                rec.planName = e.snapshot.planName || 'Free';
                rec.dailyRemainPct = e.snapshot.dailyRemainPct;
                rec.weeklyRemainPct = e.snapshot.weeklyRemainPct;
                rec.dailyResetUnix = e.snapshot.dailyResetUnix;
                rec.weeklyResetUnix = e.snapshot.weeklyResetUnix;
                rec.expiresAt = e.snapshot.expiresAt || '';
                rec.gracePeriodStatus = e.snapshot.gracePeriodStatus || '';
                rec.lastQueryTime = e.snapshot.lastQueryTime;
                rec.quotaError = false;
                changed = true;
            }
            else if (e.error) {
                rec.quotaError = true;
                rec.lastQueryTime = nowIso;
                changed = true;
            }
        }
        if (changed) {
            await writeAtomic(records);
        }
    });
}
export async function markQuotaError(accountId: string): Promise<void> {
    return runSerializedMutation(async () => {
        const records = await loadAccountsEncrypted();
        const rec = records.find(r => r.id === accountId);
        if (!rec) {
            return;
        }
        rec.quotaError = true;
        rec.lastQueryTime = new Date().toISOString();
        await writeAtomic(records);
    });
}
/**
 * Update auth1 session fields (idToken = sessionToken; auth1Token refreshed if given).
 * Preserves all other fields. Used by "auth1-only" accounts when we mint a fresh
 * sessionToken from a still-valid auth1Token (step B only).
 */
export async function applyAuth1Tokens(accountId, sessionToken, auth1Token, expiresAt, nextAccountId, nextPrimaryOrgId) {
    return runSerializedMutation(async () => {
        const records = await loadAccountsEncrypted();
        const rec = records.find(r => r.id === accountId);
        if (!rec) {
            throw new Error(`Account does not exist: ${accountId}`);
        }
        const [idProt, authProt] = await (0, dpapi_1.dpapiProtectBatch)([sessionToken || '', auth1Token || '']);
        if (sessionToken) {
            rec.idTokenProtected = idProt;
        }
        if (auth1Token) {
            rec.auth1TokenProtected = authProt;
        }
        if (expiresAt) {
            rec.idTokenExpiresAt = expiresAt;
        }
        rec.authProvider = constants_1.AUTH1_PROVIDER;
        rec.refreshTokenProtected = '';
        if (nextAccountId !== undefined) {
            rec.accountId = nextAccountId || '';
        }
        if (nextPrimaryOrgId !== undefined) {
            rec.primaryOrgId = nextPrimaryOrgId || '';
        }
        await writeAtomic(records);
    });
}
/** Update token fields after a Firebase refresh/login. Preserves other fields. */
export async function applyLoginTokens(accountId, idToken, refreshToken, expiresAt, displayName, password, authProvider, auth1Token, nextAccountId, nextPrimaryOrgId) {
    return runSerializedMutation(async () => {
        const records = await loadAccountsEncrypted();
        const rec = records.find(r => r.id === accountId);
        if (!rec) {
            throw new Error(`Account does not exist: ${accountId}`);
        }
        const inputs = [idToken || '', refreshToken || '', password ?? '', auth1Token || ''];
        const [idProt, rtProt, pwdProt, authProt] = await (0, dpapi_1.dpapiProtectBatch)(inputs);
        if (idToken) {
            rec.idTokenProtected = idProt;
        }
        rec.refreshTokenProtected = refreshToken ? rtProt : '';
        if (password !== undefined) {
            rec.passwordProtected = pwdProt;
        }
        if (authProvider !== undefined) {
            rec.authProvider = authProvider || constants_1.FIREBASE_PROVIDER;
        }
        if (auth1Token !== undefined) {
            rec.auth1TokenProtected = auth1Token ? authProt : '';
        }
        else if ((authProvider || '').toLowerCase() === constants_1.FIREBASE_PROVIDER) {
            rec.auth1TokenProtected = '';
        }
        if (nextAccountId !== undefined) {
            rec.accountId = nextAccountId || '';
        }
        if (nextPrimaryOrgId !== undefined) {
            rec.primaryOrgId = nextPrimaryOrgId || '';
        }
        if (expiresAt) {
            rec.idTokenExpiresAt = expiresAt;
        }
        if (displayName) {
            rec.displayName = displayName;
        }
        await writeAtomic(records);
    });
}
export function ensureAccountsDir(): void {
    try {
        fs.mkdirSync((0, constants_1.getAccountsDir)(), { recursive: true });
    }
    catch {
        // ignore
    }
}
export function accountsFileExists(): boolean {
    return fs.existsSync((0, constants_1.getAccountsFilePath)());
}