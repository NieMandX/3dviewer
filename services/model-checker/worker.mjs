import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ZIP = 2 * 1024 ** 3;
const MAX_REPORT = 4 * 1024 ** 2;
async function readJSONFile(path, maxBytes, signal) {
    const info = await lstat(path);
    if (!info.isFile() || info.size > maxBytes) throw new Error('invalid_report_file');
    return JSON.parse(await readFile(path, { encoding: 'utf8', signal }));
}
export async function fileHash(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}
export function validateClaim(claim) {
    const { job, engine, lease_token: lease } = claim || {};
    if (!job || !engine || !UUID.test(job.id) || !UUID.test(job.project_id) || !UUID.test(job.model_id) || !UUID.test(lease)) throw new Error('invalid_claim');
    if (engine.checker_version !== '1.6.1' || engine.revision !== job.engine_revision || !/^sha256:[a-f0-9]{64}$/.test(engine.image_id) || !/^[a-f0-9]{64}$/.test(engine.wrapper_sha256)) throw new Error('invalid_engine');
    if (typeof job.source_name !== 'string' || basename(job.source_name) !== job.source_name || /[\\/\x00-\x1f\x7f]/.test(job.source_name) || !job.source_name.endsWith('.zip') || job.source_name.length > 255) throw new Error('invalid_source_name');
    if (typeof job.source_path !== 'string' || !job.source_path.startsWith(`projects/${job.project_id}/`) || /[\\\x00-\x1f\x7f]/.test(job.source_path) || job.source_path.split('/').some(s => !s || s === '.' || s === '..') || job.source_path.length > 1024) throw new Error('invalid_source_path');
    if (typeof job.source_revision !== 'string' || !/^[a-f0-9]{32}$/.test(job.source_revision)) throw new Error('invalid_source_revision');
    return claim;
}
export function createWorkerBackend({ supabaseUrl, serviceKey, fetchImpl = fetch }) {
    const base = new URL(supabaseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('invalid_backend_url');
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
    return {
        async rpc(name, body, signal) {
            const response = await fetchImpl(new URL('/rest/v1/rpc/' + name, base), {
                method: 'POST', redirect: 'error', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
                signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
            });
            if (!response.ok) throw new Error('queue_request_failed');
            return response.json();
        },
        async download(job, target, signal, maxBytes = MAX_ZIP) {
            const url = new URL('/storage/v1/object/authenticated/models/' + job.source_path.split('/').map(encodeURIComponent).join('/'), base);
            const response = await fetchImpl(url, { headers, redirect: 'error', signal });
            if (!response.ok || !response.body) throw new Error('source_download_failed');
            const declared = Number(response.headers.get('content-length'));
            if (Number.isFinite(declared) && declared > maxBytes) { await response.body.cancel(); throw new Error('source_too_large'); }
            const hash = createHash('sha256'); let bytes = 0;
            await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) {
                bytes += chunk.length;
                if (bytes > maxBytes) { callback(new Error('source_too_large')); return; }
                hash.update(chunk); callback(null, chunk);
            } }), createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
            if (!bytes) throw new Error('empty_source');
            await chmod(target, 0o444);
            return { sha256: hash.digest('hex'), bytes };
        },
    };
}
export async function runContainer({ wrapper, python, source, output, job, engine, sha256, leaseFile, timeout, signal, logPath }) {
    const log = await open(logPath, 'wx', 0o600);
    try {
        await new Promise((done, fail) => {
            const args = [wrapper, job.id.replaceAll('-', ''), source, '--output', output, '--image', engine.image_id,
                '--expected-sha256', sha256, '--owner-lease', leaseFile, '--timeout', String(timeout), '--geojson-supplement', '--html-report'];
            // HOME lets the host Docker CLI locate its local socket/context. No
            // database credentials are inherited by Python, Docker or Blender.
            const env = Object.fromEntries(['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
            const child = spawn(python, args, { env, stdio: ['ignore', log.fd, log.fd], detached: true });
            let timer; let stopping = false;
            const abort = () => {
                if (stopping) return;
                stopping = true;
                child.kill('SIGTERM');
                timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 40000);
                timer.unref();
            };
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
            child.once('error', error => { signal.removeEventListener('abort', abort); clearTimeout(timer); fail(error); });
            child.once('close', code => {
                signal.removeEventListener('abort', abort); clearTimeout(timer);
                if (signal.aborted) fail(new Error('worker_cancelled'));
                else if (code !== 0) fail(new Error('checker_incomplete'));
                else done();
            });
        });
    } finally { await log.close(); }
}
export async function runClaimedJob(config, claim, { backend, containerRunner = runContainer, signal } = {}) {
    validateClaim(claim);
    const { job, engine, lease_token: leaseToken } = claim;
    let workspace;
    const controller = new AbortController();
    const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    let leaseFile; let output; let interval; let deadline;
    let stage = 'downloading'; let heartbeatTask;
    const heartbeat = () => {
        if (heartbeatTask) return heartbeatTask;
        if (controller.signal.aborted) return Promise.resolve();
        heartbeatTask = (async () => {
            try {
                if (['archive_preflight', 'blender_checks', 'geojson_supplement'].includes(stage)) {
                    try {
                        const current = await readJSONFile(join(output, 'job/job.json'), 65536, controller.signal);
                        if (['archive_preflight', 'blender_checks', 'geojson_supplement'].includes(current.status)) stage = current.status;
                    } catch {}
                }
                const state = await backend.rpc('heartbeat_model_check', { check_job_id: job.id, check_lease_token: leaseToken, check_stage: stage });
                if (!state?.active || state.cancel_requested) controller.abort();
                else if (!controller.signal.aborted) await writeFile(leaseFile, '', { mode: 0o600 });
            } catch { controller.abort(); }
            finally { heartbeatTask = undefined; }
        })();
        return heartbeatTask;
    };
    try {
        if (await fileHash(config.wrapper) !== engine.wrapper_sha256) throw new Error('wrapper_identity_mismatch');
        const disk = await statfs(config.workDir);
        if (Number(disk.bavail) * Number(disk.bsize) < (config.minFreeBytes ?? 8 * 1024 ** 3)) throw new Error('insufficient_workspace_space');
        workspace = await mkdtemp(join(config.workDir, 'check-'));
        await chmod(workspace, 0o700);
        // Execute a verified snapshot so a host deployment cannot replace the
        // wrapper between its identity check and process startup.
        const wrapper = join(workspace, 'runner.py');
        await copyFile(config.wrapper, wrapper);
        if (await fileHash(wrapper) !== engine.wrapper_sha256) throw new Error('wrapper_identity_mismatch');
        await chmod(wrapper, 0o400);
        leaseFile = join(workspace, 'owner.lease'); output = join(workspace, 'result');
        interval = setInterval(() => { void heartbeat(); }, config.heartbeatMs ?? 4000);
        deadline = setTimeout(() => controller.abort(), (config.timeout + 60) * 1000);
        await heartbeat(); controller.signal.throwIfAborted();
        const source = join(workspace, job.source_name);
        const downloaded = await backend.download(job, source, controller.signal);
        await heartbeat(); controller.signal.throwIfAborted();
        stage = 'archive_preflight';
        await containerRunner({ wrapper, python: config.python, source, output, job, engine, sha256: downloaded.sha256,
            leaseFile, timeout: config.timeout, signal: controller.signal, logPath: join(workspace, 'dispatcher.log') });
        controller.signal.throwIfAborted();
        stage = 'saving_report'; await heartbeat(); controller.signal.throwIfAborted();
        const reportPath = join(output, 'job/report.json');
        const report = await readJSONFile(reportPath, MAX_REPORT, controller.signal);
        const runtime = await readJSONFile(join(output, 'container.json'), 65536, controller.signal);
        if (!['completed', 'not_applicable'].includes(report.status) || report.checker_version !== '1.6.1' || report.input_unchanged !== true || report.source_sha256 !== downloaded.sha256
            || report.ruleset_id !== 'moscow-npm-vpm-2026-08-18'
            || runtime.image_id !== engine.image_id || runtime.input_unchanged !== true || runtime.exit_code !== 0 || runtime.oom_killed !== false) throw new Error('report_provenance_mismatch');
        report.worker_provenance = { image_id: engine.image_id, wrapper_sha256: engine.wrapper_sha256, engine_revision: engine.revision, source_bytes: downloaded.bytes };
        const accepted = await backend.rpc('finish_model_check', { check_job_id: job.id, check_lease_token: leaseToken, check_status: report.status, check_sha256: downloaded.sha256, check_report: report });
        if (!accepted) throw new Error('report_not_accepted');
        return accepted;
    } catch (error) {
        const code = controller.signal.aborted ? 'worker_cancelled_or_lease_lost' : /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'worker_failed';
        await backend.rpc('finish_model_check', { check_job_id: job.id, check_lease_token: leaseToken, check_status: 'incomplete', check_error_code: code }).catch(() => {});
        throw new Error(code);
    } finally {
        clearInterval(interval); clearTimeout(deadline); signal?.removeEventListener('abort', cancel);
        controller.abort(); await heartbeatTask?.catch(() => {});
        if (workspace) await rm(workspace, { recursive: true, force: true });
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MODEL_CHECK_ENGINE_REVISION, MODEL_CHECK_WRAPPER, MODEL_CHECK_WORK_DIR } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !MODEL_CHECK_ENGINE_REVISION || !MODEL_CHECK_WRAPPER || !MODEL_CHECK_WORK_DIR) throw new Error('Worker configuration is incomplete');
    const config = { wrapper: resolve(MODEL_CHECK_WRAPPER), workDir: resolve(MODEL_CHECK_WORK_DIR), python: process.env.MODEL_CHECK_PYTHON || 'python3', timeout: 600 };
    await mkdir(config.workDir, { recursive: true, mode: 0o700 });
    const backend = createWorkerBackend({ supabaseUrl: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_ROLE_KEY });
    const controller = new AbortController();
    process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
    while (!controller.signal.aborted) {
        let claim;
        try {
            claim = await backend.rpc('claim_model_check', { check_engine_revision: MODEL_CHECK_ENGINE_REVISION }, controller.signal);
            if (claim) await runClaimedJob(config, claim, { backend, signal: controller.signal });
        } catch (error) {
            console.error('model-check-worker', claim?.job?.id || 'queue', /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'request_failed');
        }
        await delay(2000, undefined, { signal: controller.signal }).catch(() => {});
    }
}
