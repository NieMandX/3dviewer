import http from 'node:http';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class CheckApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function id(value) {
    if (typeof value !== 'string' || !UUID.test(value)) throw new CheckApiError(400, 'invalid_id', 'Некорректный идентификатор.');
    return value;
}
export function createModelCheckService({ supabaseUrl, anonKey, fetchImpl = fetch }) {
    const base = new URL(supabaseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid Supabase URL');
    async function request(token, path, body, signal) {
        if (!token || typeof token !== 'string' || /[\r\n]/.test(token)) throw new CheckApiError(401, 'unauthenticated', 'Требуется вход в проект.');
        const url = new URL(path, base);
        const response = await fetchImpl(url, {
            method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
            redirect: 'error', headers: { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = await response.json();
        if (!response.ok) {
            if (response.status === 401) throw new CheckApiError(401, 'unauthenticated', 'Сессия завершена. Войдите снова.');
            if (data?.code === '42501' || response.status === 403) throw new CheckApiError(403, 'forbidden', 'Нет доступа к этой проверке.');
            if (data?.code === '22023') throw new CheckApiError(400, 'source_not_ready', 'Нужен сохранённый ZIP с доступной версией исходного файла.');
            if (data?.code === '55000') throw new CheckApiError(503, 'worker_not_configured', 'Обработчик проверки ещё не подключён.');
            if (data?.code === '54000') throw new CheckApiError(429, 'queue_full', 'В проекте уже четыре незавершённые проверки.');
            throw new CheckApiError(502, 'backend_unavailable', 'Сервис проверки временно недоступен.');
        }
        return data;
    }
    return {
        create: (token, modelId, signal) => request(token, '/rest/v1/rpc/request_model_check', { check_model_id: id(modelId) }, signal),
        cancel: (token, jobId, signal) => request(token, '/rest/v1/rpc/cancel_model_check', { check_job_id: id(jobId) }, signal),
        get: (token, jobId, includeReport = false, signal) => request(token, '/rest/v1/rpc/get_model_check', { check_job_id: id(jobId), include_report: includeReport }, signal),
        list: (token, modelId, signal) => request(token, '/rest/v1/model_check_jobs?' + new URLSearchParams({
            model_id: `eq.${id(modelId)}`, order: 'created_at.desc', limit: '20',
            select: 'id,model_id,source_name,source_revision,source_sha256,engine_revision,status,stage,cancel_requested,summary,error_code,created_at,updated_at,finished_at',
        }), undefined, signal),
    };
}
async function readBody(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) throw new CheckApiError(413, 'body_too_large', 'Запрос слишком большой.');
        chunks.push(chunk);
    }
    try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        return data;
    } catch { throw new CheckApiError(400, 'invalid_json', 'Ожидается JSON-объект.'); }
}
export function createRateLimiter({ limit = 300, windowMs = 60000, maxKeys = 4096, now = Date.now } = {}) {
    const clients = new Map();
    return key => {
        const time = now();
        for (const [ip, state] of clients) if (state.until <= time) clients.delete(ip);
        let state = clients.get(key);
        if (!state) {
            if (clients.size >= maxKeys) return false;
            state = { until: time + windowMs, count: 0 }; clients.set(key, state);
        }
        return ++state.count <= limit;
    };
}
export function createApiServer({ service, allowedOrigins = [], trustProxy = false, rateLimiter = createRateLimiter(), maxInFlight = 32 }) {
    const origins = new Set(allowedOrigins);
    let inFlight = 0;
    const server = http.createServer(async (req, res) => {
        const origin = req.headers.origin;
        const send = (status, data) => {
            if (res.destroyed) return;
            if (origin && origins.has(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            res.end(JSON.stringify(data));
        };
        const controller = new AbortController();
        req.once('aborted', () => controller.abort());
        res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        let counted = false;
        try {
            // Only enable trustProxy on a private listener behind a proxy which
            // overwrites this header. Never trust client-supplied forwarded IPs.
            const forwarded = req.headers['x-lpmview-client-ip'];
            const client = trustProxy && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : req.socket.remoteAddress;
            if (!rateLimiter(client) || inFlight >= maxInFlight) {
                res.setHeader('Retry-After', '60');
                throw new CheckApiError(429, 'rate_limited', 'Слишком много запросов. Повторите через минуту.');
            }
            inFlight++; counted = true;
            if (origin && !origins.has(origin)) throw new CheckApiError(403, 'origin_not_allowed', 'Источник запроса не разрешён.');
            if (req.method === 'GET' && req.url === '/health') { send(200, { ok: true }); return; }
            if (req.method === 'OPTIONS') {
                res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
                send(200, {}); return;
            }
            const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')?.[1];
            if (!token) throw new CheckApiError(401, 'unauthenticated', 'Требуется вход в проект.');
            const path = new URL(req.url, 'http://local.invalid').pathname;
            let match;
            if (req.method === 'POST') {
                if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new CheckApiError(415, 'json_required', 'Ожидается JSON.');
                const body = await readBody(req);
                if (path === '/jobs') {
                    if (Object.keys(body).length !== 1 || !('model_id' in body)) throw new CheckApiError(400, 'invalid_fields', 'Допустим только model_id.');
                    send(202, { job: await service.create(token, body.model_id, controller.signal) }); return;
                }
                if ((match = /^\/jobs\/([^/]+)\/cancel$/.exec(path))) {
                    if (Object.keys(body).length) throw new CheckApiError(400, 'invalid_fields', 'Тело отмены должно быть пустым.');
                    send(200, { job: await service.cancel(token, match[1], controller.signal) }); return;
                }
            } else if (req.method === 'GET') {
                if ((match = /^\/models\/([^/]+)\/jobs$/.exec(path))) { send(200, { jobs: await service.list(token, match[1], controller.signal) }); return; }
                if ((match = /^\/jobs\/([^/]+)(\/report)?$/.exec(path))) {
                    const job = await service.get(token, match[1], Boolean(match[2]), controller.signal);
                    if (match[2] && (job?.status !== 'completed' || !job.report)) throw new CheckApiError(409, 'report_not_ready', 'Отчёт пока не готов.');
                    send(200, { job }); return;
                }
            }
            throw new CheckApiError(404, 'not_found', 'Ресурс не найден.');
        } catch (error) {
            if (controller.signal.aborted) return;
            send(error instanceof CheckApiError ? error.status : 502, {
                error: { code: error instanceof CheckApiError ? error.code : 'backend_unavailable', message: error instanceof CheckApiError ? error.message : 'Сервис проверки временно недоступен.' },
            });
        } finally { if (counted) inFlight--; }
    });
    server.requestTimeout = 20000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
    server.maxConnections = 128;
    return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
    const service = createModelCheckService({ supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
    const server = createApiServer({ service, trustProxy: process.env.MODEL_CHECK_TRUST_PROXY === '1', allowedOrigins: (process.env.MODEL_CHECK_ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean) });
    const port = Number(process.env.PORT || 8081);
    server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Model check API listening on port ${port}`));
    const close = () => { server.close(); server.closeIdleConnections(); };
    process.once('SIGTERM', close); process.once('SIGINT', close);
}
