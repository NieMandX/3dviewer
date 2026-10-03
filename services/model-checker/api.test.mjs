import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer, createModelCheckService, createRateLimiter, CheckApiError } from './api.mjs';
const MODEL = '30000000-0000-0000-0000-000000000001';
const JOB = '40000000-0000-0000-0000-000000000001';
function backend(handler = () => ({ id: JOB, status: 'queued' })) {
    const calls = [];
    const service = createModelCheckService({ supabaseUrl: 'https://backend.invalid', anonKey: 'public-test-key', fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify(await handler(url, options)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
    return { calls, service };
}
async function listen(t, service) {
    const server = createApiServer({ service, allowedOrigins: ['http://127.0.0.1:5173'] });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    return `http://127.0.0.1:${server.address().port}`;
}
const auth = { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' };
test('forwards user JWT, never supplies a service-role identity', async () => {
    const { service, calls } = backend(); await service.create('user-token', MODEL);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer user-token');
    assert.equal(calls[0].options.headers.apikey, 'public-test-key');
    assert.deepEqual(JSON.parse(calls[0].options.body), { check_model_id: MODEL });
    assert.equal(calls[0].url.origin, 'https://backend.invalid');
    assert.equal(calls[0].options.redirect, 'error');
});
test('UUID validation prevents paths/filters from entering upstream requests', async () => {
    const { service, calls } = backend();
    for (const bad of ['../secrets', `${MODEL}&select=*`, 'https://evil.invalid/', null]) {
        assert.throws(() => service.create('user-token', bad), { status: 400 });
    }
    assert.equal(calls.length, 0);
});
test('polling excludes report; report request explicitly asks for it', async () => {
    const { service, calls } = backend();
    await service.get('token', JOB); await service.get('token', JOB, true); await service.list('token', MODEL);
    assert.equal(JSON.parse(calls[0].options.body).include_report, false);
    assert.equal(JSON.parse(calls[1].options.body).include_report, true);
    assert.ok(!calls[2].url.searchParams.get('select').split(',').includes('report'));
});
test('maps permission/queue/configuration errors without leaking upstream text', async () => {
    for (const [code, status] of [['42501', 403], ['22023', 400], ['54000', 429], ['55000', 503], ['XX000', 502]]) {
        const service = createModelCheckService({ supabaseUrl: 'https://backend.invalid', anonKey: 'public', fetchImpl: async () => new Response(JSON.stringify({ code, message: 'private backend diagnostics' }), { status: 400 }) });
        await assert.rejects(service.get('token', JOB), error => error instanceof CheckApiError && error.status === status && !error.message.includes('private'));
    }
});
test('HTTP rejects missing bearer, unlisted origin, arbitrary fields and content type', async t => {
    const { service, calls } = backend(); const url = await listen(t, service);
    assert.equal((await fetch(url + '/jobs/' + JOB)).status, 401);
    assert.equal((await fetch(url + '/jobs/' + JOB, { headers: { ...auth, Origin: 'https://evil.invalid' } })).status, 403);
    assert.equal((await fetch(url + '/jobs', { method: 'POST', headers: auth, body: JSON.stringify({ model_id: MODEL, url: 'https://evil.invalid/' }) })).status, 400);
    assert.equal((await fetch(url + '/jobs', { method: 'POST', headers: { Authorization: auth.Authorization }, body: '{}' })).status, 415);
    assert.equal(calls.length, 0);
});
test('HTTP creates, lists, cancels and reads a report via fixed routes', async t => {
    const { service } = backend((url, options) => url.pathname.endsWith('get_model_check') ? { id: JOB, status: 'completed', source_current: false, report: { checker_version: '1.6.1' } } : { id: JOB });
    const url = await listen(t, service);
    const created = await fetch(url + '/jobs', { method: 'POST', headers: { ...auth, Origin: 'http://127.0.0.1:5173' }, body: JSON.stringify({ model_id: MODEL }) });
    assert.equal(created.status, 202); assert.equal(created.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:5173');
    assert.equal(created.headers.get('Cache-Control'), 'no-store');
    assert.equal((await fetch(url + `/models/${MODEL}/jobs`, { headers: auth })).status, 200);
    assert.equal((await fetch(url + `/jobs/${JOB}/cancel`, { method: 'POST', headers: auth, body: '{}' })).status, 200);
    const report = await (await fetch(url + `/jobs/${JOB}/report`, { headers: auth })).json();
    assert.equal(report.job.source_current, false, 'historical report must retain stale-version marker');
});
test('unfinished jobs cannot return a completed report', async t => {
    const { service } = backend(() => ({ id: JOB, status: 'running', report: null }));
    const url = await listen(t, service);
    assert.equal((await fetch(url + `/jobs/${JOB}/report`, { headers: auth })).status, 409);
});
test('upstream network failure becomes a bounded generic error', async t => {
    const service = createModelCheckService({ supabaseUrl: 'https://backend.invalid', anonKey: 'public', fetchImpl: async () => { throw new Error('secret-url?token=private'); } });
    const url = await listen(t, service);
    const response = await fetch(url + '/jobs/' + JOB, { headers: auth });
    assert.equal(response.status, 502); assert.ok(!(await response.text()).includes('private'));
});
test('rate limiter bounds clients, rejects bursts and releases expired entries', () => {
    let time = 0;
    const allow = createRateLimiter({ limit: 2, maxKeys: 2, windowMs: 100, now: () => time });
    assert.equal(allow('a'), true); assert.equal(allow('a'), true); assert.equal(allow('a'), false);
    assert.equal(allow('b'), true); assert.equal(allow('c'), false);
    time = 100; assert.equal(allow('c'), true); assert.equal(allow('a'), true);
});
test('health needs no credentials; API ignores forwarded IP unless proxy trust is configured', async t => {
    const seen = [];
    const server = createApiServer({ service: {}, rateLimiter: ip => { seen.push(ip); return seen.length === 1; } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}/health`;
    assert.equal((await fetch(url, { headers: { 'X-Lpmview-Client-IP': '192.0.2.1' } })).status, 200);
    const limited = await fetch(url);
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '60');
    assert.deepEqual(seen, ['127.0.0.1', '127.0.0.1']);
});
test('private API listener uses validated proxy IP and releases concurrency after a request', async t => {
    const seen = []; let finish;
    const server = createApiServer({ service: { get: () => new Promise(resolve => { finish = resolve; }) }, trustProxy: true, maxInFlight: 1, rateLimiter: ip => { seen.push(ip); return true; } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const pending = fetch(url + '/jobs/' + JOB, { headers: { ...auth, 'X-Lpmview-Client-IP': '192.0.2.1' } });
    while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await fetch(url + '/health')).status, 429);
    finish({ id: JOB }); assert.equal((await pending).status, 200);
    assert.equal((await fetch(url + '/health')).status, 200);
    assert.equal(seen[0], '192.0.2.1');
});
