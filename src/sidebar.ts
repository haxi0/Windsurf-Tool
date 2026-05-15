import * as crypto from "crypto";
import * as vscode from "vscode";
import * as accountsStore_1 from "./accountsStore";
import * as importParser_1 from "./importParser";
import * as log_1 from "./log";
import * as memoryCreds_1 from "./memoryCreds";
import * as autoSwitch_1 from "./autoSwitch";
import * as smartSwitch_1 from "./smartSwitch";
const UI_KEYS = {
    sortCollapsed: 'wm.ui.sortCollapsed',
    filterCollapsed: 'wm.ui.filterCollapsed'
};
/**
 * Primary UI for the extension: a Webview View that lives in the Activity Bar
 * container `windsurfSwitch`. It mirrors the desktop manager's MainWindow
 * (top toolbar + sort chip + filter chips + account cards with per-card
 * action buttons).
 *
 * Design choices:
 *   - Filter & sort state are local to the webview (via getState/setState),
 *     so switching Activity Bar panels and returning keeps the user's view.
 *   - Account data only includes metadata (no tokens/passwords). Secrets
 *     are decrypted on-demand inside the relevant commands.
 */
export class SidebarProvider {
    ctx;
    static viewId = 'windsurfSwitch.sidebar';
    _view;
    _accounts = [];
    _loading = false;
    _error;
    /**
     * Last "filtered + sorted" account id list reported by the webview.
     * Kept in sync via the `candidateIds` message and used by smart switch
     * to only consider accounts the user is currently looking at.
     */
    _lastCandidateIds = null;
    /**
     * JSON of the last state payload we posted to the webview. Used to
     * suppress duplicate posts so cross-window heartbeat / focus / fs-watcher
     * resyncs don't re-render the UI when nothing actually changed.
     */
    _lastPostedJson = null;
    /**
     * Optional hook invoked after every successful reload() (after postState).
     * Used by extension.ts to keep derived UI (e.g. bottom status bar item)
     * in sync without threading a callback through every command.
     */
    _onDidReload;
    constructor(ctx) {
        this.ctx = ctx;
    }
    /** Subscribe to post-reload notifications. Only one listener allowed. */
    setOnDidReload(cb) {
        this._onDidReload = cb;
    }
    get accounts() {
        return this._accounts;
    }
    findAccount(id) {
        return this._accounts.find(a => a.id === id);
    }
    getLastCandidateIds() {
        return this._lastCandidateIds;
    }
    resolveWebviewView(webviewView) {
        (0, log_1.log)('SidebarProvider.resolveWebviewView invoked');
        this._view = webviewView;
        // A fresh webview instance has no prior state; clear the dedup cache
        // so the very first postState() reaches it (otherwise a cache entry
        // from a previously-disposed view would silently drop the new view's
        // initial render, leaving it blank).
        this._lastPostedJson = null;
        try {
            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: [this.ctx.extensionUri]
            };
            webviewView.webview.html = this.getHtml(webviewView.webview);
            webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
            webviewView.onDidDispose(() => {
                this._view = undefined;
                this._lastPostedJson = null;
            });
            void this.reload();
        }
        catch (e) {
            (0, log_1.log)('resolveWebviewView failed:', e?.stack || e?.message || e);
            webviewView.webview.html = `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:16px;color:#f14c4c">
                <h3>Windsurf Switch Launch Failed</h3>
                <pre style="white-space:pre-wrap">${escapeHtml(String(e?.stack || e?.message || e))}</pre>
            </body></html>`;
        }
    }
    // Concurrent/duplicate calls only trigger one actual disk read, reducing jitter in batch operations.
    _reloadInFlight = null;
    reload() {
        if (this._reloadInFlight) {
            return this._reloadInFlight;
        }
        this._reloadInFlight = this._doReload().finally(() => {
            this._reloadInFlight = null;
        });
        return this._reloadInFlight;
    }
    async _doReload() {
        // Only surface the "loading…" intermediate state on the very first
        // reload (when the webview has nothing to show yet).  Subsequent
        // reloads — triggered by the cross-window heartbeat, file watcher,
        // focus events, etc. — keep the existing content visible and only
        // post the final payload, which postState() will suppress entirely
        // if nothing changed.
        const firstLoad = this._accounts.length === 0 && !this._error;
        this._loading = true;
        this._error = undefined;
        if (firstLoad)
            this.postState();
        try {
            this._accounts = await (0, accountsStore_1.loadManagerAccounts)();
        }
        catch (e) {
            this._error = e?.message || String(e);
            this._accounts = [];
            (0, log_1.log)('SidebarProvider.reload failed:', e?.message || e);
        }
        finally {
            this._loading = false;
            this.postState();
            // Notify extension.ts subscribers (status bar, etc.) AFTER the
            // webview has been updated so they see the freshest accounts list.
            try {
                this._onDidReload?.();
            }
            catch (e) {
                (0, log_1.log)('SidebarProvider._onDidReload threw:', e?.message || e);
            }
        }
    }
    postStatus(text, tone = 'info') {
        this._view?.webview.postMessage({ type: 'status', text, tone });
    }
    /** Generic postMessage for control messages like modal open/close. */
    postMessage(payload) {
        this._view?.webview.postMessage(payload);
    }
    reveal() {
        this._view?.show?.(true);
    }
    /** Tell the webview to open the in-sidebar modal overlay. */
    async openModal(kind, opts) {
        // Make sure the view container is focused and the webview resolved,
        // otherwise postMessage gets dropped (webview not yet created).
        try {
            await vscode.commands.executeCommand('workbench.view.extension.windsurfSwitch');
        }
        catch {
            // ignore; may fail in edge environments
        }
        for (let i = 0; i < 20; i++) {
            if (this._view) {
                break;
            }
            await new Promise(r => setTimeout(r, 50));
        }
        this._view?.show?.(true);
        this._view?.webview.postMessage({ type: 'openModal', kind, opts });
    }
    postModalClose() {
        this._view?.webview.postMessage({ type: 'modalClose' });
    }
    postModalError(text) {
        this._view?.webview.postMessage({ type: 'modalError', text });
    }
    postBatchPreview(count) {
        this._view?.webview.postMessage({ type: 'batchPreview', count });
    }
    /** True iff the sidebar view has been resolved at least once. */
    get isReady() {
        return !!this._view;
    }
    postState() {
        if (!this._view)
            return;
        const gs = this.ctx.globalState;
        const rawHistory = gs.get('wm.smartSwitchHistory', {}) || {};
        const history = (0, smartSwitch_1.pruneHistory)(rawHistory);
        // If prune trimmed entries, persist the cleaned copy back.
        if (Object.keys(history).length !== Object.keys(rawHistory).length) {
            void gs.update('wm.smartSwitchHistory', history);
        }
        const payload = {
            type: 'state',
            loading: this._loading,
            error: this._error,
            accounts: this._accounts.map(serialize),
            currentAccountId: gs.get('wm.currentAccountId', null) || null,
            activeEmail: gs.get('wm.activeEmail', null) || null,
            smartHistory: history,
            auto: {
                polling: {
                    enabled: gs.get(autoSwitch_1.STATE_KEYS.pollingEnabled, false),
                    intervalMs: gs.get(autoSwitch_1.STATE_KEYS.pollingIntervalMs, autoSwitch_1.DEFAULT_POLLING_INTERVAL_MS)
                },
                logWatch: {
                    enabled: gs.get(autoSwitch_1.STATE_KEYS.logWatchEnabled, false),
                    patterns: gs.get(autoSwitch_1.STATE_KEYS.logWatchPatterns, autoSwitch_1.DEFAULT_LOG_PATTERNS)
                },
                lowQuotaThreshold: gs.get(autoSwitch_1.STATE_KEYS.lowQuotaThreshold, autoSwitch_1.DEFAULT_LOW_QUOTA_THRESHOLD),
                lowQuotaThresholdEnabled: gs.get(autoSwitch_1.STATE_KEYS.lowQuotaThresholdEnabled, true)
            },
            ui: {
                sortCollapsed: gs.get(UI_KEYS.sortCollapsed, true),
                filterCollapsed: gs.get(UI_KEYS.filterCollapsed, true)
            }
        };
        // Dedup: if the serialized payload is identical to the last one we
        // sent, do NOT post again — avoids the flicker the user saw when the
        // 30s heartbeat or fs-watcher repeatedly fired sidebar.reload() with
        // unchanged data.
        const json = JSON.stringify(payload);
        if (json === this._lastPostedJson)
            return;
        this._lastPostedJson = json;
        this._view.webview.postMessage(payload);
    }
    /** Force the next postState() to go through even if the payload is identical. */
    invalidatePostCache() {
        this._lastPostedJson = null;
    }
    handleMessage(msg) {
        const cmd = msg?.cmd;
        switch (cmd) {
            case 'reload':
                void this.reload();
                return;
            case 'addAccount':
                // Kept for palette compatibility; sidebar toolbar opens modal locally.
                void vscode.commands.executeCommand('windsurfSwitch.addAccount');
                return;
            case 'addAccountGitHub':
                this.postModalClose();
                void vscode.commands.executeCommand('windsurfSwitch.addAccountGitHub');
                return;
            case 'batchImport':
                void vscode.commands.executeCommand('windsurfSwitch.batchImport');
                return;
            case 'importAccounts':
                void vscode.commands.executeCommand('windsurfSwitch.importAccounts');
                return;
            case 'exportAccounts':
                void vscode.commands.executeCommand('windsurfSwitch.exportAccounts');
                return;
            case 'submitAdd':
                void vscode.commands.executeCommand('windsurfSwitch._submitAddFromModal', { email: msg.email, password: msg.password });
                return;
            case 'submitBatch':
                void vscode.commands.executeCommand('windsurfSwitch._submitBatchFromModal', { text: msg.text });
                return;
            case 'previewBatch': {
                // Quick parse on every keystroke — cheap, pure.
                let count = 0;
                try {
                    count = (0, importParser_1.parseBatch)(String(msg.text || '')).length;
                }
                catch {
                    count = 0;
                }
                this.postBatchPreview(count);
                return;
            }
            case 'refreshAll':
                void vscode.commands.executeCommand('windsurfSwitch.refreshAll');
                return;
            case 'switch':
                if (msg.id) {
                    void vscode.commands.executeCommand('windsurfSwitch.switchAccountById', msg.id);
                }
                return;
            case 'refresh':
                if (msg.id) {
                    void vscode.commands.executeCommand('windsurfSwitch.refreshAccount', msg.id);
                }
                return;
            case 'delete':
                if (msg.id) {
                    void vscode.commands.executeCommand('windsurfSwitch.deleteAccountById', msg.id);
                }
                return;
            case 'credentials':
                // Direct copy "Account+Password". Old showCredentials popup can still be called via command palette.
                if (msg.id) {
                    void this.copyCredentialToClipboard({
                        id: String(msg.id),
                        field: 'both'
                    });
                }
                return;
            case 'editRemark':
                if (msg.id) {
                    void vscode.commands.executeCommand('windsurfSwitch.editRemarkById', msg.id);
                }
                return;
            case 'fixCredentials':
                if (msg.id) {
                    void vscode.commands.executeCommand('windsurfSwitch.fixCredentialsById', msg.id);
                }
                return;
            case 'copyCred':
                if (msg.id && msg.field) {
                    void this.copyCredentialToClipboard({
                        id: String(msg.id),
                        field: String(msg.field)
                    });
                }
                return;
            case 'openAccountsFile':
                void vscode.commands.executeCommand('windsurfSwitch.openAccountsFile');
                return;
            case 'showLog':
                void vscode.commands.executeCommand('windsurfSwitch.showOutput');
                return;
            // --- Smart switch / auto switch ---
            case 'smartSwitch': {
                const ids = Array.isArray(msg.filteredIds)
                    ? msg.filteredIds.map((x) => String(x))
                    : undefined;
                if (ids) {
                    this._lastCandidateIds = ids;
                }
                void vscode.commands.executeCommand('windsurfSwitch._smartSwitchFromSidebar', {
                    filteredIds: ids
                });
                return;
            }
            case 'resetCooldown':
                void vscode.commands.executeCommand('windsurfSwitch.resetSmartCooldown');
                return;
            case 'refreshCurrent': {
                // Let the extension re-probe the Windsurf session first so we
                // don't refresh a stale id when the user already switched away.
                void vscode.commands.executeCommand('windsurfSwitch._refreshCurrentSynced');
                return;
            }
            case 'toggleAuto':
                void vscode.commands.executeCommand('windsurfSwitch._toggleAuto', {
                    kind: msg.kind,
                    enabled: !!msg.enabled
                });
                return;
            case 'setPollingInterval':
                void vscode.commands.executeCommand('windsurfSwitch._setPollingInterval', {
                    intervalMs: Number(msg.intervalMs)
                });
                return;
            case 'setLowQuotaThreshold':
                void vscode.commands.executeCommand('windsurfSwitch._setLowQuotaThreshold', {
                    threshold: Number(msg.threshold)
                });
                return;
            case 'candidateIds': {
                // Webview reports the current filtered+sorted id list any time
                // filters / sort / account set changes.
                if (Array.isArray(msg.ids)) {
                    this._lastCandidateIds = msg.ids.map((x) => String(x));
                }
                return;
            }
            case 'toggleCollapse': {
                const section = String(msg.section || '');
                const collapsed = !!msg.collapsed;
                const key = section === 'sort'
                    ? 'wm.ui.sortCollapsed'
                    : section === 'filter'
                        ? 'wm.ui.filterCollapsed'
                        : null;
                if (key) {
                    void this.ctx.globalState.update(key, collapsed);
                }
                return;
            }
            default:
                (0, log_1.log)('sidebar: unknown message', cmd);
        }
    }
    /**
     * Copy requests are handled inside the provider instead of a globally
     * registered VS Code command, so other extensions cannot invoke the
     * credential-copy path with a guessed account id.
     */
    async copyCredentialToClipboard(args) {
        const accountId = args?.id || '';
        const field = (args?.field || '').toLowerCase();
        if (!accountId || !field) {
            return;
        }
        try {
            // Prefer the in-memory cache (populated on activation + after every
            // add / fix) — avoids spawning PowerShell for DPAPI on every click.
            let email = '';
            let password = '';
            const cached = await (0, memoryCreds_1.getCreds)(accountId);
            if (cached && (cached.email || cached.password)) {
                email = cached.email;
                password = cached.password;
            }
            else {
                const loaded = await (0, accountsStore_1.loadAccountWithSecrets)(accountId);
                if (!loaded) {
                    this.postStatus('Cannot read this account', 'error');
                    return;
                }
                email = loaded.email;
                password = loaded.password;
            }
            if (field === 'email') {
                if (!email) {
                    this.postStatus('Account email is empty', 'warn');
                    return;
                }
                await vscode.env.clipboard.writeText(email);
                this.postStatus(`Copied email ${email}`, 'success');
                return;
            }
            if (field === 'password') {
                if (!password) {
                    this.postStatus('This account has no stored password', 'warn');
                    return;
                }
                await vscode.env.clipboard.writeText(password);
                this.postStatus('Copied password (please paste and clear clipboard soon)', 'success');
                return;
            }
            if (field === 'both') {
                if (!password) {
                    this.postStatus('This account has no stored password', 'warn');
                    return;
                }
                const text = `Account: ${email}    Password: ${password}`;
                await vscode.env.clipboard.writeText(text);
                this.postStatus('Copied Account+Password', 'success');
                return;
            }
            this.postStatus(`Unknown field: ${field}`, 'error');
        }
        catch (e) {
            (0, log_1.log)('copyCredentialToClipboard failed:', e?.message || e);
            this.postStatus(`Copy failed: ${e?.message || e}`, 'error');
        }
    }
    getHtml(webview) {
        const nonce = crypto.randomBytes(16).toString('hex');
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
            `img-src ${webview.cspSource} data:`,
            `font-src ${webview.cspSource}`
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Windsurf Switch</title>
<style>${CSS}</style>
</head>
<body>
    <div id="status-bar" class="status" hidden></div>

    <div class="toolbar">
        <!-- Toolbar three buttons changed to icon-only: + Add / Download Import / Refresh. Tooltips via data-tip below buttons. -->
        <button class="btn-primary act" data-cmd="addAccount" data-tip="Add Account">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3 8h10"/></svg>
        </button>
        <button class="btn act" data-cmd="importAccounts" data-tip="Import Accounts from Bundle (.wssbundle)">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M2.5 13.5h11"/></svg>
        </button>
        <button class="btn act" data-cmd="exportAccounts" data-tip="Export Accounts as Encrypted Bundle (.wssbundle)">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13.5V5M4.5 8.5 8 5l3.5 3.5M2.5 2.5h11"/></svg>
        </button>
        <button class="btn act" data-cmd="refreshAll" data-tip="Refresh All Plan / Quota">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"/></svg>
        </button>
        <!-- Auto Switch entry: outer .dropdown kept, but trigger uses .btn class for consistent visual with other toolbar buttons.
             .dropdown-trigger class retained for generic click handler to manage popup; appearance controlled by more specific .toolbar .btn.dropdown-trigger rule.
             margin-left: auto pushes it to the right. -->
        <div class="dropdown" data-dd="auto">
            <button class="btn dropdown-trigger" type="button" data-dd-trigger="auto" title="Auto Switch Settings">
                <span class="ico auto-ico" aria-hidden="true">
                    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M9 1.5 3 9h4l-1 5.5L13 7H9z"/></svg>
                </span>
                <span>Auto Switch</span>
                <span class="auto-dot" id="auto-dot" hidden></span>
            </button>
            <div class="dropdown-menu auto-menu" id="auto-menu" hidden>
                <div id="auto-options"></div>
            </div>
        </div>
    </div>

    <div class="section-label">Current Account</div>
    <div id="current-account"></div>

    <div class="list-header">
        <div class="count" id="count">—</div>
        <div class="list-header-controls">
            <div class="dropdown" data-dd="sort">
                <button class="dropdown-trigger" type="button" data-dd-trigger="sort">
                    <span class="dropdown-ico">
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3v10M4 3l-2 2M4 3l2 2M11 13V3M11 13l-2-2M11 13l2-2"/></svg>
                    </span>
                    <span class="dropdown-label" id="sort-label">By Expiry ↑</span>
                    <span class="dropdown-caret">▾</span>
                </button>
                <div class="dropdown-menu" id="sort-menu" hidden>
                    <button class="dropdown-option" type="button" data-sort="expiry">By Expiry</button>
                    <button class="dropdown-option" type="button" data-sort="quota">By Quota</button>
                </div>
            </div>
            <div class="dropdown" data-dd="filter">
                <button class="dropdown-trigger" type="button" data-dd-trigger="filter">
                    <span class="dropdown-ico">
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12l-4.5 6v4l-3 1v-5z"/></svg>
                    </span>
                    <span class="dropdown-label" id="filter-label">Filter</span>
                    <span class="dropdown-caret">▾</span>
                </button>
                <div class="dropdown-menu" id="filter-menu" hidden>
                    <label class="dropdown-check"><input type="checkbox" data-filter="trial"/><span>Trial Accounts</span></label>
                    <label class="dropdown-check"><input type="checkbox" data-filter="exclude-no-quota"/><span>Exclude No Quota</span></label>
                    <label class="dropdown-check"><input type="checkbox" data-filter="exclude-today-unavailable"/><span>Exclude Today Unavailable</span></label>
                </div>
            </div>
        </div>
    </div>

    <div id="list"></div>

    <div id="modal-overlay" class="modal-overlay" hidden>
        <div class="modal-card" id="modal-add" hidden>
            <div class="modal-title">Add Account</div>
            <div class="modal-field">
                <label for="modal-add-email">Email</label>
                <input id="modal-add-email" type="email" autocomplete="off" spellcheck="false" />
            </div>
            <div class="modal-field">
                <label for="modal-add-password">Password</label>
                <input id="modal-add-password" type="password" autocomplete="off" spellcheck="false" />
            </div>
            <div class="modal-error" id="modal-add-error" hidden></div>
            <div class="modal-actions">
                <button class="btn" data-modal-cancel type="button">Cancel</button>
                <button class="btn-primary" id="modal-add-submit" type="button">Add</button>
            </div>
            <div class="modal-divider"><span>or</span></div>
            <button class="btn-github" id="modal-add-github" type="button">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13"/><path d="M8 1.5c2 2 3 4.5 3 6.5s-1 4.5-3 6.5c-2-2-3-4.5-3-6.5s1-4.5 3-6.5z"/></svg>
                Sign in via Browser
            </button>
        </div>
        <div class="modal-card" id="modal-creds" hidden>
            <div class="modal-title">Account Credentials · <span id="modal-creds-email"></span></div>
            <div class="modal-creds-actions">
                <button class="btn" data-creds-copy="email" type="button">Copy Email</button>
                <button class="btn" data-creds-copy="password" type="button">Copy Password</button>
                <button class="btn-primary" data-creds-copy="both" type="button">Copy Account:xxx Password:yyy</button>
                <button class="btn" data-creds-copy="remark" type="button">Edit Remark</button>
            </div>
            <div class="modal-hint" id="modal-creds-hint">Click button to copy content to clipboard.</div>
            <div class="modal-actions">
                <button class="btn" data-modal-cancel type="button">Close</button>
            </div>
        </div>
        <div class="modal-card" id="modal-batch" hidden>
            <div class="modal-title">Batch Import</div>
            <div class="modal-hint">
                One account per line, any of the following formats are recognized, and can be mixed:

                <div class="modal-format-group">
                    <div class="modal-format-title">① Delimiter format</div>
                    <div class="modal-format-desc">Email and password separated by any of the following: <code>:</code> <code>,</code> <code>|</code> <code>;</code> <code>----</code> <code>@@</code> or space / Tab</div>
                    <pre class="modal-format-example">user@example.com:Pass123
bob@mail.com  Qwerty456
carol@foo.io|MyP@ss</pre>
                </div>

                <div class="modal-format-group">
                    <div class="modal-format-title">② Tag format (Chinese/English colon, single/multi-line)</div>
                    <div class="modal-format-desc">"Account / Email" and "Password" as field names; same line separated by space/comma also recognized.</div>
                    <pre class="modal-format-example">Email: dave@x.com
Password: 88Dave88
                                    </div>

                <div class="modal-format-group">
                    <div class="modal-format-title">③ Structured (CSV / URL params / JSON)</div>
                    <pre class="modal-format-example">email,password
email=dave@x.com&amp;password=88Dave88
[{"email":"a@x.com","password":"p"}]
[{"email":"browser-user","idToken":"devin-session-token$..."}]</pre>
                </div>

                <div class="modal-format-hint-tail">After pasting, "Found N accounts" will show below. Verify before clicking Import. Duplicate emails will be skipped.</div>
            </div>
            <textarea id="modal-batch-text" rows="10" spellcheck="false" placeholder="Paste account list..."></textarea>
            <div class="modal-preview" id="modal-batch-preview">Found 0 accounts</div>
            <div class="modal-actions">
                <button class="btn" data-modal-cancel type="button">Cancel</button>
                <button class="btn-primary" id="modal-batch-submit" type="button" disabled>Start Import</button>
            </div>
        </div>
    </div>

<script nonce="${nonce}">${JS}</script>
</body>
</html>`;
    }
}
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
// ---------------------------------------------------------------------------
// account serialization sent to the webview
// ---------------------------------------------------------------------------
function serialize(a) {
    return {
        id: a.id,
        email: a.email,
        displayName: a.displayName,
        authProvider: a.authProvider,
        planName: a.planName,
        dailyRemainPct: a.dailyRemainPct,
        weeklyRemainPct: a.weeklyRemainPct,
        dailyResetUnix: a.dailyResetUnix,
        weeklyResetUnix: a.weeklyResetUnix,
        expiresAt: a.expiresAt,
        gracePeriodStatus: a.gracePeriodStatus,
        lastQueryTime: a.lastQueryTime,
        quotaError: a.quotaError,
        remark: a.remark,
        hasCredentials: a.hasCredentials
    };
}
// ---------------------------------------------------------------------------
// CSS - uses VS Code theme variables so it matches light / dark / HC themes.
// ---------------------------------------------------------------------------
const CSS = /* css */ `
/* ===========================================================================
 * Design tokens — single source of truth for spacing / radius / shadow /
 * motion. All values are theme-adaptive via VSCode CSS variables.
 * ========================================================================= */
:root {
  /* Surfaces */
  --card-bg: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
  --card-bg-hover: color-mix(in srgb, var(--vscode-foreground) 4%, var(--card-bg));
  --card-border: var(--vscode-panel-border, rgba(128,128,128,0.28));
  --card-border-hover: color-mix(in srgb, var(--vscode-focusBorder) 50%, var(--card-border));
  --muted: var(--vscode-descriptionForeground);

  /* Semantic */
  --danger: var(--vscode-errorForeground, #f14c4c);
  --success: var(--vscode-testing-iconPassed, #3fb950);
  --warn: var(--vscode-editorWarning-foreground, #cca700);
  --accent: var(--vscode-focusBorder, #007acc);
  --accent-bg: var(--vscode-button-background);
  --accent-fg: var(--vscode-button-foreground);
  --accent-hover: var(--vscode-button-hoverBackground);
  --accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);
  --accent-soft-strong: color-mix(in srgb, var(--accent) 22%, transparent);

  --neutral-bg: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
  --neutral-fg: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  --neutral-hover: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25));

  /* Spacing scale (4-pt grid) */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px;

  /* Radius scale */
  --r-sm: 4px; --r-md: 6px; --r-lg: 10px; --r-pill: 999px;

  /* Type scale */
  --fs-xs: 10.5px; --fs-sm: 11.5px; --fs-md: 12.5px; --fs-lg: 13.5px;

  /* Elevation — subtle, theme-friendly */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.18);
  --shadow-md: 0 2px 6px rgba(0,0,0,0.22);
  --shadow-lg: 0 8px 24px rgba(0,0,0,0.40);

  /* Motion */
  --ease: cubic-bezier(0.2, 0, 0, 1);
  --dur-fast: 120ms;
  --dur-base: 180ms;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
}
body {
  padding: var(--sp-2) var(--sp-2) var(--sp-4) var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  border-radius: var(--r-sm);
}

/* ===========================================================================
 * Toolbar
 * ========================================================================= */
.toolbar {
  display: flex;
  gap: var(--sp-1);
  flex-wrap: nowrap; /* All buttons stay on one line, text shrinks rather than wraps when space is tight */
  align-items: center;
  padding: 2px 0 var(--sp-2) 0;
  border-bottom: 1px solid var(--card-border);
  position: relative; /* Grant local stacking, don't add overflow: hidden,
                         otherwise .dropdown-menu will be clipped when opened. Button's own
                         overflow: hidden handles text ellipsis. */
  z-index: 5; /* Ensure dropdown popup stays above #current-account card below */
}

/* Toolbar button adaptation:
   - Regular .btn / .btn-primary: shrink when needed (text ellipsis).
   - Auto switch button: not shrunk, margin-left: auto pushes it to the right. */
.toolbar > .btn,
.toolbar > .btn-primary {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* icon-only (.act) buttons must have overflow: visible, otherwise ::after pseudo-element (tooltip)
   will be clipped by button's own overflow: hidden, hiding hover hints. */
.toolbar > .btn.act,
.toolbar > .btn-primary.act {
  overflow: visible;
}
.toolbar > .dropdown {
  flex: 0 0 auto;
  margin-left: auto;
}
/* Toolbar icon button tooltips show below buttons (buttons at top, no space above) */
.toolbar .act[data-tip]::after {
  bottom: auto;
  top: calc(100% + 6px);
  transform: translateX(-50%) translateY(-2px);
}
.toolbar .act[data-tip]:hover::after {
  transform: translateX(-50%) translateY(0);
}
/* First button tooltip left-aligned (avoid being clipped by sidebar left edge) */
.toolbar .act[data-tip]:first-child::after {
  left: 0;
  transform: translateY(-2px);
}
.toolbar .act[data-tip]:first-child:hover::after {
  transform: translateY(0);
}
/* Raise z-index when popup opens, ensure it floats above all cards */
.toolbar > .dropdown.open {
  z-index: 60;
}
.toolbar .dropdown-menu {
  z-index: 60;
}

/* ===========================================================================
 * Buttons — micro-interactions: subtle lift on hover, press on active
 * ========================================================================= */
.btn, .btn-primary, .btn-icon, .btn-danger {
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  padding: 4px 10px;
  cursor: pointer;
  font-size: var(--fs-md);
  line-height: 1.4;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-family: inherit;
  font-weight: 500;
  transition: background var(--dur-fast) var(--ease),
              border-color var(--dur-fast) var(--ease),
              transform var(--dur-fast) var(--ease),
              box-shadow var(--dur-fast) var(--ease);
}
.btn-primary {
  background: var(--accent-bg);
  color: var(--accent-fg);
  box-shadow: var(--shadow-sm);
}
.btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); box-shadow: var(--shadow-md); }
.btn-primary:active { transform: translateY(0); box-shadow: var(--shadow-sm); }
.btn {
  background: var(--neutral-bg);
  color: var(--neutral-fg);
}
.btn:hover { background: var(--neutral-hover); }
.btn:active { transform: translateY(1px); }
.btn-icon {
  background: transparent;
  color: var(--vscode-foreground);
  padding: 4px 6px;
  font-size: 14px;
  border-radius: var(--r-sm);
}
.btn-icon:hover { background: var(--neutral-hover); }
.btn-danger {
  background: transparent;
  color: var(--danger);
  border-color: var(--danger);
}
.btn-danger:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); }
.btn-primary:disabled, .btn:disabled, .btn-icon:disabled, .btn-danger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none !important;
  box-shadow: none !important;
}
.ico { font-weight: bold; }

/* ===========================================================================
 * Section labels — quieter, more refined
 * ========================================================================= */
.section-label {
  font-size: var(--fs-xs);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
  margin-top: var(--sp-1);
  padding-left: 2px;
}

/* ===========================================================================
 * Chips — filled style, active uses accent gradient
 * ========================================================================= */
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
}
.chip {
  border: 1px solid var(--card-border);
  background: var(--neutral-bg);
  color: var(--vscode-foreground);
  padding: 3px 10px;
  border-radius: var(--r-pill);
  cursor: pointer;
  font-size: var(--fs-sm);
  line-height: 1.5;
  font-family: inherit;
  transition: background var(--dur-fast) var(--ease),
              border-color var(--dur-fast) var(--ease),
              color var(--dur-fast) var(--ease);
}
.chip:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.chip.active {
  background: linear-gradient(180deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 80%, black) 100%);
  border-color: transparent;
  color: var(--accent-fg);
  box-shadow: var(--shadow-sm);
}
.chip-sort { font-weight: 600; }

.count {
  font-size: var(--fs-sm);
  color: var(--muted);
  padding: 0 2px;
}

/* ===========================================================================
 * Account list & cards
 * ========================================================================= */
#list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--r-lg);
  padding: var(--sp-3) var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  transition: border-color var(--dur-base) var(--ease),
              background var(--dur-base) var(--ease),
              transform var(--dur-fast) var(--ease),
              box-shadow var(--dur-base) var(--ease);
}
.card:hover {
  border-color: var(--card-border-hover);
  background: var(--card-bg-hover);
  box-shadow: var(--shadow-sm);
}
.card-head {
  display: flex;
  gap: var(--sp-2);
  align-items: flex-start;
}
.card-title { flex: 1; min-width: 0; }
.email {
  font-weight: 600;
  font-size: var(--fs-lg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.005em;
}
.sub {
  font-size: var(--fs-sm);
  color: var(--muted);
  margin-top: 2px;
}
.remark {
  display: inline-block;
  margin-top: var(--sp-1);
  padding: 1px 8px;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  font-weight: 600;
  background: var(--accent-soft);
  color: var(--accent);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.remark:hover { background: var(--accent-soft-strong); }

/* ===========================================================================
 * Plan badge — high-contrast pill
 * ========================================================================= */
.plan-badge {
  padding: 2px 8px;
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  font-weight: 700;
  background: var(--neutral-bg);
  color: var(--neutral-fg);
  white-space: nowrap;
  flex-shrink: 0;
  letter-spacing: 0.02em;
}
.plan-pro, .plan-teams {
  background: linear-gradient(180deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 78%, black) 100%);
  color: var(--accent-fg);
  box-shadow: var(--shadow-sm);
}
.plan-trial {
  background: color-mix(in srgb, var(--warn) 22%, transparent);
  color: var(--warn);
}
.plan-free { background: var(--neutral-bg); }

/* ===========================================================================
 * Quota progress bars — beefier with inner shadow + state gradients
 * ========================================================================= */
.quota-row {
  display: grid;
  grid-template-columns: 40px 1fr 40px;
  align-items: center;
  gap: var(--sp-2);
}
.quota-row + .quota-row { margin-top: var(--sp-1); }
.quota-label {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--muted);
}
.progress {
  height: 7px;
  background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
  border-radius: var(--r-pill);
  overflow: hidden;
  box-shadow: inset 0 1px 1px rgba(0,0,0,0.16);
}
.progress > .bar {
  height: 100%;
  background: linear-gradient(90deg, var(--success), color-mix(in srgb, var(--success) 70%, white));
  border-radius: var(--r-pill);
  transition: width 240ms var(--ease);
}
.bar.low {
  background: linear-gradient(90deg, var(--warn), color-mix(in srgb, var(--warn) 75%, white));
}
.bar.crit {
  background: linear-gradient(90deg, var(--danger), color-mix(in srgb, var(--danger) 75%, white));
}
.quota-value {
  font-size: var(--fs-sm);
  font-weight: 600;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
/* "Time to next reset" row, aligned with progress bar left edge (skip label column + gap) */
.quota-reset {
  font-size: var(--fs-xs);
  color: var(--muted);
  text-align: left;
  font-variant-numeric: tabular-nums;
  padding-left: 48px;   /* 40px label column + 8px gap = progress start */
  margin-top: -2px;
  margin-bottom: 2px;
  letter-spacing: 0.01em;
}

/* ===========================================================================
 * Card footer / expiry / sync badges
 * ========================================================================= */
.card-foot {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.expiry-desc {
  font-size: var(--fs-sm);
  font-weight: 600;
}
.expiry-desc.danger { color: var(--danger); }
.expiry-desc.warn { color: var(--warn); }
.expiry-desc.ok { color: var(--success); }
.expiry-desc.muted { color: var(--muted); }
.sync-hint {
  font-size: var(--fs-xs);
  color: var(--warn);
  font-weight: 600;
}
.expiry-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  justify-content: space-between;
}
.sync-badge {
  font-size: var(--fs-xs);
  font-weight: 600;
  padding: 1px 8px;
  border-radius: var(--r-pill);
  flex-shrink: 0;
  letter-spacing: 0.02em;
}
.sync-badge.ok {
  color: var(--success);
  border: 1px solid color-mix(in srgb, var(--success) 60%, transparent);
  background: color-mix(in srgb, var(--success) 10%, transparent);
}
.sync-badge.stale {
  color: var(--warn);
  border: 1px solid color-mix(in srgb, var(--warn) 60%, transparent);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
}

.card-actions {
  display: flex;
  gap: var(--sp-1);
  flex-wrap: wrap;
  justify-content: flex-end;
}
.card-actions .btn, .card-actions .btn-primary, .card-actions .btn-danger {
  padding: 4px 10px;
  font-size: var(--fs-sm);
}

/* Square icon-only action button (.act modifier on .btn / .btn-primary / .btn-danger) */
.btn.act, .btn-primary.act, .btn-danger.act {
  width: 30px;
  height: 28px;
  padding: 0;
  justify-content: center;
  align-items: center;
  border-radius: var(--r-sm);
  position: relative;
}
.btn.act svg, .btn-primary.act svg, .btn-danger.act svg {
  display: block;
  flex-shrink: 0;
}
.btn-primary.act { box-shadow: var(--shadow-sm); }
.btn-primary.act:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); }
.btn-primary.act:active { transform: translateY(0); }
.btn.act { color: var(--vscode-foreground); opacity: 0.85; }
.btn.act:hover { opacity: 1; }
.btn-danger.act { opacity: 0.85; }
.btn-danger.act:hover { opacity: 1; }

/* Custom tooltip — hover a button with [data-tip] and get an instant, themed
 * popover above it. Much snappier than the native title tooltip on webview. */
.act[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%) translateY(2px);
  background: var(--vscode-editorHoverWidget-background, var(--card-bg));
  color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--card-border));
  padding: 4px 8px;
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  box-shadow: var(--shadow-md);
  z-index: 100;
  transition: opacity var(--dur-fast) var(--ease),
              transform var(--dur-fast) var(--ease);
}
.act[data-tip]:hover::after {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
  transition-delay: 120ms;
}
/* Last buttons in a row would have their tooltip clipped by the sidebar's
 * right edge; nudge them to align to the right instead of center. */
.card-actions .act[data-tip]:last-child::after,
.card-actions .act[data-tip]:nth-last-child(2)::after {
  left: auto;
  right: 0;
  transform: translateY(2px);
}
.card-actions .act[data-tip]:last-child:hover::after,
.card-actions .act[data-tip]:nth-last-child(2):hover::after {
  transform: translateY(0);
}

/* ===========================================================================
 * Empty / loading states — friendlier
 * ========================================================================= */
.empty {
  padding: var(--sp-6) var(--sp-4);
  text-align: center;
  color: var(--muted);
  font-size: var(--fs-md);
  border: 1px dashed var(--card-border);
  border-radius: var(--r-lg);
  background: color-mix(in srgb, var(--card-bg) 60%, transparent);
}
.empty .cta {
  display: inline-block;
  margin-top: var(--sp-2);
  padding: 6px 14px;
  border-radius: var(--r-sm);
  background: var(--accent-bg);
  color: var(--accent-fg);
  cursor: pointer;
  font-weight: 600;
  transition: background var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
}
.empty .cta:hover { background: var(--accent-hover); transform: translateY(-1px); }

/* ===========================================================================
 * Status sticky bar — clear separation from list
 * ========================================================================= */
.status {
  position: sticky;
  top: 0;
  padding: 6px var(--sp-2);
  font-size: var(--fs-sm);
  border-radius: var(--r-md);
  border: 1px solid var(--card-border);
  background: var(--card-bg);
  box-shadow: var(--shadow-md);
  backdrop-filter: blur(6px);
  z-index: 10;
}
.status.info { color: var(--muted); }
.status.success { color: var(--success); border-color: color-mix(in srgb, var(--success) 60%, transparent); }
.status.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 60%, transparent); }
.status.error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 60%, transparent); }
.loading-dot::after {
  content: ' …';
  animation: blink 1.2s var(--ease) infinite;
}
@keyframes blink { 50% { opacity: 0.3; } }

/* ===========================================================================
 * Modal overlay (add account / batch import / show credentials)
 * — Backdrop blur (where supported), elevated card with smooth entrance.
 * HTML [hidden] must beat .modal-overlay{display:flex} / .modal-card{display:flex}
 * ========================================================================= */
[hidden] { display: none !important; }
.modal-overlay {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, black 55%, transparent);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: var(--sp-5) var(--sp-2);
  z-index: 50;
  overflow-y: auto;
  animation: overlay-in var(--dur-base) var(--ease);
}
@keyframes overlay-in { from { opacity: 0; } to { opacity: 1; } }
.modal-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--r-lg);
  padding: var(--sp-3) var(--sp-3);
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  box-shadow: var(--shadow-lg);
  animation: card-in var(--dur-base) var(--ease);
}
@keyframes card-in {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: translateY(0); }
}
.modal-title {
  font-weight: 700;
  font-size: var(--fs-lg);
  padding-bottom: var(--sp-1);
  border-bottom: 1px solid var(--card-border);
  letter-spacing: -0.005em;
}
.modal-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.modal-field label {
  font-size: var(--fs-sm);
  color: var(--muted);
  font-weight: 500;
}
.modal-field input,
.modal-card textarea {
  font-family: inherit;
  font-size: var(--fs-md);
  padding: 6px 9px;
  border: 1px solid var(--vscode-input-border, var(--card-border));
  border-radius: var(--r-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  outline: none;
  transition: border-color var(--dur-fast) var(--ease),
              box-shadow var(--dur-fast) var(--ease);
}
.modal-field input:focus,
.modal-card textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.modal-card textarea {
  resize: vertical;
  min-height: 140px;
  font-family: var(--vscode-editor-font-family, monospace);
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-1);
  padding-top: var(--sp-1);
}
.modal-error {
  color: var(--danger);
  font-size: var(--fs-sm);
  word-break: break-word;
  padding: 6px 8px;
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
}
.modal-divider {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  margin: var(--sp-1) 0 calc(var(--sp-1) - 2px);
  color: var(--muted);
  font-size: var(--fs-xs);
}
.modal-divider::before,
.modal-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--card-border);
}
.btn-github {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  padding: 7px 12px;
  font-size: var(--fs-md);
  font-family: inherit;
  border-radius: var(--r-sm);
  border: 1px solid var(--card-border);
  background: var(--neutral-bg);
  color: var(--neutral-fg);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease),
              border-color var(--dur-fast) var(--ease),
              transform var(--dur-fast) var(--ease);
}
.btn-github:hover {
  background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
  border-color: color-mix(in srgb, var(--vscode-foreground) 30%, transparent);
  transform: translateY(-1px);
}
.btn-github:active { transform: translateY(0); }
.btn-github:disabled { opacity: 0.5; cursor: not-allowed; transform: none !important; }
.modal-hint {
  font-size: var(--fs-sm);
  color: var(--muted);
  line-height: 1.55;
}
.modal-hint code {
  background: var(--neutral-bg);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: var(--fs-xs);
  font-family: var(--vscode-editor-font-family, monospace);
}
.modal-format-group {
  margin-top: 10px;
}
.modal-format-title {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--vscode-foreground);
  margin-bottom: 4px;
}
.modal-format-desc {
  font-size: var(--fs-xs);
  color: var(--muted);
  margin-bottom: 4px;
  line-height: 1.5;
}
.modal-format-example {
  margin: 0;
  padding: 6px 9px;
  background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
  font-size: var(--fs-xs);
  line-height: 1.55;
  color: var(--vscode-foreground);
  white-space: pre-wrap;
  word-break: break-all;
  overflow-x: auto;
}
.modal-format-hint-tail {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--card-border);
  font-size: var(--fs-xs);
  color: var(--muted);
}
.modal-preview {
  font-size: var(--fs-sm);
  color: var(--muted);
  font-weight: 600;
}
.modal-preview.has {
  color: var(--success);
}
.modal-creds-actions {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.modal-creds-actions .btn,
.modal-creds-actions .btn-primary {
  justify-content: center;
  padding: 7px 12px;
  font-size: var(--fs-md);
}

/* ===========================================================================
 * Top-level collapsible section header
 *   • caret: pure character swap, NO rotation animation (avoids the off-axis
 *     rotation glitch that misaligns the glyph against the label).
 * ========================================================================= */
.section-head {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-1) var(--sp-1) var(--sp-1);
  cursor: pointer;
  user-select: none;
  border-radius: var(--r-sm);
  transition: background var(--dur-fast) var(--ease);
}
.section-head:hover { background: var(--neutral-bg); }
.section-head .section-label {
  margin-top: 0;
  font-size: var(--fs-xs);
  font-weight: 700;
  color: var(--vscode-foreground);
  opacity: 0.78;
}
.section-head .caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  font-size: 9px;
  line-height: 1;
  color: var(--muted);
}
.section-head .caret::before { content: '▾'; }
.section-head.collapsed .caret::before { content: '▸'; }
.section-body.collapsed {
  display: none;
}

/* ===========================================================================
 * Current account — visually elevated above the list
 * ========================================================================= */
#current-account {
  margin-bottom: var(--sp-2);
}
#current-account .card {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--card-border));
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--accent) 6%, var(--card-bg)) 0%,
    var(--card-bg) 100%);
  box-shadow: var(--shadow-sm);
}
#current-account .card:hover {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--card-border));
  box-shadow: var(--shadow-md);
}
#current-account .card.placeholder {
  opacity: 0.7;
  background: var(--card-bg);
 /* Auto-switch — panel content row / label / select / hint styles.
 * Panel outer container (.auto-menu) in Toolbar dropdown section below.
 * ========================================================================= */
.auto-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-md);
  flex-wrap: wrap;
  padding: 2px var(--sp-1);
}
.auto-row label {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  cursor: pointer;
}
.auto-row input[type="checkbox"] {
  accent-color: var(--accent);
}
.auto-row select {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  padding: 3px 8px;
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease);
}
.auto-row select:hover { border-color: var(--accent); }
.auto-row select:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 2px var(--accent-soft); }
.auto-hint {
  font-size: var(--fs-xs);
  color: var(--muted);
  padding-left: 18px;
  opacity: 0.85;
}
/* Auto switch dropdown panel: wide enough for longest label ("Monitor logs for instant switch" ~24 chars) + select */
.auto-menu {
  min-width: 230px;
  max-width: 280px;
  padding: 6px;
}
.auto-menu .auto-row {
  padding: 4px 6px;
  flex-wrap: nowrap; /* Ensure checkbox + label + select fit on one line */
  gap: 8px;
}
/* Label adaptive width, but text never wraps */
.auto-menu .auto-row label {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
}
.auto-menu .auto-row label span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Select fixed width, prevents expanding with content and compressing label */
.auto-menu .auto-row select {
  flex: 0 0 auto;
  width: 82px;
}
/* Threshold number input + % suffix combo container, same width as other selects */
.auto-menu .auto-row .threshold-input {
  flex: 0 0 auto;
  width: 82px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.auto-menu .auto-row input[data-auto-threshold] {
  flex: 1 1 auto;
  min-width: 0;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  padding: 3px 6px;
  font-size: var(--fs-sm);
  font-family: inherit;
  text-align: right;
  transition: border-color var(--dur-fast) var(--ease);
}
.auto-menu .auto-row input[data-auto-threshold]:hover {
  border-color: var(--accent);
}
.auto-menu .auto-row input[data-auto-threshold]:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.auto-menu .auto-row input[data-auto-threshold]:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.auto-menu .auto-row .threshold-suffix {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: var(--fs-sm);
  pointer-events: none;
}

/* ---- Toolbar .btn.dropdown-trigger —— apply .btn solid style, not chip outline --- */
/* Override .dropdown-trigger default with higher specificity for toolbar button consistency. */
.toolbar .btn.dropdown-trigger {
  /* Reset to .btn style (same as "Batch Import" "Refresh All") */
  background: var(--neutral-bg);
  color: var(--neutral-fg);
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  padding: 4px 10px;
  font-size: var(--fs-md);
  font-weight: 500;
  line-height: 1.4;
  gap: var(--sp-1);
  white-space: nowrap;
}
.toolbar .btn.dropdown-trigger:hover {
  background: var(--neutral-hover);
  border-color: transparent;
  transform: none;
}
.toolbar .btn.dropdown-trigger:active {
  transform: translateY(1px);
}
/* When panel opens —— "hover" pressed down feel */
.toolbar .dropdown.open .btn.dropdown-trigger {
  background: var(--neutral-hover);
  border-color: transparent;
}
/* Active state —— icon turns accent color, text and button stay neutral (not flashy) */
.toolbar .btn.dropdown-trigger.active .auto-ico {
  color: var(--accent);
}
/* Left icon fixed style */
.auto-ico {
  display: inline-flex;
  align-items: center;
  color: var(--neutral-fg);
  opacity: 0.9;
  transition: color var(--dur-fast) var(--ease);
}
/* Suffix dot: indicates "auto switch is on". No number badge, more subtle. */
.auto-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  margin-left: 2px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent);
}

/* ===========================================================================
 * List header — count + sort/filter dropdowns on the same row.
 * ========================================================================= */
.list-header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-1) var(--sp-1) var(--sp-1);
}
.list-header .count { flex: 0 0 auto; margin: 0; padding: 0; }
.list-header-controls {
  flex: 1 1 auto;
  display: flex;
  gap: var(--sp-1);
  justify-content: flex-end;
  flex-wrap: wrap;
}

/* ---- Generic dropdown (trigger + floating menu) ------------------------- */
.dropdown { position: relative; }
.dropdown-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 8px;
  background: var(--card-bg);
  color: var(--vscode-foreground);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  font-size: var(--fs-xs);
  font-family: inherit;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
  white-space: nowrap;
  user-select: none;
}
.dropdown-trigger:hover { background: var(--neutral-bg); border-color: var(--accent); }
.dropdown-trigger.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--card-bg)); }
.dropdown-ico { display: inline-flex; opacity: 0.75; }
.dropdown-ico svg { display: block; }
.dropdown-label { font-weight: 500; }
.dropdown-caret {
  font-size: 10px;
  opacity: 0.65;
  transition: transform var(--dur-fast) var(--ease);
}
.dropdown.open .dropdown-caret { transform: rotate(180deg); }
.dropdown-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  margin-left: 2px;
  background: var(--accent);
  color: white;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}
.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 160px;
  max-width: 240px;
  padding: 4px;
  background: var(--vscode-editorHoverWidget-background, var(--card-bg));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--card-border));
  border-radius: var(--r-md);
  box-shadow: var(--shadow-lg, var(--shadow-md));
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 1px;
  animation: dd-in var(--dur-fast) var(--ease);
}
@keyframes dd-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.dropdown-option,
.dropdown-check {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: transparent;
  color: var(--vscode-foreground);
  border: 0;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  user-select: none;
}
.dropdown-option:hover,
.dropdown-check:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.dropdown-option.active {
  color: var(--accent);
  font-weight: 600;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.dropdown-option.active::before {
  content: '✓';
  margin-right: 2px;
  font-size: 11px;
}
.dropdown-check input[type="checkbox"] {
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}
.dropdown-check span { flex: 1 1 auto; }

/* ===========================================================================
 * Scrollbar (webview lives in webkit) — slimmer, theme-aware
 * ========================================================================= */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
  border-radius: var(--r-pill);
}
::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--vscode-foreground) 32%, transparent);
}

/* ===========================================================================
 * Reduced motion — respect user accessibility preference
 * ========================================================================= */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
`;
// ---------------------------------------------------------------------------
// JS - rendered inside the webview, talks back via acquireVsCodeApi()
// ---------------------------------------------------------------------------
const JS = /* javascript */ `
(function () {
    const vscode = acquireVsCodeApi();
    const prev = vscode.getState() || {};

    const state = {
        loading: true,
        accounts: [],
        error: undefined,
        sort: prev.sort || { mode: 'expiry', dir: 'asc' },
        // Only Trial include remains; Yahoo/Free/Grace chips were removed.
        // Old persisted state may still have those keys — harmless, we just
        // ignore them in passesFilter.
        filters: (() => {
            const merged = Object.assign({
                trial: false,
                'exclude-no-quota': false,
                'exclude-today-unavailable': false
            }, prev.filters || {});
            // Filters whose UI was removed → force off so users aren’t left with
            // a hidden filter quietly hiding accounts.
            merged['exclude-yahoo'] = false;
            merged['exclude-free'] = false;
            return merged;
        })(),
        currentAccountId: null,
        activeEmail: null,
        smartHistory: {},
        auto: {
            polling: { enabled: false, intervalMs: 120000 },
            logWatch: { enabled: false, patterns: [] }
        },
        ui: {
            sortCollapsed: true,
            filterCollapsed: true
        }
    };

    // ---- inline SVG icons (currentColor → theme-friendly) -----------------
    const ICONS = {
        // arrow-swap (switch to this account)
        switch: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5h10.5M11 3l2 2-2 2M13.5 11H3M5 9l-2 2 2 2"/></svg>',
        // zap / lightning (smart switch)
        smartSwitch: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M9.2 1L3 9h4l-1 6 6.2-8H8l1.2-6z"/></svg>',
        // refresh
        refresh: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"/></svg>',
        // clock with back arrow (reset cooldown)
        resetCooldown: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8.5" r="5.2"/><path d="M8 5.5V8.5l2 1.3"/><path d="M3.4 5h2.5M3.4 5V2.5"/></svg>',
        // wrench (fix credentials)
        fixCredentials: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M11.6 1.5a3.5 3.5 0 0 0-3.4 4.4L1.6 12.5l1.9 1.9 6.6-6.6a3.5 3.5 0 1 0 1.5-6.3zm0 5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>',
        // key (show credentials)
        credentials: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="10.5" r="2.7"/><path d="M7.5 8.5l5.5-5.5M11 7l2-2M13 5l1-1"/></svg>',
        // tag (edit remark)
        editRemark: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2 8.5V2.5h6l6 6-6 6-6-6z"/><circle cx="5" cy="5.5" r="1" fill="currentColor" stroke="none"/></svg>',
        // trash (delete)
        delete: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M6 4V2.5h4V4M5 4l.7 9.5h4.6L11 4M7 7v4M9 7v4"/></svg>'
    };

    const $ = sel => document.querySelector(sel);
    const listEl = $('#list');
    const countEl = $('#count');
    const statusEl = $('#status-bar');
    const currentEl = $('#current-account');

    /** Set when the user clicks "Refresh" on a specific card, so the next render
     *  scrolls that card back into view.  Other renders simply restore the
     *  previous scrollTop (no jump-to-top behaviour).
     */
    let scrollToIdAfterRender = null;

    function persist() {
        vscode.setState({ sort: state.sort, filters: state.filters });
    }

    function post(cmd, extra) {
        vscode.postMessage(Object.assign({ cmd }, extra || {}));
    }

    // ---------- classification helpers ------------------------------------
    // yahoo.com / yahoo.co.jp / yahoo.com.tw / yahoo.co.uk etc. all count as Yahoo
    function isYahoo(a) { return /@yahoo\.[a-z.]+$/i.test(a.email || ''); }
    function isFree(a) { return (a.planName || '').toLowerCase() === 'free'; }
    function isTrial(a) { return (a.planName || '').toLowerCase() === 'trial'; }
    function hasDailyQuota(a) { return (a.dailyRemainPct || 0) > 0; }
    function hasWeeklyQuota(a) { return (a.weeklyRemainPct || 0) > 0; }
    function parseExpiry(a) {
        // Free accounts have no real subscription expiry —— Windsurf plan API returns
        // planEnd as next monthly billing cycle reset (~30 days later), treating it as
        // "expiry time" would wrongly show "expires in 30 days". Most obvious when
        // trial ends and downgrades to Free. Always return null: sinks in sorting,
        // fmtExpiry goes to dedicated "Free" branch. Trial / Pro / Teams unaffected.
        if (isFree(a)) return null;
        if (!a.expiresAt) return null;
        const t = Date.parse(a.expiresAt);
        return Number.isFinite(t) ? t : null;
    }
    function isGracePeriod(a) {
        // Priority to backend gracePeriodStatus, fallback to date calculation.
        const s = (a.gracePeriodStatus || '').toLowerCase();
        if (s && s !== 'none' && s !== 'inactive' && s !== 'n/a') {
            return true;
        }
        const exp = parseExpiry(a);
        if (!exp) return false;
        if (exp - Date.now() > 0) return false;
        // fallback: expired < 30 days counted as grace period
        return (Date.now() - exp) < 30 * 24 * 3600e3;
    }
    // ---------- quota score ------------------------------------------------
    // Windsurf rules: daily resets 16:00; weekly resets Sun 16:00.
    //   - daily == 0 → today unusable
    //   - weekly == 0 → whole week locked
    //   - So "usable today" = min(daily, weekly).
    // When query fails (quotaError=true) still use historical data, UI shows "not synced" badge.
    // Only accounts never queried (both fields null) get -1 to sink.
    function quotaScore(a) {
        if (a.dailyRemainPct == null && a.weeklyRemainPct == null) return -1;
        return Math.min(a.dailyRemainPct || 0, a.weeklyRemainPct || 0);
    }

    // ---------- filter / sort ---------------------------------------------
    function passesFilter(a) {
        const f = state.filters;
        // Trial is the only remaining include chip
        if (f.trial && !isTrial(a)) return false;
        // Never-queried accounts (daily & weekly both null) not excluded by quota filters,
        // prevents newly imported / created accounts from being wrongly filtered.
        const neverQueried = a.dailyRemainPct == null && a.weeklyRemainPct == null;
        if (f['exclude-yahoo'] && isYahoo(a)) return false;
        if (f['exclude-no-quota'] && !neverQueried && !hasWeeklyQuota(a)) return false;
        if (f['exclude-free'] && isFree(a)) return false;
        if (f['exclude-today-unavailable'] && !neverQueried && (!hasDailyQuota(a) || !hasWeeklyQuota(a))) return false;
        return true;
    }
    function sortAccounts(list) {
        const mode = state.sort.mode;
        const asc = state.sort.dir === 'asc';
        const mult = asc ? 1 : -1;
        const byEmail = (a, b) => (a.email || '').localeCompare(b.email || '');
        if (mode === 'quota') {
            return list.slice().sort((a, b) => {
                const d = quotaScore(a) - quotaScore(b);
                return d ? d * mult : byEmail(a, b);
            });
        }
        // default: expiry — accounts with unknown expiry always sink (asc or desc).
        return list.slice().sort((a, b) => {
            const ea = parseExpiry(a);
            const eb = parseExpiry(b);
            if (ea == null && eb == null) return byEmail(a, b);
            if (ea == null) return 1;   // a sinks
            if (eb == null) return -1;  // b sinks
            if (ea !== eb) return (ea - eb) * mult;
            return byEmail(a, b);
        });
    }

    // ---------- formatting ------------------------------------------------
    function fmtExpiry(a) {
        // Free: parseExpiry returns null (see above). Use definite text here,
        // avoid confusion with "unknown expiry" — "Free" is a stable state, not missing data.
        if (isFree(a)) return { exact: 'Free', desc: 'Free', tone: 'muted' };
        const t = parseExpiry(a);
        if (!t) return { exact: 'Unknown expiry', desc: 'Unknown expiry', tone: 'muted' };
        const delta = t - Date.now();
        const exact = new Date(t).toLocaleString();
        if (delta <= 0) {
            const daysAgo = Math.floor(-delta / (24 * 3600e3));
            return { exact, desc: 'Expired ' + daysAgo + ' days ago', tone: 'danger' };
        }
        const days = Math.floor(delta / (24 * 3600e3));
        const hours = Math.floor((delta % (24 * 3600e3)) / 3600e3);
        if (days > 7) {
            return { exact, desc: 'Expires in ' + days + ' days', tone: 'ok' };
        }
        if (days > 0) {
            return { exact, desc: 'Expires in ' + days + 'd ' + hours + 'h', tone: 'warn' };
        }
        return { exact, desc: 'Expires in ' + hours + 'h', tone: 'danger' };
    }
    function fmtPct(pct) {
        if (pct == null) return '-';
        return Math.max(0, Math.min(100, pct | 0)) + '%';
    }
    function barClass(pct) {
        // remaining quota → colour band. Smooth transition: green → yellow → red
        if (pct == null) return 'crit';
        if (pct <= 20) return 'crit';   // red: urgent low
        if (pct <= 60) return 'low';    // yellow: warning
        return '';                       // green (default .bar gradient)
    }
    /** Human readable "distance to next reset + exact timestamp".
     *  e.g. "1h 27m · 05/02 15:07", "2d 3h · 05/05 16:12", "Refreshed · 05/02 11:30". */
    function fmtReset(unixSec) {
        if (!unixSec) return '';
        const t = unixSec * 1000;
        const d = new Date(t);
        const pad = n => String(n).padStart(2, '0');
        const exact = pad(d.getMonth() + 1) + '/' + pad(d.getDate())
            + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        const delta = t - Date.now();
        if (delta <= 0) return 'Refreshed · ' + exact;
        const totalMin = Math.floor(delta / 60000);
        const days = Math.floor(totalMin / 1440);
        const hours = Math.floor((totalMin % 1440) / 60);
        const mins = totalMin % 60;
        let rel;
        if (days > 0) rel = days + 'd ' + hours + 'h';
        else if (hours > 0) rel = hours + 'h ' + mins + 'm';
        else rel = mins + 'm';
        return rel + ' · ' + exact;
    }
    function syncState(a) {
        if (a.quotaError) return 'stale';
        if (!a.lastQueryTime) return 'stale';
        return 'synced';
    }
    function planClass(planName) {
        const p = (planName || '').toLowerCase();
        if (p === 'pro' || p === 'teams' || p === 'team') return 'plan-pro';
        if (p === 'trial') return 'plan-trial';
        return 'plan-free';
    }

    // ---------- render ----------------------------------------------------
    function applyCollapseUi() {
        // Sort / Filter sections collapse state
        const sortHead = document.querySelector('.section-head[data-collapse="sort"]');
        const filterHead = document.querySelector('.section-head[data-collapse="filter"]');
        const sortBody = document.querySelector('.section-body[data-body="sort"]');
        const filterBody = document.querySelector('.section-body[data-body="filter"]');
        if (sortHead) sortHead.classList.toggle('collapsed', !!state.ui.sortCollapsed);
        if (filterHead) filterHead.classList.toggle('collapsed', !!state.ui.filterCollapsed);
        if (sortBody) sortBody.classList.toggle('collapsed', !!state.ui.sortCollapsed);
        if (filterBody) filterBody.classList.toggle('collapsed', !!state.ui.filterCollapsed);
    }

    function render() {
        // Sort dropdown: trigger label + option active state
        const sortLabel = (mode, dir) => {
            const base = mode === 'expiry' ? 'By Expiry' : 'By Quota';
            return base + ' ' + (dir === 'asc' ? '↑' : '↓');
        };
        const sortLabelEl = document.getElementById('sort-label');
        if (sortLabelEl) sortLabelEl.textContent = sortLabel(state.sort.mode, state.sort.dir);
        document.querySelectorAll('#sort-menu .dropdown-option').forEach(opt => {
            const mode = opt.dataset.sort;
            const isActive = mode === state.sort.mode;
            opt.classList.toggle('active', isActive);
            const base = mode === 'expiry' ? 'By Expiry' : 'By Quota';
            opt.textContent = isActive ? base + ' ' + (state.sort.dir === 'asc' ? '↑' : '↓') : base;
        });
        // Filter dropdown: checkboxes reflect state, trigger shows count badge.
        let filterCount = 0;
        document.querySelectorAll('#filter-menu .dropdown-check input').forEach(cb => {
            const key = cb.dataset.filter;
            cb.checked = !!state.filters[key];
            if (cb.checked) filterCount++;
        });
        const filterLabelEl = document.getElementById('filter-label');
        const filterTriggerEl = document.querySelector('[data-dd-trigger="filter"]');
        if (filterLabelEl) {
            filterLabelEl.innerHTML = filterCount > 0
                ? 'Filter<span class="dropdown-badge">' + filterCount + '</span>'
                : 'Filter';
        }
        if (filterTriggerEl) filterTriggerEl.classList.toggle('active', filterCount > 0);

        applyCollapseUi();

        // Render the "current account" card and the standalone auto switch toggles.
        renderCurrent();
        renderAutoOptions();

        // count + list
        if (state.loading) {
            countEl.innerHTML = '<span class="loading-dot">Loading</span>';
            listEl.innerHTML = '';
            return;
        }
        if (state.error) {
            countEl.textContent = 'Load failed';
            listEl.innerHTML = '<div class="empty" style="color:var(--danger)">' + escapeHtml(state.error) + '</div>';
            return;
        }

        const filtered = state.accounts.filter(passesFilter);
        const sorted = sortAccounts(filtered);
        const total = state.accounts.length;
        const anyFilter = Object.values(state.filters).some(Boolean);
        countEl.textContent = anyFilter
            ? sorted.length + '/' + total + ' accounts'
            : total + ' accounts';

        // Preserve scroll position across reloads. Target a specific card if
        // we just refreshed it (so user can see the updated values).
        const prevScroll = listEl.scrollTop;

        if (total === 0) {
            listEl.innerHTML = '<div class="empty">No accounts yet.<br><span class="cta" data-cmd="addAccount">Add Account</span></div>';
        } else if (sorted.length === 0) {
            listEl.innerHTML = '<div class="empty">No accounts match current filter.</div>';
        } else {
            listEl.innerHTML = sorted.map(a => renderCard(a, 'list')).join('');
        }

        if (scrollToIdAfterRender) {
            const target = listEl.querySelector('[data-id="' + cssEscape(scrollToIdAfterRender) + '"]');
            scrollToIdAfterRender = null;
            if (target && typeof target.scrollIntoView === 'function') {
                target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } else {
                listEl.scrollTop = prevScroll;
            }
        } else {
            listEl.scrollTop = prevScroll;
        }

        // Report the filtered+sorted id list back to the extension so smart
        // switch (manual + auto) operates on the exact set the user sees.
        post('candidateIds', { ids: sorted.map(a => a.id) });
    }

    /** Minimal CSS.escape polyfill for id attribute selectors. */
    function cssEscape(s) {
        return String(s).replace(/[^a-zA-Z0-9_-]/g, c => '\\\\' + c.charCodeAt(0).toString(16) + ' ');
    }

    function renderCard(a, mode) {
        mode = mode || 'list';
        const expiry = fmtExpiry(a);
        const daily = fmtPct(a.dailyRemainPct);
        const weekly = fmtPct(a.weeklyRemainPct);
        const dailyBar = Math.max(0, Math.min(100, a.dailyRemainPct || 0));
        const weeklyBar = Math.max(0, Math.min(100, a.weeklyRemainPct || 0));
        const remark = (a.remark || '').trim();
        const lastQ = a.lastQueryTime ? '· Updated ' + new Date(a.lastQueryTime).toLocaleString() : '';
        // Tell the user WHY the switch button is disabled, not just that it is.
        // Legacy accounts (pre-v0.4) have an empty authProvider which we treat
        // as firebase.
        const provider = (a.authProvider || 'firebase').toLowerCase();
        let switchDisableReason = '';
        if (!a.hasCredentials) {
            switchDisableReason = 'Account missing all credentials (password / idToken / refreshToken all empty). Please delete and re-import with \`Add Account\`.';
        } else if (provider !== 'firebase' && provider !== 'auth1') {
            switchDisableReason = 'Unrecognized auth provider "' + provider + '". Extension currently only supports firebase and auth1.';
        }
        const switchable = !switchDisableReason;
        return \`
<div class="card" data-id="\${escapeAttr(a.id)}">
  <div class="card-head">
    <div class="card-title">
      <div class="email" title="\${escapeAttr(a.email)}">\${escapeHtml(a.email)}</div>
      \${remark ? '<div class="remark" data-cmd="editRemark" title="Click to edit remark">📝 ' + escapeHtml(remark) + '</div>' : ''}
    </div>
    <div class="plan-badge \${planClass(a.planName)}">\${escapeHtml(a.planName || '-')}</div>
  </div>
  <div class="quota">
    <div class="quota-row">
      <div class="quota-label">Daily</div>
      <div class="progress"><div class="bar \${barClass(a.dailyRemainPct)}" style="width:\${dailyBar}%"></div></div>
      <div class="quota-value">\${daily}</div>
    </div>
    \${a.dailyResetUnix ? '<div class="quota-reset">Reset ' + escapeHtml(fmtReset(a.dailyResetUnix)) + '</div>' : ''}
    <div class="quota-row">
      <div class="quota-label">Weekly</div>
      <div class="progress"><div class="bar \${barClass(a.weeklyRemainPct)}" style="width:\${weeklyBar}%"></div></div>
      <div class="quota-value">\${weekly}</div>
    </div>
    \${a.weeklyResetUnix ? '<div class="quota-reset">Reset ' + escapeHtml(fmtReset(a.weeklyResetUnix)) + '</div>' : ''}
  </div>
  <div class="card-foot">
    <div class="expiry-row">
      <span class="expiry-desc \${expiry.tone}">\${escapeHtml(expiry.desc)}</span>
    </div>
    <div class="card-actions">
      \${mode === 'current'
        ? '<button class="btn act" data-cmd="smartSwitch" data-current data-tip="Smart Switch">' + ICONS.smartSwitch + '</button>'
          + '<button class="btn act" data-cmd="refreshCurrent" data-current data-tip="Refresh Plan / Quota">' + ICONS.refresh + '</button>'
          + '<button class="btn act" data-cmd="resetCooldown" data-current data-tip="Reset Switch Cooldown">' + ICONS.resetCooldown + '</button>'
        : '<button class="btn act" data-cmd="switch"' + (switchable ? ' data-tip="Switch to this account"' : ' disabled data-tip="' + escapeAttr(switchDisableReason) + '"') + '>' + ICONS.switch + '</button>'
          + '<button class="btn act" data-cmd="refresh" data-tip="Refresh Plan / Quota">' + ICONS.refresh + '</button>'
          + (a.hasCredentials ? '' : '<button class="btn act" data-cmd="fixCredentials" data-tip="Add password and re-login">' + ICONS.fixCredentials + '</button>')
          + '<button class="btn act" data-cmd="credentials" data-tip="Copy Account+Password">' + ICONS.credentials + '</button>'
          + '<button class="btn act" data-cmd="editRemark" data-tip="Edit Remark">' + ICONS.editRemark + '</button>'
          + '<button class="btn-danger act" data-cmd="delete" data-tip="Delete Account">' + ICONS.delete + '</button>'}
    </div>
  </div>
</div>
        \`;
    }

    // ---------- current account section -----------------------------------
    /** Render only the inner <auto-row>s. The outer <section-head> + <section-body>
     *  containers live in static HTML; this fills #auto-options with the two
     *  toggle rows whose checked/value/disabled need to reflect state. */
    function renderAutoOptions() {
        const optionsEl = document.querySelector('#auto-options');
        if (!optionsEl) return;
        const p = state.auto.polling || {};
        const l = state.auto.logWatch || {};
        const intervalMs = p.intervalMs | 0;
        const intervals = [
            { label: '30 sec', ms: 30000 },
            { label: '1 min', ms: 60000 },
            { label: '2 min', ms: 120000 },
            { label: '5 min', ms: 300000 },
            { label: '10 min', ms: 600000 }
        ];
        const options = intervals.map(i =>
            '<option value="' + i.ms + '"' + (i.ms === intervalMs ? ' selected' : '') + '>' + i.label + '</option>'
        ).join('');
        // Quota threshold: direct number input with % suffix. Applied on blur.
        //   Keeps value between 0-99 (>=100 is meaningless, soft cap at max="99")
        const threshold = state.auto.lowQuotaThreshold | 0;
        const thresholdEnabled = !!state.auto.lowQuotaThresholdEnabled;
        optionsEl.innerHTML = \`
<div class="auto-row">
  <label>
    <input type="checkbox" data-auto-toggle="polling" \${p.enabled ? 'checked' : ''} />
    <span>Account Refresh</span>
  </label>
  <select data-auto-interval \${p.enabled ? '' : 'disabled'}>\${options}</select>
</div>
<div class="auto-row">
  <label>
    <input type="checkbox" data-auto-toggle="threshold" \${thresholdEnabled ? 'checked' : ''} />
    <span>Trigger Threshold</span>
  </label>
  <div class="threshold-input">
    <input type="text" data-auto-threshold inputmode="numeric" pattern="[0-9]*" maxlength="2" value="\${threshold}" \${thresholdEnabled ? '' : 'disabled'} />
    <span class="threshold-suffix">%</span>
  </div>
</div>
<div class="auto-row">
  <label>
    <input type="checkbox" data-auto-toggle="logWatch" \${l.enabled ? 'checked' : ''} />
    <span>Monitor logs for instant switch</span>
  </label>
</div>\`;
        // Sync toolbar "Auto" button state:
        //   Any toggle on → show dot + icon accent color
        //   All off      → dot hidden, button neutral
        const hasActive = !!(p.enabled || l.enabled);
        const dot = document.querySelector('#auto-dot');
        const trigger = document.querySelector('[data-dd-trigger="auto"]');
        if (dot) {
            dot.hidden = !hasActive;
        }
        if (trigger) {
            trigger.classList.toggle('active', hasActive);
        }
    }

    function renderCurrent() {
        const id = state.currentAccountId;
        const acc = id ? state.accounts.find(a => a.id === id) : null;

        if (!acc) {
            const email = (state.activeEmail || '').trim();
            const looksLikeEmail = /@/.test(email);
            const headLine = email
                ? (looksLikeEmail
                    ? '<div class="email" title="' + escapeAttr(email) + '">' + escapeHtml(email) + '</div>' +
                      '<div class="sub">⚠ Not in account list · Click "Refresh" to identify, or import this account first</div>'
                    : '<div class="email" title="' + escapeAttr(email) + '">' + escapeHtml(email) + '</div>' +
                      '<div class="sub">⚠ Detected Windsurf current login display name, but email still syncing · Click "Refresh" to retry</div>')
                : '<div class="email">(No current account detected)</div>' +
                  '<div class="sub">Click "Refresh" to read current login status from Windsurf</div>';
            currentEl.innerHTML =
                '<div class="card placeholder">' +
                '  <div class="card-head"><div class="card-title">' + headLine + '</div></div>' +
                '  <div class="card-foot">' +
                '    <div class="card-actions">' +
                '      <button class="btn act" data-cmd="smartSwitch" data-current title="Smart Switch">' + ICONS.smartSwitch + '</button>' +
                '      <button class="btn act" data-cmd="refreshCurrent" data-current title="Refresh">' + ICONS.refresh + '</button>' +
                '      <button class="btn act" data-cmd="resetCooldown" data-current title="Reset Smart Switch Cooldown">' + ICONS.resetCooldown + '</button>' +
                '    </div>' +
                '  </div>' +
                '</div>';
            return;
        }

        currentEl.innerHTML = renderCard(acc, 'current');
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
    function escapeAttr(s) {
        return escapeHtml(s).replace(/"/g, '&quot;');
    }

    // ---------- modal overlay (add account / batch import / creds) -------
    const overlayEl = document.getElementById('modal-overlay');
    const addCardEl = document.getElementById('modal-add');
    const batchCardEl = document.getElementById('modal-batch');
    const credsCardEl = document.getElementById('modal-creds');
    const credsEmailEl = document.getElementById('modal-creds-email');
    const credsHintEl = document.getElementById('modal-creds-hint');
    const addEmailEl = document.getElementById('modal-add-email');
    const addPwdEl = document.getElementById('modal-add-password');
    const addErrorEl = document.getElementById('modal-add-error');
    const addSubmitEl = document.getElementById('modal-add-submit');
    const batchTextEl = document.getElementById('modal-batch-text');
    const batchPreviewEl = document.getElementById('modal-batch-preview');
    const batchSubmitEl = document.getElementById('modal-batch-submit');

    let currentModal = null; // 'add' | 'batch' | 'creds' | null
    let credsTarget = null;  // { id, email } for the creds modal
    let addSubmitting = false;
    let previewTimer = null;

    function setAddBusy(busy) {
        addSubmitting = busy;
        addSubmitEl.disabled = busy;
        addEmailEl.disabled = busy;
        addPwdEl.disabled = busy;
        addSubmitEl.textContent = busy ? 'Adding…' : 'Add';
    }

    function openModal(kind, opts) {
        currentModal = kind;
        overlayEl.hidden = false;
        addCardEl.hidden = kind !== 'add';
        batchCardEl.hidden = kind !== 'batch';
        credsCardEl.hidden = kind !== 'creds';
        if (kind === 'add') {
            addEmailEl.value = '';
            addPwdEl.value = '';
            addErrorEl.hidden = true;
            addErrorEl.textContent = '';
            setAddBusy(false);
            setTimeout(() => addEmailEl.focus(), 0);
        } else if (kind === 'batch') {
            batchTextEl.value = '';
            batchPreviewEl.textContent = '0 accounts identified';
            batchPreviewEl.classList.remove('has');
            batchSubmitEl.disabled = true;
            batchSubmitEl.textContent = 'Start Import';
            setTimeout(() => batchTextEl.focus(), 0);
        } else if (kind === 'creds') {
            credsTarget = opts && opts.id ? { id: opts.id, email: opts.email || '' } : null;
            credsEmailEl.textContent = (opts && opts.email) || '';
            credsHintEl.textContent = 'Content will be copied to clipboard after clicking button.';
            credsHintEl.classList.remove('error');
        }
    }

    function closeModal() {
        currentModal = null;
        credsTarget = null;
        overlayEl.hidden = true;
        addCardEl.hidden = true;
        batchCardEl.hidden = true;
        credsCardEl.hidden = true;
        addSubmitting = false;
    }

    function requestPreview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            post('previewBatch', { text: batchTextEl.value });
        }, 120);
    }

    function submitAdd() {
        if (addSubmitting) return;
        const email = (addEmailEl.value || '').trim();
        const password = addPwdEl.value || '';
        if (!email || email.indexOf('@') < 0) {
            addErrorEl.textContent = 'Please enter a valid email';
            addErrorEl.hidden = false;
            addEmailEl.focus();
            return;
        }
        if (!password) {
            addErrorEl.textContent = 'Password cannot be empty';
            addErrorEl.hidden = false;
            addPwdEl.focus();
            return;
        }
        addErrorEl.hidden = true;
        setAddBusy(true);
        post('submitAdd', { email, password });
    }

    function submitBatch() {
        if (batchSubmitEl.disabled) return;
        const text = batchTextEl.value || '';
        if (!text.trim()) return;
        post('submitBatch', { text });
        // Close immediately; batch progress is reported via VS Code notifications.
        closeModal();
    }

    // Cancel buttons
    document.querySelectorAll('[data-modal-cancel]').forEach(el => {
        el.addEventListener('click', () => {
            if (!addSubmitting) closeModal();
        });
    });
    // Click outside card to close
    overlayEl.addEventListener('click', ev => {
        if (ev.target === overlayEl && !addSubmitting) closeModal();
    });
    // Escape to close
    document.addEventListener('keydown', ev => {
        if (!currentModal) return;
        if (ev.key === 'Escape' && !addSubmitting) {
            closeModal();
        } else if (ev.key === 'Enter' && currentModal === 'add' && ev.target !== batchTextEl) {
            ev.preventDefault();
            submitAdd();
        }
    });

    addSubmitEl.addEventListener('click', submitAdd);
    document.getElementById('modal-add-github').addEventListener('click', () => {
        if (addSubmitting) return;
        post('addAccountGitHub', {});
    });
    batchSubmitEl.addEventListener('click', submitBatch);
    batchTextEl.addEventListener('input', requestPreview);
    batchTextEl.addEventListener('paste', () => setTimeout(requestPreview, 0));

    // Creds modal: action buttons
    credsCardEl.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-creds-copy]');
        if (!btn || !credsTarget) return;
        const field = btn.dataset.credsCopy;
        if (field === 'remark') {
            post('editRemark', { id: credsTarget.id });
            closeModal();
            return;
        }
        post('copyCred', { id: credsTarget.id, field });
    });

    // ---------- events ----------------------------------------------------
    function computeFilteredIds() {
        try {
            return sortAccounts(state.accounts.filter(passesFilter)).map(a => a.id);
        } catch {
            return state.accounts.map(a => a.id);
        }
    }

    // Section head collapse — Sort / Filter
    document.querySelectorAll('.section-head[data-collapse]').forEach(head => {
        head.addEventListener('click', () => {
            const section = head.dataset.collapse;
            if (section === 'sort') {
                state.ui.sortCollapsed = !state.ui.sortCollapsed;
                applyCollapseUi();
                post('toggleCollapse', { section, collapsed: state.ui.sortCollapsed });
            }
            else if (section === 'filter') {
                state.ui.filterCollapsed = !state.ui.filterCollapsed;
                applyCollapseUi();
                post('toggleCollapse', { section, collapsed: state.ui.filterCollapsed });
            }
        });
    });

    // Threshold input triple defense:
    //   1) HTML maxlength="2" — max 2 chars, natural cap at 99
    //   2) keydown — block non-numeric keys (allow Backspace/Arrow navigation)
    //   3) input — clean non-digits from paste/IME
    document.addEventListener('keydown', ev => {
        const thr = ev.target.closest('[data-auto-threshold]');
        if (!thr) return;
        // Function/navigation keys (Backspace / Delete / Arrow / Tab / Enter …) always allowed
        if (ev.key.length > 1) return;
        // Modifier combinations (Cmd/Ctrl/Alt + X) not blocked, e.g. select-all / copy / paste
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        // Only allow 0-9
        if (!/^[0-9]$/.test(ev.key)) {
            ev.preventDefault();
        }
    });
    document.addEventListener('input', ev => {
        const thr = ev.target.closest('[data-auto-threshold]');
        if (!thr) return;
        // Fallback: clean all non-digit chars (IME / special paste).
        // maxlength="2" already caps at 99, no clamp needed.
        const clean = (thr.value || '').replace(/\\D/g, '');
        if (clean !== thr.value) thr.value = clean;
    });

    // Auto-switch toggles — auto-row lives in #auto-options (top-level, NOT in currentEl)
    document.addEventListener('change', ev => {
        const chk = ev.target.closest('[data-auto-toggle]');
        if (chk) {
            const kind = chk.dataset.autoToggle;
            // optimistic update so the interval select enables/disables without waiting
            if (kind === 'polling') state.auto.polling.enabled = !!chk.checked;
            if (kind === 'logWatch') state.auto.logWatch.enabled = !!chk.checked;
            if (kind === 'threshold') state.auto.lowQuotaThresholdEnabled = !!chk.checked;
            post('toggleAuto', { kind, enabled: !!chk.checked });
            // re-render to refresh the select's disabled state
            renderAutoOptions();
            return;
        }
        const sel = ev.target.closest('[data-auto-interval]');
        if (sel) {
            const ms = Number(sel.value) | 0;
            if (ms) {
                state.auto.polling.intervalMs = ms;
                post('setPollingInterval', { intervalMs: ms });
            }
            return;
        }
        const thr = ev.target.closest('[data-auto-threshold]');
        if (thr) {
            // Defensive: empty / non-numeric / out of 0-99
            const raw = (thr.value || '').trim();
            const v = Math.round(Number(raw));
            if (raw !== '' && Number.isFinite(v) && v >= 0 && v <= 99) {
                state.auto.lowQuotaThreshold = v;
                post('setLowQuotaThreshold', { threshold: v });
            } else {
                // Revert to current valid value, prevent showing illegal content in input
                thr.value = String(state.auto.lowQuotaThreshold | 0);
            }
            return;
        }
    });

    document.addEventListener('click', ev => {
        const el = ev.target.closest('[data-cmd]');
        if (!el) return;
        const cmd = el.dataset.cmd;
        // Intercept toolbar add/batch buttons: open local modal instead of
        // delegating to extension command (which would fall back to
        // InputBox / openTextDocument flows).
        if (cmd === 'addAccount') {
            openModal('add');
            return;
        }
        if (cmd === 'batchImport') {
            openModal('batch');
            return;
        }

        // Current-account card buttons (smart switch / refresh current / reset cooldown)
        if (el.hasAttribute('data-current')) {
            if (cmd === 'smartSwitch') {
                post('smartSwitch', { filteredIds: computeFilteredIds() });
                return;
            }
            if (cmd === 'refreshCurrent') {
                // Intentionally do NOT set scrollToIdAfterRender: refreshing the
                // current-account card shouldn't hijack the user's scroll.
                post('refreshCurrent', {});
                return;
            }
            if (cmd === 'resetCooldown') {
                post('resetCooldown');
                return;
            }
        }

        const cardEl = el.closest('.card');
        const id = cardEl ? cardEl.dataset.id : undefined;
        // Single-account refresh in the list: keep the card in view after reload.
        if (cmd === 'refresh' && id) {
            scrollToIdAfterRender = id;
        }
        post(cmd, id ? { id } : undefined);
    });

    // ---- Dropdown (sort + filter) ---------------------------------------
    /** Close every open dropdown. Called on outside-click / Escape / selection. */
    function closeAllDropdowns() {
        document.querySelectorAll('.dropdown.open').forEach(d => {
            d.classList.remove('open');
            const m = d.querySelector('.dropdown-menu');
            if (m) m.hidden = true;
        });
    }
    document.querySelectorAll('.dropdown-trigger').forEach(trig => {
        trig.addEventListener('click', e => {
            e.stopPropagation();
            const dd = trig.closest('.dropdown');
            if (!dd) return;
            const isOpen = dd.classList.contains('open');
            closeAllDropdowns();
            if (!isOpen) {
                dd.classList.add('open');
                const m = dd.querySelector('.dropdown-menu');
                if (m) m.hidden = false;
            }
        });
    });
    // Sort option click:
    //   * already-active option → toggle direction (asc ↔ desc), KEEP menu open
    //     so user can keep flipping if they want.
    //   * other option         → switch mode to its default direction, close menu.
    document.querySelectorAll('#sort-menu .dropdown-option').forEach(opt => {
        opt.addEventListener('click', e => {
            e.stopPropagation();
            const mode = opt.dataset.sort;
            const wasActive = state.sort.mode === mode;
            if (wasActive) {
                state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
            } else {
                state.sort.mode = mode;
                state.sort.dir = mode === 'expiry' ? 'asc' : 'desc';
            }
            persist();
            render();
            if (!wasActive) closeAllDropdowns();
        });
    });
    // Filter checkbox toggle → keep menu open, re-render.
    document.querySelectorAll('#filter-menu .dropdown-check input').forEach(cb => {
        cb.addEventListener('change', () => {
            const key = cb.dataset.filter;
            state.filters[key] = cb.checked;
            persist();
            render();
        });
    });
    // Click inside filter menu (but not on the checkbox itself) keeps it open;
    // but allow clicks on <label> to toggle (native label click triggers input).
    document.querySelectorAll('.dropdown-menu').forEach(m => {
        m.addEventListener('click', e => e.stopPropagation());
    });
    // Outside click / Escape → close.
    document.addEventListener('click', () => closeAllDropdowns());
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeAllDropdowns();
    });

    window.addEventListener('message', ev => {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'state') {
            state.loading = !!msg.loading;
            state.accounts = Array.isArray(msg.accounts) ? msg.accounts : [];
            state.error = msg.error;
            if ('currentAccountId' in msg) state.currentAccountId = msg.currentAccountId || null;
            if ('activeEmail' in msg) state.activeEmail = msg.activeEmail || null;
            if (msg.smartHistory && typeof msg.smartHistory === 'object') state.smartHistory = msg.smartHistory;
            if (msg.auto) state.auto = msg.auto;
            if (msg.ui) state.ui = msg.ui;
            render();
            return;
        }
        if (msg.type === 'status') {
            statusEl.className = 'status ' + (msg.tone || 'info');
            statusEl.textContent = msg.text || '';
            statusEl.hidden = !msg.text;
            if (msg.text) {
                clearTimeout(statusEl._t);
                statusEl._t = setTimeout(() => { statusEl.hidden = true; }, 2000);
            }
            return;
        }
        if (msg.type === 'batchPreview') {
            const n = (msg.count | 0);
            batchPreviewEl.textContent = n + ' accounts identified';
            batchPreviewEl.classList.toggle('has', n > 0);
            batchSubmitEl.disabled = n === 0;
            return;
        }
        if (msg.type === 'modalClose') {
            closeModal();
            return;
        }
        if (msg.type === 'modalError') {
            if (currentModal === 'add') {
                setAddBusy(false);
                addErrorEl.textContent = msg.text || 'Operation failed';
                addErrorEl.hidden = false;
            }
            return;
        }
        if (msg.type === 'openModal') {
            if (msg.kind === 'add' || msg.kind === 'batch' || msg.kind === 'creds') {
                openModal(msg.kind, msg.opts);
            }
            return;
        }
    });

    render();
})();
`;
