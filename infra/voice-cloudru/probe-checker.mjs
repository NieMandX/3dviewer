import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Root-only private staging acceptance. Run under lpm-cloudru-migration.lock.
// Never print Auth sessions, passwords or environment contents.
const envFile = async path => Object.fromEntries((await readFile(path, 'utf8'))
    .split('\n').filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
assert.equal(process.env.LPM_STAGING_PROBE, '1');
assert.equal(process.getuid(), 0);
assert.equal(execFileSync('hostname', { encoding: 'utf8' }).trim(), 'viewer-voice-01');
const apiEnv = await envFile('/etc/lpmview-checker/api.env');
const workerEnv = await envFile('/etc/lpmview-checker/worker.env');
const backend = workerEnv.SUPABASE_URL;
assert.equal(backend, 'https://10.0.0.5:8443');
assert.equal(apiEnv.SUPABASE_URL, backend);
assert.equal(apiEnv.HOST, '127.0.0.1');
assert.equal(apiEnv.PORT, '8081');
assert.equal('SUPABASE_SERVICE_ROLE_KEY' in apiEnv, false);
for (const path of ['/etc/lpmview-checker/api.env', '/etc/lpmview-checker/worker.env']) {
    const info = await stat(path);
    assert.equal(info.uid, 0);
    assert.equal(info.mode & 0o777, 0o600);
}
const serviceKey = workerEnv.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = apiEnv.SUPABASE_ANON_KEY;
assert.ok(serviceKey && anonKey && serviceKey !== anonKey);
const engine = {
    revision: 'agr161-20261026-cloudru-rootless2cpu4g', checker_version: '1.6.1',
    image_id: 'sha256:95e190c710cd4957ae68f06367268a8e60832920f5b2451445995fdb54a0bfa7',
    wrapper_sha256: 'fb882509386e3c66843dc5a8b3d17c51126c0573a88c1262f4185fce2d6a1a43', enabled: true,
};
assert.equal(workerEnv.MODEL_CHECK_ENGINE_REVISION, engine.revision);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(await readFile(workerEnv.MODEL_CHECK_WRAPPER)), engine.wrapper_sha256);
const source = '/var/lib/lpmview-checker/probes/0613_Nagatinskaya_1.zip';
const zip = await readFile(source);
const sourceHash = '3f1309302e73b609f457b1d3b199aacf20c2ceded67c43031127710dcecc96ee';
assert.equal(hash(zip), sourceHash);
const runId = randomUUID(), projectId = randomUUID(), roomId = randomUUID();
const modelIds = [randomUUID(), randomUUID()];
const path = `projects/${projectId}/0613_Nagatinskaya_1.zip`;
const userIds = [], checks = [];
let phase = 'preconditions', projectCreated = false, objectCreated = false;
let engineRegistered = false, workerStarted = false, succeeded = false;
let cleanupErrors = [];
const reportPath = '/var/backups/lpmview-migration/checker-queue-acceptance-20261026.json';
// Refuse to overwrite acceptance or unfinished fixture records.
await writeFile(reportPath, JSON.stringify({ runId, projectId, roomId, modelIds, sourcePath: path, status: 'started' }), { flag: 'wx', mode: 0o600 });

async function request(route, { token = serviceKey, method = 'GET', body, expected } = {}) {
    const response = await fetch(backend + route, {
        method, redirect: 'error', headers: {
            apikey: token === serviceKey ? serviceKey : anonKey, Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json', Prefer: 'return=representation',
        }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    assert.ok(expected ? response.status === expected : response.ok, `${phase}: backend HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
}
async function user(label) {
    const email = `checker-probe-${runId}-${label}@example.invalid`;
    const password = randomBytes(32).toString('base64url');
    const account = await request('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
    userIds.push(account.id);
    console.log(JSON.stringify({ fixtureUser: account.id, label }));
    return request('/auth/v1/token?grant_type=password', { token: anonKey, method: 'POST', body: { email, password } });
}
async function api(route, token, expected, body, origin = 'http://127.0.0.1:8090') {
    const response = await fetch('http://127.0.0.1:8081' + route, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, expected, `${phase}: checker HTTP ${response.status}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
}
function control(action) {
    execFileSync('systemctl', [action, 'lpmview-checker-worker.service'], { timeout: 65000, stdio: 'pipe' });
}
async function completed(id, token) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        const { job } = await api(`/jobs/${id}`, token, 200);
        if (job.status === 'completed') return (await api(`/jobs/${id}/report`, token, 200)).job;
        assert.ok(['queued', 'running'].includes(job.status), `Unexpected job status: ${job.status}`);
        await delay(1000);
    }
    throw new Error('Queue acceptance deadline exceeded');
}
function verifyReport(job) {
    assert.equal(job.source_sha256, sourceHash);
    assert.equal(job.engine_revision, engine.revision);
    assert.equal(job.report.input_unchanged, true);
    assert.equal(job.report.checker_version, '1.6.1');
    assert.equal(job.report.ruleset_id, 'moscow-npm-vpm-2026-08-18');
    assert.equal(job.report.source_sha256, sourceHash);
    assert.equal(job.report.worker_provenance.image_id, engine.image_id);
    assert.equal(job.report.worker_provenance.wrapper_sha256, engine.wrapper_sha256);
    assert.equal(job.report.worker_provenance.source_bytes, zip.length);
}
try {
    console.log(JSON.stringify({ fixtureRun: runId, fixtureProject: projectId, fixtureModels: modelIds }));
    assert.deepEqual(await request('/rest/v1/model_check_jobs?select=id'), []);
    assert.deepEqual(await request('/rest/v1/model_check_engines?select=revision'), []);
    const workerState = execFileSync('systemctl', ['show', 'lpmview-checker-worker.service', '-p', 'ActiveState', '--value'], { encoding: 'utf8' }).trim();
    assert.equal(workerState, 'inactive');
    phase = 'register-immutable-engine';
    await request('/rest/v1/model_check_engines', { method: 'POST', body: engine });
    engineRegistered = true;
    const owner = await user('owner'), outsider = await user('outsider');
    const guest = await request('/auth/v1/signup', { token: anonKey, method: 'POST', body: {} });
    assert.ok(guest.user.is_anonymous);
    userIds.push(guest.user.id);
    console.log(JSON.stringify({ fixtureUser: guest.user.id, label: 'guest' }));
    phase = 'create-private-fixtures';
    await request('/rest/v1/projects', { token: owner.access_token, method: 'POST', body: {
        id: projectId, slug: `checker-probe-${runId}`, name: 'Checker staging probe', owner_id: owner.user.id,
    } });
    projectCreated = true;
    await request('/rest/v1/rooms', { token: owner.access_token, method: 'POST', body: {
        id: roomId, project_id: projectId, slug: 'checker-probe', owner_id: owner.user.id,
    } });
    const uploaded = await fetch(`${backend}/storage/v1/object/models/${path}`, {
        method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${owner.access_token}`, 'Content-Type': 'application/zip', 'x-upsert': 'false' },
        body: zip, redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    assert.ok(uploaded.ok, `Upload HTTP ${uploaded.status}`);
    objectCreated = true;
    await uploaded.body?.cancel();
    await request('/rest/v1/project_models', { token: owner.access_token, method: 'POST', body: modelIds.map(id => ({
        id, project_id: projectId, name: '0613_Nagatinskaya_1.zip', url: 'storage://models/' + path, meta: { storagePath: path },
    })) });
    await request('/rest/v1/room_models', { token: owner.access_token, method: 'POST', body: { room_id: roomId, project_id: projectId, model_id: modelIds[0] } });
    const invite = await request('/rest/v1/rpc/ensure_room_invite', { token: owner.access_token, method: 'POST', body: { room_id: roomId } });
    await request('/rest/v1/rpc/join_room_by_invite', { token: guest.access_token, method: 'POST', body: { invite_token: invite[0].token } });
    phase = 'api-authorization';
    await api('/jobs', null, 401, { model_id: modelIds[0] });
    await api('/jobs', 'invalid-session', 401, { model_id: modelIds[0] });
    await api('/jobs', owner.access_token, 403, { model_id: modelIds[0] }, 'https://untrusted.invalid');
    await api('/jobs', outsider.access_token, 403, { model_id: modelIds[0] });
    await api('/jobs', guest.access_token, 403, { model_id: modelIds[0] });
    await api('/jobs', owner.access_token, 400, { model_id: modelIds[0], source_path: 'forged' });
    checks.push('real-password-and-anonymous-login', 'owner-only-create', 'origin', 'reject-source-spoofing');
    phase = 'dedup-and-queued-cancellation';
    const { job: cancelled } = await api('/jobs', owner.access_token, 202, { model_id: modelIds[0] });
    const duplicates = await Promise.all(Array.from({ length: 3 }, () => api('/jobs', owner.access_token, 202, { model_id: modelIds[0] })));
    assert.ok(duplicates.every(value => value.job.id === cancelled.id));
    await api(`/jobs/${cancelled.id}/cancel`, guest.access_token, 403, {});
    await api(`/jobs/${cancelled.id}`, outsider.access_token, 403);
    assert.deepEqual((await api(`/models/${modelIds[0]}/jobs`, outsider.access_token, 200)).jobs, []);
    assert.equal((await api(`/jobs/${cancelled.id}`, guest.access_token, 200)).job.id, cancelled.id);
    assert.equal((await api(`/jobs/${cancelled.id}/cancel`, owner.access_token, 200, {})).job.status, 'cancelled');
    checks.push('concurrent-dedup', 'queued-cancellation', 'guest-read-only', 'outsider-isolation');
    phase = 'real-worker-storage-zip-report';
    const { job: queued } = await api('/jobs', owner.access_token, 202, { model_id: modelIds[0] });
    assert.notEqual(queued.id, cancelled.id);
    workerStarted = true; control('start');
    const first = await completed(queued.id, owner.access_token);
    verifyReport(first);
    verifyReport((await api(`/jobs/${queued.id}/report`, guest.access_token, 200)).job);
    await api(`/jobs/${queued.id}/report`, outsider.access_token, 403);
    assert.equal((await api('/jobs', owner.access_token, 202, { model_id: modelIds[0] })).job.id, queued.id);
    checks.push('storage-download', 'real-blender-report', 'sha256-and-engine-provenance', 'completed-dedup');
    phase = 'worker-restart-and-room-isolation';
    control('restart');
    const { job: secondQueued } = await api('/jobs', owner.access_token, 202, { model_id: modelIds[1] });
    await api(`/jobs/${secondQueued.id}`, guest.access_token, 403);
    verifyReport(await completed(secondQueued.id, owner.access_token));
    checks.push('worker-restart', 'room-scoped-report');
    assert.equal(hash(await readFile(source)), sourceHash);
    assert.equal((await fetch('http://127.0.0.1:8090/model-check/health')).status, 503);
    checks.push('original-zip-unchanged', 'public-proxy-still-blocked');
    succeeded = true;
} catch (_) {
    process.exitCode = 1;
    console.error(JSON.stringify({ ok: false, failedPhase: phase }));
} finally {
    async function cleanup(label, action) { try { await action(); } catch (_) { cleanupErrors.push(label); } }
    // Stop the only consumer before deleting this run's queued/source fixtures.
    if (workerStarted) await cleanup('stop-worker', async () => control('stop'));
    if (!cleanupErrors.includes('stop-worker')) {
        if (objectCreated) await cleanup('storage-object', () => request('/storage/v1/object/models', { method: 'DELETE', body: { prefixes: [path] } }));
        if (projectCreated) await cleanup('fixture-project', () => request(`/rest/v1/projects?id=eq.${projectId}`, { method: 'DELETE' }));
        for (const id of userIds) await cleanup(`fixture-user:${id}`, () => request(`/auth/v1/admin/users/${id}`, { method: 'DELETE' }));
    }
    if (engineRegistered && !succeeded) await cleanup('disable-engine', () => request(`/rest/v1/model_check_engines?revision=eq.${engine.revision}`, { method: 'PATCH', body: { enabled: false } }));
    await cleanup('empty-queue', async () => assert.deepEqual(await request('/rest/v1/model_check_jobs?select=id'), []));
    await cleanup('workspace-clean', async () => assert.deepEqual(await readdir(workerEnv.MODEL_CHECK_WORK_DIR), []));
    if (succeeded && !cleanupErrors.length) await cleanup('restart-accepted-worker', async () => control('start'));
    const ok = succeeded && !cleanupErrors.length;
    if (!ok) process.exitCode = 1;
    const result = { ok, runId, projectId, roomId, modelIds, userIds, cleanupErrors,
        failedPhase: succeeded ? null : phase, checks, engine, sourceBytes: zip.length, sourceHash,
        publicProxyBlocked: true, browserTested: false, largeZipTested: false, runningCancellationTested: false,
        recordedAt: new Date().toISOString() };
    await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(result));
}
