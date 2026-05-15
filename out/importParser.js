"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseBatch = parseBatch;
/**
 * Batch import parser. Extends the desktop Services/ImportParserService to
 * recognise the extra formats the user pastes:
 *
 *   1. JSON array of { email, password } objects
 *   2. Label format:  Email: xxx\nPassword: yyy  (multi-line, English labels)
 *   3. CSV:           email,password  (one pair per line, optional header)
 *   4. Tab:           email\tpassword
 *   5. URL query:     email=xxx&password=yyy  (one per line)
 *   6. Inline regex:  email:pwd / email pwd / email----pwd / email@@pwd (w/ quotes)
 *
 * Fullwidth colons (:) and commas (,) are normalised to their ASCII
 * Fullwidth colons (：) and commas (，) are normalised to their ASCII
 * equivalents so Chinese label paste just works.
 */
const EMAIL_PATTERN = '[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}';
const EMAIL_REGEX = new RegExp(EMAIL_PATTERN);
const EMAIL_REGEX_FULL = new RegExp(`^${EMAIL_PATTERN}$`);
const PAIR_TOKEN_REGEX = new RegExp(`(?<email>${EMAIL_PATTERN})\\s*(?:(?:----|@@|[:;|])\\s*|\\s+)(?<password>"[^"\\r\\n]+"|'[^'\\r\\n]+'|\`[^\`\\r\\n]+\`|\\S+)`, 'g');
function parseBatch(text) {
    if (!text || !text.trim()) {
        return [];
    }
    // 1) normalise: fullwidth punctuation → ASCII; weird unicode spaces → space;
    //    strip common prefixes like `mailto:` / zero-width chars.
    const normalized = text
        // unicode spaces → ASCII space
        .replace(/\u3000/g, ' ')
        .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F]/g, ' ')
        // zero-width + BOM
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        // full-width punctuation → ASCII
        .replace(/\uFF1A/g, ':') // ：
        .replace(/\uFF0C/g, ',') // ，
        .replace(/\uFF1B/g, ';') // ；
        .replace(/\uFF5C/g, '|') // ｜
        .replace(/\uFF3F/g, '_') // ＿ (no-op for consistency)
        .replace(/\uFF3C/g, '\\') // ＼
        .replace(/\uFF0F/g, '/') // ／
        .replace(/\uFF0D/g, '-') // －
        // Full-width @ / = normalization (rare but seen)
        .replace(/\uFF20/g, '@')
        .replace(/\uFF1D/g, '=')
        // Merge consecutive "mailto:" prefixes
        .replace(/\bmailto:\s*/gi, '');
    // 1.5) split multi-label single-lines. Example input (this is the exact
    //      format produced by the extension's "copy credentials" button):
    //        "Account: alice@x.com    Password: pass123"
    //      → "Account: alice@x.com\nPassword: pass123"
    //      so that parseLabelFormat can pair them correctly.
    //      The lookahead only fires on known password-ish labels to avoid
    //      accidentally splitting JSON strings or arbitrary content.
    const LABEL_SPLIT_REGEX = /[\s,;|]+(?=(?:密码|password|passwd|pwd|pass)\s*[:：])/gi; // Chinese/English password labels
    const splitLabeled = normalized.replace(LABEL_SPLIT_REGEX, '\n');
    // 2) try strategies in order of specificity. First non-empty result wins.
    const strategies = [
        parseJson,
        parseUrlQuery,
        parseLabelFormat,
        parseLineByLine,
        parseInlinePairs
    ];
    for (const strat of strategies) {
        const out = strat(splitLabeled);
        if (out.length > 0) {
            return out;
        }
    }
    return [];
}
// --- JSON ---------------------------------------------------------------
function parseJson(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
        return [];
    }
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return [];
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const out = [];
    const seen = new Set();
    for (const item of items) {
        if (!item || typeof item !== 'object')
            continue;
        const rec = item;
        const email = pickString(rec, ['email', 'Email', 'username', 'user', 'account']);
        const password = pickString(rec, ['password', 'Password', 'pwd', 'pass']);
        // Token-based entries (exported from browser sign-in / OAuth accounts)
        // carry the credential in `idToken` / `apiKey` instead of a password.
        const idToken = pickString(rec, ['idToken', 'idtoken', 'apiKey', 'apikey', 'accessToken', 'token']);
        const refreshToken = pickString(rec, ['refreshToken', 'refreshtoken']);
        const auth1Token = pickString(rec, ['auth1Token', 'auth1token']);
        const authProvider = pickString(rec, ['authProvider', 'authprovider', 'provider']);
        const displayName = pickString(rec, ['displayName', 'displayname', 'name']);
        if (!email)
            continue;
        if (!password && !idToken)
            continue;
        // Email may be a plain handle (e.g. "browser-user") for token entries
        // that don't have a real address attached; only validate when no token
        // is present (legacy email/password JSON entries must look like emails).
        if (!idToken && !EMAIL_REGEX_FULL.test(email))
            continue;
        const key = email.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        const entry = {
            email,
            password: password ? cleanPassword(password) : ''
        };
        if (idToken)
            entry.idToken = idToken;
        if (refreshToken)
            entry.refreshToken = refreshToken;
        if (auth1Token)
            entry.auth1Token = auth1Token;
        if (authProvider)
            entry.authProvider = authProvider;
        if (displayName)
            entry.displayName = displayName;
        out.push(entry);
    }
    return out;
}
function pickString(obj, keys) {
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) {
            return v.trim();
        }
    }
    return '';
}
// --- URL query ---------------------------------------------------------
// One `email=x&password=y` per line. Also handles full URLs.
function parseUrlQuery(text) {
    const out = [];
    const seen = new Set();
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || !/[?&]?\w+=.+&\w+=/.test(line))
            continue;
        // Strip leading URL path if present.
        const qIndex = line.indexOf('?');
        const query = qIndex >= 0 ? line.slice(qIndex + 1) : line;
        let params;
        try {
            params = new URLSearchParams(query);
        }
        catch {
            continue;
        }
        const email = (params.get('email') ||
            params.get('Email') ||
            params.get('username') ||
            params.get('user') ||
            '').trim();
        const password = (params.get('password') ||
            params.get('Password') ||
            params.get('pwd') ||
            params.get('pass') ||
            '').trim();
        if (!email || !password)
            continue;
        if (!EMAIL_REGEX_FULL.test(email))
            continue;
        const key = email.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({ email, password: cleanPassword(password) });
    }
    return out;
}
// --- Label format -----------------------------------------------------
// Multi-line:  Email: user@...\nPassword: ...   (labels optional, alternating value order)
// Ported from desktop PairSequentialValues.
function parseLabelFormat(text) {
    const lines = text
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0);
    const values = [];
    let hasLabelFormat = false;
    for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex <= 0)
            continue;
        const label = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();
        if (!value)
            continue;
        // A "label" should not itself look like an email or contain spaces/@.
        // This disqualifies e.g. "user@example.com:password" from label parsing
        // so it can fall through to parseLineByLine.
        if (label.length > 20 || /[@\s]/.test(label))
            continue;
        values.push(value);
        hasLabelFormat = true;
    }
    if (!hasLabelFormat || values.length < 2)
        return [];
    const out = [];
    const seen = new Set();
    let i = 0;
    while (i < values.length - 1) {
        const m = values[i].match(EMAIL_REGEX);
        if (!m) {
            i++;
            continue;
        }
        const email = m[0];
        const password = cleanPassword(values[i + 1]);
        if (password && !EMAIL_REGEX_FULL.test(password)) {
            const key = email.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                out.push({ email, password });
            }
        }
        i += 2;
    }
    return out;
}
// --- Line-by-line: email {sep} password --------------------------------
// Handles :  space  tab  ,  ----  @@  as separators.
function parseLineByLine(text) {
    const results = [];
    const seen = new Set();
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        if (/^(email|account|邮箱)\s*[,:\t]/i.test(line)) {
            // CSV/label header row
            continue;
        }
        const m = line.match(new RegExp(`^(?<email>${EMAIL_PATTERN})\\s*(?:----|@@|[:,;|\\t]|\\s)\\s*(?<password>.+)$`));
        if (!m || !m.groups)
            continue;
        const email = m.groups.email.trim();
        const password = cleanPassword(m.groups.password);
        if (!email || !password)
            continue;
        if (EMAIL_REGEX.test(password))
            continue;
        const key = email.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        results.push({ email, password });
    }
    return results;
}
// --- Inline regex fallback -------------------------------------------
function parseInlinePairs(text) {
    const results = [];
    const seen = new Set();
    let m;
    PAIR_TOKEN_REGEX.lastIndex = 0;
    while ((m = PAIR_TOKEN_REGEX.exec(text)) !== null) {
        const email = (m.groups?.email || '').trim();
        const password = cleanPassword(m.groups?.password || '');
        if (!email || !password)
            continue;
        if (EMAIL_REGEX.test(password))
            continue;
        const key = email.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        results.push({ email, password });
    }
    return results;
}
function cleanPassword(raw) {
    let v = raw.trim();
    // Strip a trailing CSV column if the line had more than email,password
    // (we only want the *first* password-looking token).
    if (v.length >= 2) {
        const first = v[0];
        const last = v[v.length - 1];
        if ((first === '"' && last === '"') ||
            (first === "'" && last === "'") ||
            (first === '`' && last === '`')) {
            v = v.slice(1, -1).trim();
        }
    }
    // Support "<username>----<real_password>" payloads that slipped through
    // when the line was split on whitespace.  Example:
    //   foo@bar.com  foo----WFD-XXXX-XXXX==-XXXX==-0-YYYY
    //                └─ taken as password by whitespace split
    // We strip everything up to and including the last `----`, keeping the
    // real password (`WFD-...`).  `----` is 4 consecutive hyphens, which is
    // extremely unlikely to appear inside a legit password.
    const quad = v.lastIndexOf('----');
    if (quad >= 0) {
        const right = v.slice(quad + 4).trim();
        const left = v.slice(0, quad).trim();
        // Only strip if the left side looks like a plain username (no @, no
        // whitespace, no `----`) and the right side is non-empty.  This keeps
        // the existing "email----password" separator behavior working even
        // though parseLineByLine already splits on it.
        if (right && left && !/[@\s]/.test(left) && left.indexOf('----') < 0) {
            v = right;
        }
    }
    return v;
}
//# sourceMappingURL=importParser.js.map