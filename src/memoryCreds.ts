import * as crypto from "crypto";
import * as accountsStore_1 from "./accountsStore";
import * as dpapi_1 from "./dpapi";
import * as log_1 from "./log";
import type * as vscode from "vscode";
import type { PersistedAccountRecord } from "./types";

export interface CachedCredentials {
    email: string;
    password: string;
    idToken: string;
    refreshToken: string;
    auth1Token: string;
    idTokenExpiresAt: number;
}

type MemoryCredsStatus =
    | { state: 'idle' }
    | { state: 'loading'; done: number; total: number }
    | { state: 'ready'; total: number; durationMs: number; hitCount: number; missCount: number }
    | { state: 'error'; message: string };

type StatusListener = (status: MemoryCredsStatus) => void;
type CredentialKind = 'password' | 'idToken' | 'refreshToken' | 'auth1Token';

interface StoredCredsBlob {
    v: 1;
    fp: string;
    creds: CachedCredentials;
}

const SECRET_KEY_PREFIX = 'windsurf:creds:v1:';
const INDEX_KEY = 'windsurf:creds:v1:__index__'; // list of accountIds currently stored
const cache = new Map<string, CachedCredentials>();
let readyPromise: Promise<void> | null = null;
let status: MemoryCredsStatus = { state: 'idle' };
const listeners = new Set<StatusListener>();
let secretStorage: vscode.SecretStorage | undefined;
function setStatus(next: MemoryCredsStatus): void {
    status = next;
    for (const l of listeners) {
        try {
            l(next);
        }
        catch {
            /* listener errors must never break decryption */
        }
    }
}
export function onStatusChange(listener: StatusListener): () => boolean {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
export function getStatus(): MemoryCredsStatus {
    return status;
}
/**
 * Must be called once during activation before the first kickoff. If it's
 * not called we silently fall back to memory-only mode (current session only).
 */
export function attachSecretStorage(secrets: vscode.SecretStorage): void {
    secretStorage = secrets;
}
/**
 * Kick off background decryption. Safe to call multiple times.
 */
export function kickoffBackgroundDecrypt(): Promise<void> {
    if (readyPromise) {
        return readyPromise;
    }
    readyPromise = runDecrypt().catch(e => {
        (0, log_1.log)('memoryCreds: background decrypt failed', e?.message || e);
    });
    return readyPromise;
}
function fingerprint(r: PersistedAccountRecord): string {
    const h = crypto.createHash('sha256');
    h.update(r.passwordProtected || '');
    h.update('\x1f');
    h.update(r.idTokenProtected || '');
    h.update('\x1f');
    h.update(r.refreshTokenProtected || '');
    h.update('\x1f');
    h.update(r.auth1TokenProtected || '');
    return h.digest('hex');
}
async function readPersistedIndex(): Promise<string[]> {
    if (!secretStorage) {
        return [];
    }
    try {
        const raw = await secretStorage.get(INDEX_KEY);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
    }
    catch {
        return [];
    }
}
async function writePersistedIndex(ids: string[]): Promise<void> {
    if (!secretStorage) {
        return;
    }
    try {
        await secretStorage.store(INDEX_KEY, JSON.stringify(ids));
    }
    catch (e) {
        (0, log_1.log)('memoryCreds: failed to write index', e?.message || e);
    }
}
async function readStored(accountId: string): Promise<StoredCredsBlob | undefined> {
    if (!secretStorage) {
        return undefined;
    }
    try {
        const raw = await secretStorage.get(SECRET_KEY_PREFIX + accountId);
        if (!raw) {
            return undefined;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.v !== 1 || typeof parsed.fp !== 'string' || !parsed.creds) {
            return undefined;
        }
        return parsed;
    }
    catch {
        return undefined;
    }
}
async function writeStored(accountId: string, creds: CachedCredentials, fp: string): Promise<void> {
    if (!secretStorage) {
        return;
    }
    try {
        const blob = { v: 1, fp, creds };
        await secretStorage.store(SECRET_KEY_PREFIX + accountId, JSON.stringify(blob));
    }
    catch (e) {
        (0, log_1.log)('memoryCreds: failed to persist creds', e?.message || e);
    }
}
async function deleteStored(accountId: string): Promise<void> {
    if (!secretStorage) {
        return;
    }
    try {
        await secretStorage.delete(SECRET_KEY_PREFIX + accountId);
    }
    catch (e) {
        (0, log_1.log)('memoryCreds: failed to delete creds', e?.message || e);
    }
}
async function runDecrypt(): Promise<void> {
    const started = Date.now();
    let rawRecords;
    try {
        rawRecords = await (0, accountsStore_1.loadAccountsEncrypted)();
    }
    catch (e) {
        setStatus({ state: 'error', message: `读取 accounts.json 失败: ${e?.message || e}` });
        return;
    }
    // Accounts without an id are considered corrupt; skip them and never
    // cache them (the sidebar already filters them too).
    const records = rawRecords.filter((r) => typeof r.id === 'string' && r.id.length > 0);
    if (records.length === 0) {
        setStatus({ state: 'ready', total: 0, durationMs: 0, hitCount: 0, missCount: 0 });
        // Still purge stale entries from SecretStorage.
        await purgeStale([]);
        return;
    }
    setStatus({ state: 'loading', done: 0, total: records.length });
    // Step 1: compute fingerprints, try SecretStorage concurrently.
    const fps = new Map();
    for (const r of records) {
        fps.set(r.id, fingerprint(r));
    }
    const storedEntries = await Promise.all(records.map(async (r) => ({ r, stored: await readStored(r.id) })));
    const missing = [];
    let hitCount = 0;
    for (const { r, stored } of storedEntries) {
        const fp = fps.get(r.id) || '';
        if (stored && stored.fp === fp) {
            // cache hit - use plaintext from SecretStorage
            cache.set(r.id, {
                email: r.email || '',
                password: stored.creds.password || '',
                idToken: stored.creds.idToken || '',
                refreshToken: stored.creds.refreshToken || '',
                auth1Token: stored.creds.auth1Token || '',
                idTokenExpiresAt: Number(r.idTokenExpiresAt) || stored.creds.idTokenExpiresAt || 0
            });
            hitCount++;
        }
        else {
            missing.push(r);
        }
    }
    // Step 2: for misses, one batched DPAPI call for all 4 fields × missing accounts.
    if (missing.length > 0) {
        const fields: Array<{ accountId: string; cipher: string; kind: CredentialKind }> = [];
        for (const r of missing) {
            fields.push({ accountId: r.id, cipher: r.passwordProtected || '', kind: 'password' });
            fields.push({ accountId: r.id, cipher: r.idTokenProtected || '', kind: 'idToken' });
            fields.push({ accountId: r.id, cipher: r.refreshTokenProtected || '', kind: 'refreshToken' });
            fields.push({ accountId: r.id, cipher: r.auth1TokenProtected || '', kind: 'auth1Token' });
        }
        let plains;
        try {
            plains = await (0, dpapi_1.dpapiUnprotectBatch)(fields.map(f => f.cipher));
        }
        catch (e) {
            setStatus({ state: 'error', message: `DPAPI 批量解密失败: ${e?.message || e}` });
            return;
        }
        for (const r of missing) {
            cache.set(r.id, {
                email: r.email || '',
                password: '',
                idToken: '',
                refreshToken: '',
                auth1Token: '',
                idTokenExpiresAt: Number(r.idTokenExpiresAt) || 0
            });
        }
        for (let i = 0; i < fields.length; i++) {
            const f = fields[i];
            const entry = cache.get(f.accountId);
            if (!entry) {
                continue;
            }
            entry[f.kind] = plains[i] || '';
        }
        // Step 3: persist each missing account to SecretStorage for next time.
        await Promise.all(missing.map(r => {
            const creds = cache.get(r.id);
            return creds ? writeStored(r.id, creds, fps.get(r.id) || '') : Promise.resolve();
        }));
    }
    // Step 4: update the index and purge orphaned SecretStorage entries.
    await purgeStale(records.map(r => r.id));
    const duration = Date.now() - started;
    (0, log_1.log)(`memoryCreds: total=${records.length} hit=${hitCount} miss=${missing.length} in ${duration}ms`);
    setStatus({
        state: 'ready',
        total: records.length,
        durationMs: duration,
        hitCount,
        missCount: missing.length
    });
}
async function purgeStale(liveIds: string[]): Promise<void> {
    if (!secretStorage) {
        return;
    }
    const live = new Set(liveIds);
    const previous = await readPersistedIndex();
    const stale = previous.filter(id => !live.has(id));
    if (stale.length > 0) {
        await Promise.all(stale.map(id => deleteStored(id)));
        (0, log_1.log)(`memoryCreds: purged ${stale.length} stale SecretStorage entr(y/ies)`);
    }
    await writePersistedIndex(liveIds);
}
/** Wait for the background decrypt to finish, then return the cached creds. */
export async function getCreds(accountId: string): Promise<CachedCredentials | undefined> {
    if (!readyPromise) {
        kickoffBackgroundDecrypt();
    }
    await readyPromise;
    return cache.get(accountId);
}
/** Synchronous read; returns undefined if not yet populated. */
export function peekCreds(accountId: string): CachedCredentials | undefined {
    return cache.get(accountId);
}
/** Drop an entry (account deleted). Also removes from SecretStorage. */
export async function removeCreds(accountId: string): Promise<void> {
    cache.delete(accountId);
    await deleteStored(accountId);
    // Update index
    const previous = await readPersistedIndex();
    const updated = previous.filter(id => id !== accountId);
    if (updated.length !== previous.length) {
        await writePersistedIndex(updated);
    }
}
/**
 * Insert or update an entry (new account added, or tokens refreshed).
 *
 * If the caller doesn't provide a fingerprint, we re-read accounts.json to
 * compute one so the SecretStorage cache stays consistent with disk. Passing
 * `fp` explicitly is slightly faster when you already have the record handy.
 */
export async function putCreds(accountId: string, creds: CachedCredentials, fp?: string): Promise<void> {
    cache.set(accountId, creds);
    const actualFp = fp || (await currentFingerprint(accountId)) || '';
    if (actualFp) {
        await writeStored(accountId, creds, actualFp);
    }
    const previous = await readPersistedIndex();
    if (!previous.includes(accountId)) {
        await writePersistedIndex([...previous, accountId]);
    }
}
/**
 * Convenience: rebuild fingerprint from a freshly-persisted record. Used by
 * add-account / refresh-tokens flows after accountsStore wrote new ciphertext.
 */
export function fingerprintFromRecord(r: PersistedAccountRecord): string {
    return fingerprint(r);
}
/**
 * Update the in-memory + SecretStorage entry after Firebase refresh/login
 * rotated the tokens. The caller is responsible for writing the new cipher
 * to accounts.json first; we re-read that record to compute the fingerprint.
 */
export async function updateTokenFields(
    accountId: string,
    idToken: string,
    refreshToken: string,
    idTokenExpiresAt: number,
    record?: PersistedAccountRecord
): Promise<void> {
    const cur = cache.get(accountId);
    if (!cur) {
        return;
    }
    cur.idToken = idToken;
    cur.refreshToken = refreshToken || cur.refreshToken;
    cur.idTokenExpiresAt = idTokenExpiresAt;
    const fp = record ? fingerprint(record) : await currentFingerprint(accountId);
    if (fp) {
        await writeStored(accountId, cur, fp);
    }
}
async function currentFingerprint(accountId: string): Promise<string | undefined> {
    try {
        const records = await (0, accountsStore_1.loadAccountsEncrypted)();
        const r = records.find(x => x.id === accountId);
        return r ? fingerprint(r) : undefined;
    }
    catch {
        return undefined;
    }
}
/** After an external rewrite (e.g. desktop manager modified the file), reload. */
export async function invalidateAndReload(): Promise<void> {
    readyPromise = null;
    cache.clear();
    setStatus({ state: 'idle' });
    return kickoffBackgroundDecrypt();
}
