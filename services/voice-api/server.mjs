import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import { createFixedWindowRateLimiter, createGisService, GisServiceError } from './gis-service.mjs';

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const LIVEKIT_API_KEY = String(process.env.LIVEKIT_API_KEY || '').trim();
const LIVEKIT_API_SECRET = String(process.env.LIVEKIT_API_SECRET || '').trim();
const LIVEKIT_WS_URL = String(process.env.LIVEKIT_WS_URL || 'wss://rtc.agr.vision').trim();
const TOKEN_TTL = String(process.env.VOICE_TOKEN_TTL || '6h').trim();
const SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://supabase.agr.vision').trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const ALLOWED_ORIGINS = String(process.env.VOICE_API_ALLOWED_ORIGINS
    || 'https://agr.vision,https://www.agr.vision,https://niemandx.github.io,http://127.0.0.1:5173,http://localhost:5173,null')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    console.error('Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET');
    process.exit(1);
}

function pickCorsOrigin(origin) {
    if (!origin) return null;
    if (ALLOWED_ORIGINS.includes('*')) return '*';
    return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function applyCors(request, response) {
    const allowOrigin = pickCorsOrigin(request.headers.origin || '');
    if (allowOrigin) {
        response.setHeader('Access-Control-Allow-Origin', allowOrigin);
        response.setHeader('Vary', 'Origin');
    }
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(request, response, statusCode, payload) {
    applyCors(request, response);
    response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
}

function sendText(request, response, statusCode, payload) {
    applyCors(request, response);
    response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(payload);
}

function sendProxyResponse(request, response, payload) {
    applyCors(request, response);
    response.writeHead(payload.status, {
        'Content-Type': payload.contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    response.end(payload.body);
}

function sendServiceError(request, response, error) {
    const status = error instanceof GisServiceError ? error.status : 500;
    const message = error instanceof GisServiceError ? error.message : 'Сервис 2ГИС временно недоступен.';
    sendJson(request, response, status, { ok: false, error: message });
}

function isAllowedRequestOrigin(request) {
    const origin = String(request.headers.origin || '');
    return !origin || pickCorsOrigin(origin) !== null;
}

function getClientIp(request) {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').map((value) => value.trim()).filter(Boolean);
    return forwarded.at(-1) || request.socket?.remoteAddress || 'unknown';
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        let raw = '';
        request.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > 256 * 1024) {
                reject(new Error('Request body too large'));
                request.destroy();
            }
        });
        request.on('end', () => {
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (error) {
                reject(new Error('Invalid JSON body'));
            }
        });
        request.on('error', reject);
    });
}

function normalizeRoom(value) {
    const room = String(value || '').trim();
    if (!room || room.length > 128) return '';
    return room;
}

function normalizeIdentity(value) {
    const identity = String(value || '').trim();
    if (!identity) return `guest-${randomUUID()}`;
    return identity.slice(0, 128);
}

function normalizeName(value, fallback) {
    const name = String(value || '').trim();
    if (!name) return fallback;
    return name.slice(0, 128);
}

function normalizeMetadata(value) {
    if (value == null) return '{}';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch (_) {
        return '{}';
    }
}

async function createJoinToken(body) {
    const room = normalizeRoom(body.room);
    if (!room) {
        throw new Error('Field "room" is required');
    }

    const identity = normalizeIdentity(body.identity);
    const name = normalizeName(body.name, identity);
    const metadata = normalizeMetadata(body.metadata);
    const canPublish = body?.permissions?.canPublish !== false;
    const canSubscribe = body?.permissions?.canSubscribe !== false;
    const canPublishData = body?.permissions?.canPublishData !== false;

    const accessToken = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity,
        name,
        metadata,
        ttl: TOKEN_TTL,
    });

    accessToken.addGrant({
        roomJoin: true,
        room,
        canPublish,
        canSubscribe,
        canPublishData,
    });

    const token = await accessToken.toJwt();

    return {
        token,
        wsUrl: LIVEKIT_WS_URL,
        room,
        identity,
        name,
        permissions: {
            canPublish,
            canSubscribe,
            canPublishData,
        },
    };
}

const gisService = createGisService({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
});
const consumeCatalogRequest = createFixedWindowRateLimiter({ limit: 40 });
const consumeAdminRequest = createFixedWindowRateLimiter({ limit: 30 });

function enforceRateLimit(request, response, consume) {
    const result = consume(getClientIp(request));
    if (result.allowed) return true;
    response.setHeader('Retry-After', String(result.retryAfter));
    sendJson(request, response, 429, { ok: false, error: 'Слишком много запросов. Повторите позже.' });
    return false;
}

const server = http.createServer(async (request, response) => {
    const method = request.method || 'GET';
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (method === 'OPTIONS') {
        applyCors(request, response);
        response.writeHead(204);
        response.end();
        return;
    }

    if (method === 'GET' && url.pathname === '/') {
        sendText(request, response, 200, 'voice-api is running');
        return;
    }

    if (method === 'GET' && url.pathname === '/healthz') {
        sendJson(request, response, 200, {
            ok: true,
            service: 'voice-api',
            wsUrl: LIVEKIT_WS_URL,
            gisBackendConfigured: gisService.isBackendConfigured(),
            timestamp: new Date().toISOString(),
        });
        return;
    }

    if (url.pathname.startsWith('/v1/2gis/') || url.pathname === '/v1/admin/2gis') {
        if (!isAllowedRequestOrigin(request)) {
            sendJson(request, response, 403, { ok: false, error: 'Origin is not allowed' });
            return;
        }
    }

    if (method === 'GET' && url.pathname === '/v1/2gis/status') {
        if (!enforceRateLimit(request, response, consumeCatalogRequest)) return;
        try {
            sendJson(request, response, 200, await gisService.getPublicStatus());
        } catch (error) {
            sendServiceError(request, response, error);
        }
        return;
    }

    if (method === 'GET' && url.pathname === '/v1/2gis/items') {
        if (!enforceRateLimit(request, response, consumeCatalogRequest)) return;
        try {
            sendProxyResponse(request, response, await gisService.proxyItems(url.searchParams));
        } catch (error) {
            sendServiceError(request, response, error);
        }
        return;
    }

    if (url.pathname === '/v1/admin/2gis' && ['GET', 'PUT', 'DELETE'].includes(method)) {
        if (!enforceRateLimit(request, response, consumeAdminRequest)) return;
        try {
            const authorization = request.headers.authorization || '';
            if (method === 'GET') {
                sendJson(request, response, 200, await gisService.getAdminStatus(authorization));
            } else if (method === 'PUT') {
                const body = await readJsonBody(request);
                sendJson(request, response, 200, await gisService.setAdminKey(authorization, body.apiKey));
            } else {
                sendJson(request, response, 200, await gisService.clearAdminKey(authorization));
            }
        } catch (error) {
            sendServiceError(request, response, error);
        }
        return;
    }

    if (method === 'POST' && url.pathname === '/v1/token') {
        try {
            const body = await readJsonBody(request);
            const payload = await createJoinToken(body);
            sendJson(request, response, 200, payload);
        } catch (error) {
            sendJson(request, response, 400, {
                ok: false,
                error: error instanceof Error ? error.message : 'Token generation failed',
            });
        }
        return;
    }

    sendJson(request, response, 404, {
        ok: false,
        error: 'Not found',
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`voice-api listening on :${PORT}`);
});
