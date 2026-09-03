import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixedWindowRateLimiter, createGisService, GisServiceError, normalize2gisApiKey } from './gis-service.mjs';

const serviceKey = 'service-role-test-token';
const apiKey = '2gis-production-test-key';

function makeFetch({ superuser = true, setting = apiKey } = {}) {
    const calls = [];
    const fetchImpl = async (input, options = {}) => {
        const url = new URL(input);
        calls.push({ url, options });
        if (url.pathname === '/auth/v1/user') {
            return Response.json({ id: 'admin-id', email: 'admin@example.com', is_anonymous: false });
        }
        if (url.pathname === '/rest/v1/rpc/is_superuser') return Response.json(superuser);
        if (url.pathname === '/rest/v1/integration_secrets' && options.method === 'POST') {
            const row = JSON.parse(options.body);
            setting = row.secret_value;
            return Response.json([{ ...row }]);
        }
        if (url.pathname === '/rest/v1/integration_secrets' && options.method === 'DELETE') {
            setting = '';
            return new Response(null, { status: 204 });
        }
        if (url.pathname === '/rest/v1/integration_secrets') {
            return Response.json(setting ? [{ secret_value: setting, updated_at: '2026-09-03T12:00:00Z' }] : []);
        }
        if (url.hostname === 'catalog.api.2gis.com') {
            return Response.json({ meta: { code: 200 }, result: { items: [], total: 0 } });
        }
        if (url.hostname === 'tile0.maps.2gis.com') {
            return new Response(new Uint8Array([137, 80, 78, 71]), {
                headers: { 'Content-Type': 'image/png' },
            });
        }
        throw new Error(`Unexpected request: ${url}`);
    };
    return { fetchImpl, calls };
}

function createService(options = {}) {
    const fake = makeFetch(options);
    return {
        service: createGisService({
            supabaseUrl: 'https://supabase.example',
            serviceRoleKey: serviceKey,
            fetchImpl: fake.fetchImpl,
        }),
        calls: fake.calls,
    };
}

test('2GIS key validation rejects short and whitespace-bearing values', () => {
    assert.throws(() => normalize2gisApiKey('short'), GisServiceError);
    assert.throws(() => normalize2gisApiKey('valid-looking key with spaces'), GisServiceError);
    assert.equal(normalize2gisApiKey(apiKey), apiKey);
});

test('catalog proxy exposes only the viewer allowlist and keeps the key server-side', async () => {
    const { service, calls } = createService();
    const query = new URLSearchParams({
        point: '37.6176,55.7558', radius: '500', type: 'building', page_size: '10', page: '1',
        fields: 'items.secret_field',
    });
    const result = await service.proxyItems(query);
    assert.equal(result.status, 200);
    const upstream = calls.find((call) => call.url.hostname === 'catalog.api.2gis.com').url;
    assert.equal(upstream.searchParams.get('key'), apiKey);
    assert.equal(upstream.searchParams.get('fields'), 'items.address,items.adm_div,items.geometry.hover');
    assert.equal(new TextDecoder().decode(result.body).includes(apiKey), false);
    await assert.rejects(() => service.proxyItems(new URLSearchParams({
        point: '37.6,55.7', radius: '501', type: 'building', page_size: '10', page: '1',
    })), (error) => error instanceof GisServiceError && error.status === 400);
    await assert.rejects(() => service.proxyItems(new URLSearchParams({
        point: '37.6,55.7', radius: '500', type: 'firm', page_size: '10', page: '1',
    })), (error) => error instanceof GisServiceError && error.status === 400);
});

test('tile proxy validates coordinates and relays only an image body', async () => {
    const { service, calls } = createService();
    const result = await service.proxyTile({ z: '17', x: '79198', y: '40975' });
    assert.equal(result.status, 200);
    assert.equal(result.contentType, 'image/png');
    assert.equal(calls.some((call) => call.url.hostname === 'tile0.maps.2gis.com'
        && call.url.searchParams.get('key') === apiKey), true);
    await assert.rejects(() => service.proxyTile({ z: '17', x: '-1', y: '0' }), GisServiceError);
});

test('admin can replace and clear the key without receiving its value', async () => {
    const { service } = createService();
    const authorization = 'Bearer user-access-token';
    const initial = await service.getAdminStatus(authorization);
    assert.equal(initial.configured, true);
    assert.equal(JSON.stringify(initial).includes(apiKey), false);
    const updated = await service.setAdminKey(authorization, 'replacement-2gis-key');
    assert.equal(updated.configured, true);
    assert.equal(JSON.stringify(updated).includes('replacement-2gis-key'), false);
    const cleared = await service.clearAdminKey(authorization);
    assert.deepEqual(cleared, { configured: false, fingerprint: '', updatedAt: '' });
});

test('non-superuser cannot read or change integration settings', async () => {
    const { service } = createService({ superuser: false });
    await assert.rejects(() => service.getAdminStatus('Bearer ordinary-user'),
        (error) => error instanceof GisServiceError && error.status === 403);
});

test('public calls fail closed when the backend or key is absent', async () => {
    const missingBackend = createGisService();
    await assert.rejects(() => missingBackend.getPublicStatus(),
        (error) => error instanceof GisServiceError && error.status === 503);
    const { service } = createService({ setting: '' });
    await assert.rejects(() => service.proxyTile({ z: '1', x: '1', y: '1' }),
        (error) => error instanceof GisServiceError && error.code === 'API_KEY_NOT_CONFIGURED');
});

test('fixed-window rate limiter resets deterministically', () => {
    let now = 0;
    const consume = createFixedWindowRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    assert.equal(consume('client').allowed, true);
    assert.equal(consume('client').allowed, true);
    assert.equal(consume('client').allowed, false);
    now = 1000;
    assert.equal(consume('client').allowed, true);
});
