import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkerBackend, fileHash, runClaimedJob, runContainer, validateClaim } from './worker.mjs';
const ID = '40000000-0000-0000-0000-000000000001';
const PROJECT = '10000000-0000-0000-0000-000000000001';
const HASH = createHash('sha256').update('original zip bytes').digest('hex');
const IMAGE = 'sha256:' + '1'.repeat(64);
async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'model-check-worker-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const wrapper = join(root, 'runner.py'); await writeFile(wrapper, '# test runner');
    const workDir = join(root, 'jobs'); await mkdir(workDir);
    const config = { wrapper, workDir, python: 'python3', timeout: 1, minFreeBytes: 0, heartbeatMs: 10 };
    const claim = { job: { id: ID, project_id: PROJECT, model_id: '30000000-0000-0000-0000-000000000001', engine_revision: 'test161', source_name: 'original.zip', source_path: `projects/${PROJECT}/original.zip`, source_revision: 'a'.repeat(32) }, lease_token: '50000000-0000-0000-0000-000000000001', engine: { revision: 'test161', checker_version: '1.6.1', image_id: IMAGE, wrapper_sha256: await fileHash(wrapper) } };
    const calls = [];
    const backend = { async rpc(name, body) { calls.push({ name, body }); return name === 'heartbeat_model_check' ? { active: true } : true; },
        async download(job, path) { await writeFile(path, 'original zip bytes'); return { sha256: HASH, bytes: 18 }; } };
    const containerRunner = async ({ source, output, sha256, leaseFile }) => {
        assert.equal(await fileHash(source), sha256); await readFile(leaseFile);
        await mkdir(join(output, 'job'), { recursive: true });
        await writeFile(join(output, 'job/report.json'), JSON.stringify({ status: 'completed', checker_version: '1.6.1', ruleset_id: 'moscow-npm-vpm-2026-08-18', source_sha256: sha256, input_unchanged: true, summary: { failed: 2, not_checked: 53 } }));
        await writeFile(join(output, 'container.json'), JSON.stringify({ image_id: IMAGE, exit_code: 0, input_unchanged: true, oom_killed: false }));
    };
    return { root, config, claim, calls, backend, containerRunner };
}
test('worker accepts only pinned 1.6.1 and canonical project source paths', async t => {
    const { claim } = await fixture(t); validateClaim(claim);
    for (const path of ['https://foreign.invalid/a.zip', `projects/${PROJECT}/../secret.zip`, `projects/${PROJECT}//a.zip`, 'projects/another-project/a.zip']) {
        assert.throws(() => validateClaim({ ...claim, job: { ...claim.job, source_path: path } }), /invalid_source_path/);
    }
    assert.throws(() => validateClaim({ ...claim, engine: { ...claim.engine, checker_version: '1.4' } }), /invalid_engine/);
    assert.throws(() => validateClaim({ ...claim, job: { ...claim.job, source_name: '../a.zip' } }), /invalid_source_name/);
});
test('download streams original bytes, hashes them, uses fixed origin and rejects redirects', async t => {
    const { root, claim } = await fixture(t); let called;
    const backend = createWorkerBackend({ supabaseUrl: 'https://backend.invalid', serviceKey: 'test-secret', fetchImpl: async (url, options) => { called = { url, options }; return new Response('original zip bytes'); } });
    const target = join(root, 'source.zip');
    const result = await backend.download(claim.job, target, new AbortController().signal);
    assert.equal(result.sha256, HASH); assert.equal(await readFile(target, 'utf8'), 'original zip bytes');
    assert.equal(called.url.origin, 'https://backend.invalid'); assert.equal(called.options.redirect, 'error');
    assert.equal(called.options.headers.Authorization, 'Bearer test-secret');
    await assert.rejects(backend.download(claim.job, target, new AbortController().signal), /EEXIST/);
});
test('download enforces both declared and streamed size limits', async t => {
    const { root, claim } = await fixture(t);
    for (const declared of [true, false]) {
        const backend = createWorkerBackend({ supabaseUrl: 'https://backend.invalid', serviceKey: 'test', fetchImpl: async () => new Response('too big', { headers: declared ? { 'Content-Length': '7' } : {} }) });
        await assert.rejects(backend.download(claim.job, join(root, `oversize-${declared}.zip`), new AbortController().signal, 2), /source_too_large/);
    }
});
test('worker publishes completed checks with failed/not_checked counts intact and cleans disk', async t => {
    const f = await fixture(t); assert.equal(await runClaimedJob(f.config, f.claim, f), true);
    const finished = f.calls.find(c => c.name === 'finish_model_check').body;
    assert.equal(finished.check_status, 'completed'); assert.equal(finished.check_sha256, HASH);
    assert.deepEqual(finished.check_report.summary, { failed: 2, not_checked: 53 });
    assert.equal(finished.check_report.worker_provenance.image_id, IMAGE);
    assert.deepEqual(await readdir(f.config.workDir), []);
});
test('changed wrapper reports incomplete before downloading or starting Blender', async t => {
    const f = await fixture(t); await writeFile(f.config.wrapper, '# changed');
    f.backend.download = async () => assert.fail('download must not start');
    await assert.rejects(runClaimedJob(f.config, f.claim, f), /wrapper_identity_mismatch/);
    assert.equal(f.calls.at(-1).body.check_status, 'incomplete'); assert.deepEqual(await readdir(f.config.workDir), []);
});
test('image/source mismatch or OOM never publishes a completed report', async t => {
    for (const bad of [{ image_id: 'sha256:' + '9'.repeat(64) }, { input_unchanged: false }, { oom_killed: true }]) {
        const f = await fixture(t); const original = f.containerRunner;
        f.containerRunner = async args => { await original(args); const p = join(args.output, 'container.json'); await writeFile(p, JSON.stringify({ ...JSON.parse(await readFile(p)), ...bad })); };
        await assert.rejects(runClaimedJob(f.config, f.claim, f), /report_provenance_mismatch/);
        assert.ok(f.calls.filter(c => c.name === 'finish_model_check').every(c => c.body.check_status === 'incomplete'));
        assert.deepEqual(await readdir(f.config.workDir), []);
    }
});
test('lease cancellation aborts a running checker, awaits cleanup and records incomplete', async t => {
    const f = await fixture(t); let started = false; let cleanup = false;
    f.backend.rpc = async (name, body) => { f.calls.push({ name, body }); return name === 'heartbeat_model_check' ? { active: true, cancel_requested: started } : true; };
    f.containerRunner = async ({ signal }) => { started = true; try { await delay(1000, undefined, { signal }); } finally { cleanup = true; } };
    await assert.rejects(runClaimedJob(f.config, f.claim, f), /worker_cancelled_or_lease_lost/);
    assert.ok(cleanup); assert.equal(f.calls.at(-1).body.check_status, 'incomplete'); assert.deepEqual(await readdir(f.config.workDir), []);
});
test('overlapping slow heartbeats are serialized and finish before workspace removal', async t => {
    const f = await fixture(t); let active = 0; let peak = 0;
    f.backend.rpc = async (name, body) => { f.calls.push({ name, body }); if (name !== 'heartbeat_model_check') return true;
        active++; peak = Math.max(peak, active); await delay(35); active--; return { active: true }; };
    const original = f.containerRunner; f.containerRunner = async args => { await delay(60); await original(args); };
    await runClaimedJob(f.config, f.claim, f); assert.equal(peak, 1); assert.equal(active, 0); assert.deepEqual(await readdir(f.config.workDir), []);
});
test('host runner does not inherit service credentials', async t => {
    const f = await fixture(t); const fake = join(f.root, 'fake-runner.mjs');
    await writeFile(fake, `import{writeFileSync}from'node:fs';writeFileSync(process.argv[3],JSON.stringify(Object.keys(process.env)));`);
    const envOutput = join(f.root, 'env.json'); const previous = process.env.SUPABASE_SERVICE_ROLE_KEY; process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-secret';
    try { await runContainer({ wrapper: fake, python: process.execPath, source: envOutput, output: f.root, job: f.claim.job, engine: f.claim.engine, sha256: HASH, leaseFile: 'lease', timeout: 1, signal: new AbortController().signal, logPath: join(f.root, 'log') }); }
    finally { if (previous === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous; }
    assert.ok(!JSON.parse(await readFile(envOutput)).includes('SUPABASE_SERVICE_ROLE_KEY'));
});

test('a deployment during download cannot replace the verified wrapper snapshot', async t => {
    const f = await fixture(t); const download = f.backend.download; const runner = f.containerRunner;
    f.backend.download = async (...args) => { await writeFile(f.config.wrapper, '# new deployment'); return download(...args); };
    f.containerRunner = async args => { assert.equal(await fileHash(args.wrapper), f.claim.engine.wrapper_sha256); assert.notEqual(args.wrapper, f.config.wrapper); await runner(args); };
    assert.equal(await runClaimedJob(f.config, f.claim, f), true);
});
test('report symlinks are rejected without reading files outside the workspace', async t => {
    const f = await fixture(t); const runner = f.containerRunner;
    f.containerRunner = async args => {
        await runner(args);
        const path = join(args.output, 'job/report.json'); const elsewhere = join(f.root, 'outside.json');
        await writeFile(elsewhere, await readFile(path)); await rm(path); await symlink(elsewhere, path);
    };
    await assert.rejects(runClaimedJob(f.config, f.claim, f), /invalid_report_file/);
    assert.equal(f.calls.at(-1).body.check_status, 'incomplete'); assert.deepEqual(await readdir(f.config.workDir), []);
});
test('Env classification is recorded as not_applicable, never as a passing compliance report', async t => {
    const f = await fixture(t); const runner = f.containerRunner;
    f.containerRunner = async args => { await runner(args); const path = join(args.output, 'job/report.json');
        const report = JSON.parse(await readFile(path)); await writeFile(path, JSON.stringify({ ...report, status: 'not_applicable', profile: 'ENV', checks: [], summary: {} })); };
    await runClaimedJob(f.config, f.claim, f);
    assert.equal(f.calls.at(-1).body.check_status, 'not_applicable');
    assert.deepEqual(f.calls.at(-1).body.check_report.summary, {});
});
