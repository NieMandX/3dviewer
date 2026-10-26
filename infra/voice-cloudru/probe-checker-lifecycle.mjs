import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Root-only acceptance under lpm-cloudru-migration.lock. Never log credentials.
assert.equal(process.getuid(), 0);
assert.equal(process.env.LPM_STAGING_PROBE, '1');
assert.equal(execFileSync('hostname', { encoding: 'utf8' }).trim(), 'viewer-voice-01');
const envFile = async path => Object.fromEntries((await readFile(path, 'utf8')).split('\n')
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const apiEnv = await envFile('/etc/lpmview-checker/api.env');
const workerEnv = await envFile('/etc/lpmview-checker/worker.env');
const backend = workerEnv.SUPABASE_URL, serviceKey = workerEnv.SUPABASE_SERVICE_ROLE_KEY, anonKey = apiEnv.SUPABASE_ANON_KEY;
assert.equal(backend, 'https://10.0.0.5:8443');
assert.equal(apiEnv.SUPABASE_URL, backend);
assert.equal(apiEnv.HOST, '127.0.0.1'); assert.equal(apiEnv.PORT, '8081');
assert.equal('SUPABASE_SERVICE_ROLE_KEY' in apiEnv, false);
const source = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.match(source.path, /^projects\/[a-f0-9-]{36}\/[^/]+\.zip$/);
assert.match(source.sha256, /^[a-f0-9]{64}$/);
assert.ok(source.bytes >= 100 * 1024 ** 2 && source.bytes <= 2 * 1024 ** 3);
assert.equal(basename(source.name), source.name);
assert.ok(source.name.endsWith('.zip'));
const runId = randomUUID(), projectId = randomUUID(), roomId = randomUUID();
const models = Array.from({ length: 5 }, () => randomUUID());
const prefix = `projects/${projectId}/`, largePath = prefix + source.name;
const smallPath = prefix + '0613_Nagatinskaya_1.zip', badPath = prefix + 'broken.zip';
const small = await readFile('/var/lib/lpmview-checker/probes/0613_Nagatinskaya_1.zip');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const smallHash = '3f1309302e73b609f457b1d3b199aacf20c2ceded67c43031127710dcecc96ee';
assert.equal(hash(small), smallHash);
const reportPath = `/var/backups/lpmview-migration/checker-lifecycle-${runId}.json`;
const artifacts = { runId, projectId, roomId, models, users: [], paths: [], jobs: [], checks: [], samples: [], source };
let phase = 'preconditions', succeeded = false, ownsWorker = false, projectCreated = false, owner;
await writeFile(reportPath, JSON.stringify(artifacts), { flag: 'wx', mode: 0o600 });
const save = () => writeFile(reportPath, JSON.stringify(artifacts, null, 2) + '\n', { mode: 0o600 });

async function request(path, { method = 'GET', token = serviceKey, body, timeout = 20000 } = {}) {
    const r = await fetch(backend + path, { method, redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: { apikey: token === serviceKey ? serviceKey : anonKey, Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(r.ok, `${phase}: backend HTTP ${r.status}`);
    return r.status === 204 ? null : r.json();
}
async function api(path, body, expected = 200) {
    const r = await fetch('http://127.0.0.1:8081' + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${owner.access_token}`, Origin: 'http://127.0.0.1:8090', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(r.status, expected, `${phase}: checker HTTP ${r.status}`);
    return r.json();
}
function control(action) { execFileSync('systemctl', [action, 'lpmview-checker-worker.service'], { stdio: 'pipe', timeout: 65000 }); }
function docker(args) {
    return execFileSync('runuser', ['-u', 'lpm-checker', '--', 'env', 'XDG_RUNTIME_DIR=/run/user/1001',
        'DOCKER_HOST=unix:///run/user/1001/docker.sock', 'docker', ...args], { encoding: 'utf8', timeout: 20000 });
}
const containers = () => docker(['ps', '-aq', '--filter', 'label=lpmview.model-checker=true']).trim().split(/\s+/).filter(Boolean);
async function observe(jobId) {
    const ids = containers(); assert.ok(ids.length <= 1, 'More than one checker container');
    if (!ids.length) return null;
    let info;
    try { info = JSON.parse(docker(['inspect', ids[0]]))[0]; }
    catch (error) { if (!containers().includes(ids[0])) return null; throw error; }
    const h = info.HostConfig;
    const observedJob = artifacts.jobs.find(j => info.Name.includes(j.id.replaceAll('-', '')));
    assert.ok(observedJob, 'Unrelated checker execution');
    assert.equal(info.Image, artifacts.engine.image_id);
    assert.equal(h.NetworkMode, 'none'); assert.equal(h.ReadonlyRootfs, true);
    assert.equal(h.Memory, 4 * 1024 ** 3); assert.equal(h.MemorySwap, h.Memory);
    assert.equal(h.NanoCpus, 2e9);
    if (!artifacts.samples.some(s => s.jobId === observedJob.id)) artifacts.samples.push({ jobId: observedJob.id, image: info.Image,
        network: h.NetworkMode, readonly: h.ReadonlyRootfs, memoryBytes: h.Memory, nanoCpus: h.NanoCpus });
    return observedJob.id === jobId && info.State.Running;
}
async function workspaceClean() {
    for (let i = 0; i < 40; i++) {
        if (!(await readdir(workerEnv.MODEL_CHECK_WORK_DIR)).length
            && !(await readdir('/var/lib/lpmview-checker/work/tmp')).length && !containers().length) return;
        await delay(250);
    }
    assert.fail('Checker workspace/container was not cleaned');
}
async function submit(index) {
    const { job } = await api('/jobs', { model_id: models[index] }, 202);
    artifacts.jobs.push({ id: job.id, modelId: models[index], startedAt: new Date().toISOString() });
    await save(); return job.id;
}
async function terminal(id, timeout = 720000) {
    const start = Date.now(); let previous;
    while (Date.now() - start < timeout) {
        const { job } = await api(`/jobs/${id}`);
        if (previous !== `${job.status}/${job.stage}`) {
            console.log(JSON.stringify({ phase, status: job.status, stage: job.stage })); previous = `${job.status}/${job.stage}`;
        }
        if (!['queued', 'running'].includes(job.status)) {
            Object.assign(artifacts.jobs.find(j => j.id === id), { status: job.status, stage: job.stage,
                errorCode: job.error_code, seconds: (Date.now() - start) / 1000 });
            await save(); return job;
        }
        await observe(id); await delay(750);
    }
    assert.fail('Job deadline exceeded');
}
async function blenderRunning(id) {
    const start = Date.now();
    while (Date.now() - start < 180000) {
        const { job } = await api(`/jobs/${id}`);
        assert.ok(['queued', 'running'].includes(job.status), 'Job ended before intervention');
        if (job.status === 'running' && await observe(id)) {
            for (const directory of await readdir(workerEnv.MODEL_CHECK_WORK_DIR)) {
                try {
                    const path = join(workerEnv.MODEL_CHECK_WORK_DIR, directory, 'result/job/job.json');
                    if ((await stat(path)).size > 65536) continue;
                    if (JSON.parse(await readFile(path, 'utf8')).status === 'blender_checks') return;
                } catch (_) {}
            }
        }
        await delay(300);
    }
    assert.fail('Blender stage not observed');
}
async function verifyReport(id, expectedHash, expectedBytes) {
    const job = (await api(`/jobs/${id}/report`)).job;
    assert.equal(job.source_sha256, expectedHash);
    assert.equal(job.report.source_sha256, expectedHash); assert.equal(job.report.input_unchanged, true);
    assert.equal(job.engine_revision, artifacts.engine.revision);
    assert.equal(job.report.worker_provenance.image_id, artifacts.engine.image_id);
    assert.equal(job.report.worker_provenance.wrapper_sha256, artifacts.engine.wrapper_sha256);
    assert.equal(job.report.worker_provenance.source_bytes, expectedBytes);
    artifacts.jobs.find(j => j.id === id).summary = job.report.summary;
    await writeFile(reportPath.replace('.json', `-${id}-report.json`), JSON.stringify(job.report), { flag: 'wx', mode: 0o600 });
}
async function storageHash(path) {
    const r = await fetch(backend + '/storage/v1/object/authenticated/models/' + path.split('/').map(encodeURIComponent).join('/'), {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, redirect: 'error', signal: AbortSignal.timeout(180000),
    });
    assert.ok(r.ok); const h = createHash('sha256'); let bytes = 0;
    for await (const chunk of r.body) { h.update(chunk); bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 3); }
    return { sha256: h.digest('hex'), bytes };
}
try {
    assert.deepEqual(await request('/rest/v1/model_check_jobs?select=id'), []);
    assert.deepEqual(await request('/rest/v1/model_check_leases?select=job_id'), []);
    const engines = await request('/rest/v1/model_check_engines?select=*');
    assert.equal(engines.length, 1); artifacts.engine = engines[0];
    assert.equal(artifacts.engine.revision, workerEnv.MODEL_CHECK_ENGINE_REVISION);
    assert.equal(artifacts.engine.enabled, true);
    assert.equal(hash(await readFile(workerEnv.MODEL_CHECK_WRAPPER)), artifacts.engine.wrapper_sha256);
    assert.equal(execFileSync('systemctl', ['is-active', 'lpmview-checker-worker.service'], { encoding: 'utf8' }).trim(), 'active');
    await workspaceClean(); ownsWorker = true;
    phase = 'fixture-setup';
    const email = `checker-lifecycle-${runId}@example.invalid`, password = randomBytes(32).toString('base64url');
    const account = await request('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
    artifacts.users.push(account.id); await save();
    owner = await request('/auth/v1/token?grant_type=password', { token: anonKey, method: 'POST', body: { email, password } });
    await request('/rest/v1/projects', { token: owner.access_token, method: 'POST', body: { id: projectId,
        slug: `checker-lifecycle-${runId}`, name: 'Checker lifecycle probe', owner_id: account.id } });
    projectCreated = true;
    await request('/rest/v1/rooms', { token: owner.access_token, method: 'POST', body: { id: roomId,
        project_id: projectId, slug: 'lifecycle', owner_id: account.id } });
    artifacts.paths.push(largePath); await save();
    await request('/storage/v1/object/copy', { method: 'POST', timeout: 180000,
        body: { bucketId: 'models', sourceKey: source.path, destinationKey: largePath } });
    assert.deepEqual(await storageHash(largePath), { sha256: source.sha256, bytes: source.bytes });
    for (const [path, bytes] of [[smallPath, small], [badPath, Buffer.from('Deliberately invalid ZIP for isolated error acceptance\n')]]) {
        artifacts.paths.push(path); await save();
        const r = await fetch(backend + '/storage/v1/object/models/' + path, { method: 'POST',
            headers: { apikey: anonKey, Authorization: `Bearer ${owner.access_token}`, 'Content-Type': 'application/zip', 'x-upsert': 'false' },
            body: bytes, redirect: 'error', signal: AbortSignal.timeout(30000) });
        assert.ok(r.ok); await r.body?.cancel();
    }
    const paths = [largePath, largePath, badPath, largePath, smallPath];
    await request('/rest/v1/project_models', { token: owner.access_token, method: 'POST', body: models.map((id, index) => ({
        id, project_id: projectId, name: basename(paths[index]), url: 'storage://models/' + paths[index], meta: { storagePath: paths[index] },
    })) });
    await request('/rest/v1/room_models', { token: owner.access_token, method: 'POST', body: models.map(id => ({ room_id: roomId, project_id: projectId, model_id: id })) });
    phase = 'large-zip-completion';
    const largeJob = await submit(0);
    assert.equal((await terminal(largeJob)).status, 'completed');
    await verifyReport(largeJob, source.sha256, source.bytes); await workspaceClean();
    artifacts.checks.push('large-zip-report-and-provenance', 'runtime-isolation', 'completion-cleanup'); await save();
    phase = 'running-cancellation';
    const cancelled = await submit(1); await blenderRunning(cancelled);
    const cancelAt = Date.now();
    const cancellation = (await api(`/jobs/${cancelled}/cancel`, {})).job;
    assert.equal(cancellation.cancel_requested, true);
    assert.equal((await terminal(cancelled, 65000)).status, 'cancelled');
    artifacts.cancelSeconds = (Date.now() - cancelAt) / 1000;
    await api(`/jobs/${cancelled}/report`, undefined, 409); await workspaceClean();
    artifacts.checks.push('cancelled-while-blender-running', 'cancelled-report-unavailable', 'cancellation-cleanup'); await save();
    phase = 'invalid-zip';
    const broken = await submit(2); assert.equal((await terminal(broken, 120000)).status, 'incomplete');
    await api(`/jobs/${broken}/report`, undefined, 409); await workspaceClean();
    artifacts.checks.push('invalid-zip-incomplete-not-green', 'failure-cleanup'); await save();
    phase = 'worker-crash-and-recovery';
    const crashed = await submit(3); await blenderRunning(crashed);
    const recovered = await submit(4);
    execFileSync('systemctl', ['kill', '--kill-whom=main', '--signal=SIGKILL', 'lpmview-checker-worker.service'], { stdio: 'pipe', timeout: 10000 });
    // Systemd must restart the existing single worker; do not start a second one.
    const failed = await terminal(crashed, 100000);
    assert.equal(failed.status, 'incomplete'); assert.equal(failed.error_code, 'worker_lease_expired');
    await api(`/jobs/${crashed}/report`, undefined, 409);
    assert.equal((await terminal(recovered, 120000)).status, 'completed');
    await verifyReport(recovered, smallHash, small.length); await workspaceClean();
    artifacts.checks.push('crashed-worker-lease-expired', 'systemd-restart-next-job-completed', 'crash-cleanup');
    assert.deepEqual(await request('/rest/v1/model_check_leases?select=job_id'), []);
    assert.deepEqual(await storageHash(source.path), { sha256: source.sha256, bytes: source.bytes });
    assert.equal((await fetch('http://127.0.0.1:8090/model-check/health')).status, 503);
    artifacts.checks.push('original-source-unchanged', 'no-stale-leases', 'public-proxy-still-blocked');
    succeeded = true;
} catch (error) {
    process.exitCode = 1;
    artifacts.failure = { phase, kind: error.code || error.name,
        message: error.code === 'ERR_ASSERTION' ? error.message.slice(0, 180) : 'See protected service evidence' };
} finally {
    const cleanupErrors = [];
    async function cleanup(label, action) { try { await action(); } catch (_) { cleanupErrors.push(label); } }
    if (ownsWorker) await cleanup('stop-worker', async () => control('stop'));
    if (!cleanupErrors.includes('stop-worker')) {
        for (const path of artifacts.paths) await cleanup('storage:' + basename(path), () => request('/storage/v1/object/models', { method: 'DELETE', body: { prefixes: [path] } }));
        if (projectCreated) await cleanup('project', () => request(`/rest/v1/projects?id=eq.${projectId}`, { method: 'DELETE' }));
        for (const id of artifacts.users) await cleanup('user:' + id, () => request(`/auth/v1/admin/users/${id}`, { method: 'DELETE' }));
        if (ownsWorker) await cleanup('workspace', workspaceClean);
    }
    if (ownsWorker && !cleanupErrors.length) await cleanup('restart-original-worker', async () => control('start'));
    artifacts.ok = succeeded && !cleanupErrors.length;
    artifacts.cleanupErrors = cleanupErrors; artifacts.recordedAt = new Date().toISOString();
    artifacts.browserTested = false; artifacts.productionChanged = false;
    await save();
    console.log(JSON.stringify({ ok: artifacts.ok, reportPath, checks: artifacts.checks,
        failure: artifacts.failure, cleanupErrors, cancelSeconds: artifacts.cancelSeconds,
        jobs: artifacts.jobs.map(({ status, stage, errorCode, seconds }) => ({ status, stage, errorCode, seconds })) }));
    if (!artifacts.ok) process.exitCode = 1;
}
