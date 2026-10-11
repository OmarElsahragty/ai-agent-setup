// Cloudflare Access JWT validation at the CloudCLI origin (patch P5, FP-2 / finding S1)
// plus the P12 origin hardening (WO-4 / findings F5, F12, F13).
// Validates the Cf-Access-Jwt-Assertion header (fallback: CF_Authorization cookie)
// using node:crypto only (JWK -> createPublicKey, RS256 via createVerify).
// Enabled ONLY when BOTH CF_ACCESS_AUD and CF_ACCESS_TEAM_DOMAIN are set; when either
// is unset every Access export is a pass-through so local/offline behaviour is unchanged.
// Optional CF_ACCESS_EMAIL pins the assertion's email claim (case-insensitive match).
// Fail closed: missing/invalid assertion or certs-fetch failure always rejects.
// No loopback bypass. Tokens and cookies are never logged: reject lines carry a reason
// code, the method, the path without its query string and the peer address only.
// P12 Origin allowlist: CLOUDCLI_ALLOWED_ORIGINS (comma list, active only when set)
// rejects WebSocket upgrades and non-GET/HEAD REST requests whose Origin header is
// missing or not listed with HTTP 403; a set value with no valid origin rejects all.
import { createPublicKey, createVerify } from 'node:crypto';

const CLOCK_SKEW_SECONDS = 60;
const CERTS_CACHE_MS = 60 * 60 * 1000;
const CERTS_TIMEOUT_MS = 5000;
const MAX_TOKEN_CHARS = 16384;
const LOG_VALUE_MAX_CHARS = 200;

const state = { keys: new Map(), fetchedAt: 0, inFlight: null };
let originCache = { raw: null, origins: null };

export function resetAccessStateForTesting() {
    state.keys = new Map();
    state.fetchedAt = 0;
    state.inFlight = null;
    originCache = { raw: null, origins: null };
}

function accessConfig() {
    const aud = (process.env.CF_ACCESS_AUD || '').trim();
    let team = (process.env.CF_ACCESS_TEAM_DOMAIN || '').trim().toLowerCase();
    team = team.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!aud || !team || team.includes('/')) {
        return null;
    }
    const email = (process.env.CF_ACCESS_EMAIL || '').trim().toLowerCase();
    return { aud, team, issuer: `https://${team}`, email: email || null };
}

export function isAccessAuthEnabled() {
    return accessConfig() !== null;
}

function extractAccessToken(headers) {
    const h = headers || {};
    const headerToken = h['cf-access-jwt-assertion'];
    if (typeof headerToken === 'string' && headerToken.length > 0) {
        return headerToken;
    }
    const cookie = h.cookie;
    if (typeof cookie === 'string') {
        for (const part of cookie.split(';')) {
            const eq = part.indexOf('=');
            if (eq > 0 && part.slice(0, eq).trim() === 'CF_Authorization') {
                const value = part.slice(eq + 1).trim();
                if (value) {
                    return value;
                }
            }
        }
    }
    return null;
}

function decodeSegment(segment, what) {
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    }
    catch {
        throw new Error(`malformed ${what}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`malformed ${what}`);
    }
    return parsed;
}

async function fetchCerts(cfg, { force = false } = {}) {
    if (state.inFlight) {
        return state.inFlight;
    }
    if (!force && state.fetchedAt > 0 && Date.now() - state.fetchedAt < CERTS_CACHE_MS) {
        return state.keys;
    }
    const load = (async () => {
        const url = `https://${cfg.team}/cdn-cgi/access/certs`;
        const response = await fetch(url, { signal: AbortSignal.timeout(CERTS_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`certs endpoint returned HTTP ${response.status}`);
        }
        const body = await response.json();
        const keys = new Map();
        // Accept both the JWKS shape ({keys:[{kid,kty,n,e}]}) and the legacy
        // {public_certs:[{kid,cert}]} PEM shape from /cdn-cgi/access/certs.
        for (const entry of body.keys ?? body.public_certs ?? []) {
            if (!entry || typeof entry.kid !== 'string' || entry.kid.length === 0) {
                continue;
            }
            if (typeof entry.cert === 'string') {
                keys.set(entry.kid, createPublicKey(entry.cert));
            }
            else if (entry.kty === 'RSA' && typeof entry.n === 'string' && typeof entry.e === 'string') {
                keys.set(entry.kid, createPublicKey({ key: entry, format: 'jwk' }));
            }
        }
        if (keys.size === 0) {
            throw new Error('certs response contained no usable keys');
        }
        state.keys = keys;
        state.fetchedAt = Date.now();
        return keys;
    })();
    state.inFlight = load;
    try {
        return await load;
    }
    finally {
        if (state.inFlight === load) {
            state.inFlight = null;
        }
    }
}

export async function verifyAssertion(rawToken) {
    const cfg = accessConfig();
    if (!cfg) {
        throw new Error('cloudflare access validation is not configured');
    }
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
        throw new Error('missing access assertion');
    }
    if (rawToken.length > MAX_TOKEN_CHARS) {
        throw new Error('access assertion too large');
    }
    const segments = rawToken.split('.');
    if (segments.length !== 3) {
        throw new Error('malformed access assertion');
    }
    const [encHeader, encPayload, encSignature] = segments;
    const header = decodeSegment(encHeader, 'access assertion header');
    const payload = decodeSegment(encPayload, 'access assertion payload');
    if (header.alg !== 'RS256') {
        throw new Error('only RS256 access assertions are accepted');
    }
    if (typeof header.kid !== 'string' || header.kid.length === 0) {
        throw new Error('access assertion header has no kid');
    }
    if (payload.iss !== cfg.issuer) {
        throw new Error('access assertion issuer mismatch');
    }
    const audience = payload.aud;
    const audienceOk = Array.isArray(audience) ? audience.includes(cfg.aud) : audience === cfg.aud;
    if (!audienceOk) {
        throw new Error('access assertion audience mismatch');
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || now >= payload.exp + CLOCK_SKEW_SECONDS) {
        throw new Error('access assertion expired');
    }
    if (typeof payload.nbf !== 'number' || now < payload.nbf - CLOCK_SKEW_SECONDS) {
        throw new Error('access assertion not yet valid');
    }
    let keys = await fetchCerts(cfg);
    let key = keys.get(header.kid);
    if (!key) {
        // Key rotation: refetch once on unknown kid (still single-flight).
        keys = await fetchCerts(cfg, { force: true });
        key = keys.get(header.kid);
        if (!key) {
            throw new Error('unknown access assertion signing key');
        }
    }
    const signature = Buffer.from(encSignature, 'base64url');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${encHeader}.${encPayload}`);
    if (!verifier.verify(key, signature)) {
        throw new Error('access assertion signature mismatch');
    }
    if (cfg.email) {
        const claim = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
        if (claim !== cfg.email) {
            throw new Error('access assertion email mismatch');
        }
    }
    return payload;
}

function logValue(value) {
    if (value === undefined || value === null || value === '') {
        return '-';
    }
    return JSON.stringify(String(value).slice(0, LOG_VALUE_MAX_CHARS));
}

function headerValue(req, name) {
    const value = req?.headers?.[name];
    return Array.isArray(value) ? value.join(', ') : value;
}

function requestPath(req) {
    const raw = typeof req?.originalUrl === 'string' ? req.originalUrl : (typeof req?.url === 'string' ? req.url : '');
    const cut = raw.search(/[?#]/);
    return cut === -1 ? raw : raw.slice(0, cut);
}

function requestPeer(req) {
    return req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? null;
}

function logAccessReject(kind, error, req) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[cloudflare-access] rejected ${kind} reason=${logValue(reason)} method=${logValue(req?.method)} path=${logValue(requestPath(req))} peer=${logValue(requestPeer(req))} cfip=${logValue(headerValue(req, 'cf-connecting-ip'))}`);
}

// Express middleware mounted app-wide BEFORE every route (incl. /health).
export async function accessRestMiddleware(req, res, next) {
    if (!isAccessAuthEnabled()) {
        next();
        return;
    }
    try {
        await verifyAssertion(extractAccessToken(req.headers));
    }
    catch (error) {
        logAccessReject('request', error, req);
        res.status(401).json({ error: 'Cloudflare Access validation failed', code: 'CF_ACCESS_DENIED' });
        return;
    }
    next();
}

// Wraps the WebSocketServer verifyClient hook (runs BEFORE the 'connection'
// handler, so /shell and /plugin-ws rejections happen before any pty/plugin
// spawn). The patched arrow has arity 2, so ws 8.x always uses callback mode;
// rejection aborts the upgrade with HTTP 401 and destroys the socket.
export function guardAccessWebSocketUpgrade(info, callback, fallbackDecision) {
    if (!isAccessAuthEnabled()) {
        const allowed = runFallbackDecision(fallbackDecision);
        finishWebSocketGuard(callback, allowed);
        return allowed;
    }
    void (async () => {
        try {
            await verifyAssertion(extractAccessToken(info?.req?.headers));
        }
        catch (error) {
            logAccessReject('websocket upgrade', error, info?.req);
            finishWebSocketGuard(callback, false);
            return;
        }
        finishWebSocketGuard(callback, runFallbackDecision(fallbackDecision));
    })();
    return undefined;
}

function runFallbackDecision(fallbackDecision) {
    try {
        return !!fallbackDecision();
    }
    catch {
        return false;
    }
}

function finishWebSocketGuard(callback, allowed) {
    if (typeof callback !== 'function') {
        return;
    }
    if (allowed) {
        callback(true);
    }
    else {
        callback(false, 401, 'Unauthorized');
    }
}

function normalizeOrigin(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    let url;
    try {
        url = new URL(trimmed);
    }
    catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return null;
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
        return null;
    }
    return url.origin;
}

function allowedOrigins() {
    const raw = process.env.CLOUDCLI_ALLOWED_ORIGINS;
    if (typeof raw !== 'string' || raw.trim() === '') {
        return null;
    }
    if (originCache.raw !== raw) {
        const origins = new Set();
        const invalid = [];
        for (const entry of raw.split(',')) {
            if (!entry.trim()) {
                continue;
            }
            const normalized = normalizeOrigin(entry);
            if (normalized) {
                origins.add(normalized);
            }
            else {
                invalid.push(logValue(entry.trim()));
            }
        }
        if (invalid.length > 0 || origins.size === 0) {
            console.warn(`[origin-allowlist] CLOUDCLI_ALLOWED_ORIGINS has ${origins.size} valid origin(s); ignored invalid entries: ${invalid.join(', ') || '-'}`);
        }
        originCache = { raw, origins };
    }
    return originCache.origins;
}

export function isOriginAllowlistEnabled() {
    return allowedOrigins() !== null;
}

function originAllowed(origins, origin) {
    const normalized = normalizeOrigin(origin);
    return normalized !== null && origins.has(normalized);
}

function logOriginReject(kind, req, origin) {
    console.warn(`[origin-allowlist] rejected ${kind} method=${logValue(req?.method)} path=${logValue(requestPath(req))} origin=${logValue(origin)} peer=${logValue(requestPeer(req))} cfip=${logValue(headerValue(req, 'cf-connecting-ip'))} ua=${logValue(headerValue(req, 'user-agent'))}`);
}

// Express middleware mounted right after accessRestMiddleware. GET and HEAD
// always pass (so /health and static assets need no Origin).
export function originRestMiddleware(req, res, next) {
    const origins = allowedOrigins();
    const method = typeof req?.method === 'string' ? req.method.toUpperCase() : '';
    if (origins === null || method === 'GET' || method === 'HEAD') {
        next();
        return;
    }
    const origin = headerValue(req, 'origin');
    if (originAllowed(origins, origin)) {
        next();
        return;
    }
    logOriginReject('request', req, origin);
    res.status(403).json({ error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' });
}

// Runs before the Access guard and the app's own verifyClient: a rejected
// upgrade gets HTTP 403 and no connection handler (chat, shell, plugin) runs.
export function guardOriginWebSocketUpgrade(info, callback, next) {
    const origins = allowedOrigins();
    if (origins === null) {
        return next();
    }
    const req = info?.req;
    const origin = info?.origin ?? headerValue(req, 'origin');
    if (originAllowed(origins, origin)) {
        return next();
    }
    logOriginReject('websocket upgrade', req, origin);
    if (typeof callback === 'function') {
        callback(false, 403, 'Forbidden');
    }
    return false;
}

// Wraps WebSocketServer options so the Origin check runs first and the
// original verifyClient (the P5 guard) is left untouched.
export function withWebSocketOriginGuard(options) {
    const inner = options?.verifyClient;
    return {
        ...options,
        verifyClient: (info, callback) => guardOriginWebSocketUpgrade(info, callback, () => {
            if (typeof inner !== 'function') {
                finishWebSocketGuard(callback, true);
                return true;
            }
            if (inner.length >= 2) {
                return inner(info, callback);
            }
            const allowed = runFallbackDecision(() => inner(info));
            finishWebSocketGuard(callback, allowed);
            return allowed;
        }),
    };
}
