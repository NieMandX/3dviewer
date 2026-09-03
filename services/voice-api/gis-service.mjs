import { createHash } from 'node:crypto';

const SETTING_NAME = '2gis_api_key';
const KEY_CACHE_MS = 30_000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_TILE_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Map([
    ['building', 'items.address,items.adm_div,items.geometry.hover'],
    ['street,road', 'items.geometry.hover,items.geometry.selection'],
    ['parking', 'items.geometry.hover,items.geometry.selection'],
    ['adm_div.place', 'items.geometry.hover,items.geometry.selection'],
]);

export class GisServiceError extends Error {
    constructor(status, message, code = 'GIS_SERVICE_ERROR') {
        super(message);
        this.name = 'GisServiceError';
        this.status = status;
        this.code = code;
    }
}

function requireHttpUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/$/, '');
    } catch (_) {
        return '';
    }
}

export function normalize2gisApiKey(value) {
    const key = String(value || '').trim();
    if (key.length < 16 || key.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
        throw new GisServiceError(400, 'Некорректный формат API-ключа 2ГИС.', 'INVALID_API_KEY');
    }
    return key;
}

function keyFingerprint(key) {
    return createHash('sha256').update(key).digest('hex').slice(0, 12).toUpperCase();
}

function parseInteger(value, { min, max, name }) {
    if (!/^\d+$/.test(String(value || ''))) {
        throw new GisServiceError(400, `Некорректный параметр ${name}.`, 'INVALID_QUERY');
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new GisServiceError(400, `Некорректный параметр ${name}.`, 'INVALID_QUERY');
    }
    return parsed;
}

function normalizePoint(value) {
    const parts = String(value || '').split(',');
    if (parts.length !== 2) throw new GisServiceError(400, 'Некорректные координаты 2ГИС.', 'INVALID_QUERY');
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        throw new GisServiceError(400, 'Некорректные координаты 2ГИС.', 'INVALID_QUERY');
    }
    return `${lon},${lat}`;
}

function parseBearerToken(value) {
    const match = String(value || '').match(/^Bearer\s+([^\s]+)$/i);
    if (!match) throw new GisServiceError(401, 'Требуется авторизация.', 'AUTH_REQUIRED');
    return match[1];
}

async function readLimitedBody(response, maxBytes) {
    const length = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(length) && length > maxBytes) {
        throw new GisServiceError(502, '2ГИС вернул слишком большой ответ.', 'UPSTREAM_TOO_LARGE');
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes) {
        throw new GisServiceError(502, '2ГИС вернул слишком большой ответ.', 'UPSTREAM_TOO_LARGE');
    }
    return body;
}

function assertCatalogPayload(body) {
    let payload;
    try {
        payload = JSON.parse(new TextDecoder().decode(body));
    } catch (_) {
        return;
    }
    const upstreamError = payload?.meta?.error;
    if (!upstreamError) return;
    const details = typeof upstreamError === 'string'
        ? upstreamError
        : `${upstreamError.type || upstreamError.code || ''} ${upstreamError.message || ''}`;
    const authorizationFailure = /(auth|key|token|forbidden|permission)/i.test(details);
    throw new GisServiceError(
        authorizationFailure ? 403 : 502,
        authorizationFailure
            ? 'API-ключ 2ГИС отклонён. Проверьте ключ и доступ к Places API.'
            : '2ГИС вернул ошибку каталога.',
        authorizationFailure ? 'UPSTREAM_AUTH_FAILED' : 'UPSTREAM_CATALOG_ERROR',
    );
}

function withTimeout(timeoutMs) {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs) : undefined;
}

export function createGisService({
    supabaseUrl = '', serviceRoleKey = '', fetchImpl = globalThis.fetch, timeoutMs = 30_000,
} = {}) {
    const databaseUrl = requireHttpUrl(supabaseUrl);
    const serviceKey = String(serviceRoleKey || '').trim();
    let cachedSetting = null;
    let cacheExpiresAt = 0;

    function requireBackendConfig() {
        if (!databaseUrl || !serviceKey) {
            throw new GisServiceError(503, 'Серверное хранилище 2ГИС не настроено.', 'BACKEND_NOT_CONFIGURED');
        }
    }

    function serviceHeaders(extra = {}) {
        return {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            ...extra,
        };
    }

    async function readSetting({ force = false } = {}) {
        requireBackendConfig();
        if (!force && Date.now() < cacheExpiresAt) return cachedSetting;
        const url = new URL('/rest/v1/integration_secrets', `${databaseUrl}/`);
        url.search = new URLSearchParams({
            name: `eq.${SETTING_NAME}`,
            select: 'secret_value,updated_at,updated_by',
            limit: '1',
        }).toString();
        const response = await fetchImpl(url, {
            headers: serviceHeaders({ Accept: 'application/json' }),
            cache: 'no-store',
            signal: withTimeout(timeoutMs),
        });
        if (!response.ok) {
            throw new GisServiceError(503, 'Не удалось прочитать настройку 2ГИС.', 'SETTINGS_READ_FAILED');
        }
        const rows = await response.json();
        const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
        cachedSetting = row && typeof row.secret_value === 'string' ? row : null;
        cacheExpiresAt = Date.now() + KEY_CACHE_MS;
        return cachedSetting;
    }

    async function requireApiKey() {
        const setting = await readSetting();
        if (!setting?.secret_value) {
            throw new GisServiceError(503, 'API-ключ 2ГИС не настроен администратором.', 'API_KEY_NOT_CONFIGURED');
        }
        return setting.secret_value;
    }

    async function requireSuperuser(authorization) {
        requireBackendConfig();
        const token = parseBearerToken(authorization);
        const authHeaders = { apikey: serviceKey, Authorization: `Bearer ${token}` };
        const userResponse = await fetchImpl(new URL('/auth/v1/user', `${databaseUrl}/`), {
            headers: authHeaders,
            cache: 'no-store',
            signal: withTimeout(timeoutMs),
        });
        if (!userResponse.ok) throw new GisServiceError(401, 'Сессия истекла. Войдите снова.', 'INVALID_SESSION');
        const user = await userResponse.json();
        if (!user?.id || !user?.email || user?.is_anonymous === true) {
            throw new GisServiceError(403, 'Требуются права суперпользователя.', 'SUPERUSER_REQUIRED');
        }
        const roleResponse = await fetchImpl(new URL('/rest/v1/rpc/is_superuser', `${databaseUrl}/`), {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: '{}',
            cache: 'no-store',
            signal: withTimeout(timeoutMs),
        });
        const isSuperuser = roleResponse.ok ? await roleResponse.json() : false;
        if (isSuperuser !== true) {
            throw new GisServiceError(403, 'Требуются права суперпользователя.', 'SUPERUSER_REQUIRED');
        }
        return user;
    }

    function statusPayload(setting) {
        return {
            configured: !!setting?.secret_value,
            fingerprint: setting?.secret_value ? keyFingerprint(setting.secret_value) : '',
            updatedAt: setting?.updated_at || '',
        };
    }

    async function getPublicStatus() {
        const setting = await readSetting();
        return { configured: !!setting?.secret_value };
    }

    async function getAdminStatus(authorization) {
        await requireSuperuser(authorization);
        return statusPayload(await readSetting({ force: true }));
    }

    async function setAdminKey(authorization, value) {
        const user = await requireSuperuser(authorization);
        const apiKey = normalize2gisApiKey(value);
        const url = new URL('/rest/v1/integration_secrets', `${databaseUrl}/`);
        url.searchParams.set('on_conflict', 'name');
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: serviceHeaders({
                'Content-Type': 'application/json',
                Prefer: 'resolution=merge-duplicates,return=representation',
            }),
            body: JSON.stringify({ name: SETTING_NAME, secret_value: apiKey,
                updated_at: new Date().toISOString(), updated_by: user.id }),
            cache: 'no-store',
            signal: withTimeout(timeoutMs),
        });
        if (!response.ok) throw new GisServiceError(503, 'Не удалось сохранить API-ключ 2ГИС.', 'SETTINGS_WRITE_FAILED');
        const rows = await response.json();
        cachedSetting = Array.isArray(rows) && rows[0] ? rows[0] : {
            secret_value: apiKey, updated_at: new Date().toISOString(), updated_by: user.id,
        };
        if (!cachedSetting.secret_value) cachedSetting.secret_value = apiKey;
        cacheExpiresAt = Date.now() + KEY_CACHE_MS;
        return statusPayload(cachedSetting);
    }

    async function clearAdminKey(authorization) {
        await requireSuperuser(authorization);
        const url = new URL('/rest/v1/integration_secrets', `${databaseUrl}/`);
        url.searchParams.set('name', `eq.${SETTING_NAME}`);
        const response = await fetchImpl(url, {
            method: 'DELETE',
            headers: serviceHeaders({ Prefer: 'return=minimal' }),
            cache: 'no-store',
            signal: withTimeout(timeoutMs),
        });
        if (!response.ok) throw new GisServiceError(503, 'Не удалось удалить API-ключ 2ГИС.', 'SETTINGS_DELETE_FAILED');
        cachedSetting = null;
        cacheExpiresAt = Date.now() + KEY_CACHE_MS;
        return statusPayload(null);
    }

    async function proxyItems(searchParams) {
        const type = String(searchParams.get('type') || '');
        const fields = ALLOWED_TYPES.get(type);
        if (!fields) throw new GisServiceError(400, 'Недопустимый тип данных 2ГИС.', 'INVALID_QUERY');
        const point = normalizePoint(searchParams.get('point'));
        const radius = parseInteger(searchParams.get('radius'), { min: 1, max: 500, name: 'radius' });
        const pageSize = parseInteger(searchParams.get('page_size'), { min: 1, max: 10, name: 'page_size' });
        const page = parseInteger(searchParams.get('page'), { min: 1, max: 5, name: 'page' });
        const sort = String(searchParams.get('sort') || '');
        if (sort && sort !== 'distance') throw new GisServiceError(400, 'Недопустимая сортировка 2ГИС.', 'INVALID_QUERY');
        const apiKey = await requireApiKey();
        const url = new URL('https://catalog.api.2gis.com/3.0/items');
        url.search = new URLSearchParams({ key: apiKey, point, radius: String(radius), type,
            page_size: String(pageSize), page: String(page), fields }).toString();
        if (sort) url.searchParams.set('sort', sort);
        const response = await fetchImpl(url, {
            headers: { Accept: 'application/json' },
            redirect: 'error',
            cache: 'no-store',
            signal: withTimeout(timeoutMs),
        });
        const body = await readLimitedBody(response, MAX_JSON_BYTES);
        if (response.ok) assertCatalogPayload(body);
        return {
            status: response.status,
            contentType: 'application/json; charset=utf-8',
            body,
        };
    }

    async function proxyTile({ z, x, y }) {
        const zoom = parseInteger(z, { min: 0, max: 20, name: 'z' });
        const maxCoordinate = 2 ** zoom - 1;
        const tileX = parseInteger(x, { min: 0, max: maxCoordinate, name: 'x' });
        const tileY = parseInteger(y, { min: 0, max: maxCoordinate, name: 'y' });
        const apiKey = await requireApiKey();
        const url = new URL(`https://tile0.maps.2gis.com/v2/tiles/online_sd/${zoom}/${tileX}/${tileY}.png`);
        url.searchParams.set('key', apiKey);
        const response = await fetchImpl(url, {
            headers: { Accept: 'image/png,image/*;q=0.8' },
            redirect: 'error',
            cache: 'no-store',
            signal: withTimeout(timeoutMs),
        });
        const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
        if (response.ok && !contentType.startsWith('image/')) {
            throw new GisServiceError(502, '2ГИС вернул некорректный тайл.', 'INVALID_UPSTREAM_TILE');
        }
        const body = await readLimitedBody(response, MAX_TILE_BYTES);
        return {
            status: response.status,
            contentType: contentType || 'application/octet-stream',
            body,
        };
    }

    return Object.freeze({
        getPublicStatus,
        getAdminStatus,
        setAdminKey,
        clearAdminKey,
        proxyItems,
        proxyTile,
        isBackendConfigured: () => !!(databaseUrl && serviceKey),
    });
}

export function createFixedWindowRateLimiter({ limit, windowMs = 60_000, now = () => Date.now() }) {
    const entries = new Map();
    return function consume(key) {
        const timestamp = now();
        const id = String(key || 'unknown');
        let entry = entries.get(id);
        if (!entry || timestamp >= entry.resetAt) {
            entry = { count: 0, resetAt: timestamp + windowMs };
            entries.set(id, entry);
        }
        entry.count += 1;
        if (entries.size > 5000) {
            for (const [entryKey, value] of entries) if (timestamp >= value.resetAt) entries.delete(entryKey);
        }
        return { allowed: entry.count <= limit, retryAfter: Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000)) };
    };
}
