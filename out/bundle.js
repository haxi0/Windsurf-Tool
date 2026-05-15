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
exports.BUNDLE_FILE_EXTENSION = exports.BUNDLE_VERSION = exports.BUNDLE_FORMAT_ID = void 0;
exports.packBundle = packBundle;
exports.isBundleEncrypted = isBundleEncrypted;
exports.unpackBundle = unpackBundle;
exports.serializeBundle = serializeBundle;
exports.entryHasCredential = entryHasCredential;
/**
 * Portable encrypted account bundle (`.wssbundle`).
 *
 * Single-file format for moving accounts between machines / installs without
 * re-running OAuth flows or re-typing passwords. The on-disk envelope is JSON
 * so it stays inspectable; the actual account payload is AES-256-GCM
 * encrypted with a key derived from a user-supplied password via PBKDF2-SHA256.
 *
 * If the user supplies an empty password we still write a valid envelope but
 * with `encryption: "none"` and the payload inlined. Import handles both.
 *
 * Envelope (encryption = "aes-256-gcm"):
 *   {
 *     "format": "windsurf-switch.bundle",
 *     "version": 1,
 *     "createdAt": "2026-05-15T22:00:00.000Z",
 *     "accountCount": 5,
 *     "encryption": "aes-256-gcm",
 *     "kdf": "pbkdf2-sha256",
 *     "kdfIterations": 200000,
 *     "salt": "<base64 16 bytes>",
 *     "iv":   "<base64 12 bytes>",
 *     "ciphertext": "<base64 (cipher || tag)>"
 *   }
 *
 * Envelope (encryption = "none"):
 *   {
 *     "format": "windsurf-switch.bundle",
 *     "version": 1,
 *     "createdAt": "...",
 *     "accountCount": 5,
 *     "encryption": "none",
 *     "payload": [ ...accounts ]
 *   }
 *
 * Decrypted payload is always a JSON array of `BundleAccountEntry`.
 */
const crypto = __importStar(require("crypto"));
exports.BUNDLE_FORMAT_ID = 'windsurf-switch.bundle';
exports.BUNDLE_VERSION = 1;
exports.BUNDLE_FILE_EXTENSION = 'wssbundle';
const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const KDF_ITERATIONS = 200000;
const KDF_DIGEST = 'sha256';
/**
 * Encrypted-or-plain pack. Empty / undefined password = plaintext envelope
 * (`encryption: "none"`). Otherwise PBKDF2-SHA256 derives a 256-bit key and
 * AES-256-GCM encrypts the JSON-stringified payload.
 */
function packBundle(entries, password) {
    const createdAt = new Date().toISOString();
    const accountCount = entries.length;
    if (!password) {
        return {
            format: exports.BUNDLE_FORMAT_ID,
            version: exports.BUNDLE_VERSION,
            createdAt,
            accountCount,
            encryption: 'none',
            payload: entries
        };
    }
    const salt = crypto.randomBytes(SALT_BYTES);
    const iv = crypto.randomBytes(IV_BYTES);
    const key = crypto.pbkdf2Sync(password, salt, KDF_ITERATIONS, KEY_BYTES, KDF_DIGEST);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const plaintext = Buffer.from(JSON.stringify(entries), 'utf8');
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        format: exports.BUNDLE_FORMAT_ID,
        version: exports.BUNDLE_VERSION,
        createdAt,
        accountCount,
        encryption: 'aes-256-gcm',
        kdf: 'pbkdf2-sha256',
        kdfIterations: KDF_ITERATIONS,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        ciphertext: Buffer.concat([enc, tag]).toString('base64')
    };
}
/**
 * Detect whether a JSON-parsed envelope claims to be encrypted. Doesn't validate
 * the actual format beyond looking at the `encryption` field — `unpackBundle`
 * does that.
 */
function isBundleEncrypted(env) {
    return !!env && typeof env === 'object' && env.encryption === 'aes-256-gcm';
}
/**
 * Reverse of `packBundle`. Throws a descriptive Error for any structural,
 * version, or AES tag mismatch so the caller can show the message verbatim.
 *
 * The supplied password is ignored for unencrypted envelopes.
 */
function unpackBundle(env, password) {
    if (!env || typeof env !== 'object') {
        throw new Error('Bundle is empty or not a JSON object');
    }
    if (env.format !== exports.BUNDLE_FORMAT_ID) {
        throw new Error(`Unrecognised bundle format: ${JSON.stringify(env.format)}`);
    }
    if (typeof env.version !== 'number' || env.version > exports.BUNDLE_VERSION) {
        throw new Error(`Unsupported bundle version: ${env.version} (this build supports up to v${exports.BUNDLE_VERSION})`);
    }
    if (env.encryption === 'none') {
        if (!Array.isArray(env.payload)) {
            throw new Error('Bundle is marked unencrypted but has no payload array');
        }
        return env.payload;
    }
    if (env.encryption !== 'aes-256-gcm') {
        throw new Error(`Unsupported bundle encryption: ${JSON.stringify(env.encryption)}`);
    }
    if (!password) {
        throw new Error('Bundle is encrypted but no password was provided');
    }
    if (env.kdf !== 'pbkdf2-sha256') {
        throw new Error(`Unsupported KDF: ${JSON.stringify(env.kdf)}`);
    }
    const iters = Number(env.kdfIterations);
    if (!Number.isFinite(iters) || iters < 1000) {
        throw new Error(`Unsupported kdfIterations: ${env.kdfIterations}`);
    }
    let salt;
    let iv;
    let blob;
    try {
        salt = Buffer.from(String(env.salt || ''), 'base64');
        iv = Buffer.from(String(env.iv || ''), 'base64');
        blob = Buffer.from(String(env.ciphertext || ''), 'base64');
    }
    catch (e) {
        throw new Error(`Bundle has invalid base64: ${e?.message || e}`);
    }
    if (salt.length !== SALT_BYTES) {
        throw new Error(`Bundle salt has wrong length: ${salt.length} (expected ${SALT_BYTES})`);
    }
    if (iv.length !== IV_BYTES) {
        throw new Error(`Bundle iv has wrong length: ${iv.length} (expected ${IV_BYTES})`);
    }
    if (blob.length <= TAG_BYTES) {
        throw new Error('Bundle ciphertext is shorter than the auth tag');
    }
    const enc = blob.subarray(0, blob.length - TAG_BYTES);
    const tag = blob.subarray(blob.length - TAG_BYTES);
    const key = crypto.pbkdf2Sync(password, salt, iters, KEY_BYTES, KDF_DIGEST);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    let plaintext;
    try {
        plaintext = Buffer.concat([decipher.update(enc), decipher.final()]);
    }
    catch (e) {
        // AES-GCM auth tag mismatch — either wrong password or tampered file.
        throw new Error('Decryption failed — wrong password or corrupted bundle');
    }
    let parsed;
    try {
        parsed = JSON.parse(plaintext.toString('utf8'));
    }
    catch (e) {
        throw new Error(`Decrypted payload is not valid JSON: ${e?.message || e}`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error('Decrypted payload is not a JSON array');
    }
    return parsed;
}
/**
 * Convenience: serialise an envelope to a pretty-printed UTF-8 string suitable
 * for writing straight to disk. Pretty-printed so a curious user can `cat` the
 * file and see the metadata.
 */
function serializeBundle(env) {
    return JSON.stringify(env, null, 2);
}
/**
 * Best-effort: detect whether an entry has any importable credential. Used
 * before calling the real importer so we can show an upfront "skip" count.
 */
function entryHasCredential(e) {
    return !!(e && (e.password || e.idToken || e.auth1Token));
}
//# sourceMappingURL=bundle.js.map