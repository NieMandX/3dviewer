import { CHECK_STATES, checkTitle, checkDetailsText, checkIdentifiers, reportText } from './model-check-report.js';
// Server reports concern original stored ZIP packages, never the rendered scene.
export function eligibleModelCheckPackages(records, roomId) {
    const packages = new Map();
    for (const record of records || []) {
        const scope = record?.scope || record?.obj?.userData?.importScope;
        const name = record?.group;
        if (scope?.kind !== 'room' || scope.roomId !== roomId || !scope.modelId || !/\.zip$/i.test(name || '')) continue;
        if (record.category === 'ENV' || record.sourceContainer === 'file' || !['NPM', 'SM'].includes(record.zipKind)) continue;
        packages.set(scope.modelId, { id: scope.modelId, name });
    }
    return [...packages.values()];
}
const STATES = { queued: 'В очереди', running: 'Проверка выполняется', completed: 'Проверка завершена', incomplete: 'Проверка не завершена', cancelled: 'Проверка отменена', not_applicable: 'Этот архив не относится к НПМ/ВПМ' };
const STAGES = { downloading: 'Получение исходного ZIP', archive_preflight: 'Проверка архива', blender_checks: 'Проверка в Blender', geojson_supplement: 'Проверка GeoJSON', saving_report: 'Сохранение отчёта' };
const ERRORS = { source_changed: 'Исходный ZIP изменился во время проверки. Запустите её повторно.', worker_lease_expired: 'Связь с обработчиком потеряна. Проверку можно запустить повторно.', worker_cancelled_or_lease_lost: 'Выполнение остановлено или потеряна связь с обработчиком.', checker_incomplete: 'Обработчик не смог завершить проверку архива.' };

export function createModelCheckPanel({ button, apiBaseUrl, getContext, getAccessToken, onOpen = () => {}, fetchImpl = fetch, document: doc = document, pollMs = 1500 }) {
    let base;
    try {
        base = new URL(apiBaseUrl);
        if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) base = null;
    } catch { base = null; }
    if (button) button.hidden = !base;
    let disposed = false; let dialog; let refs; let scope; let controller; let generation = 0;
    let timer; let contextTimer; let currentJob; let busy = false; let previousFocus; let modelSignature;
    const downloadUrls = [];
    const listeners = [];
    function listen(el, name, fn) { el.addEventListener(name, fn); listeners.push(() => el.removeEventListener(name, fn)); }
    function element(tag, text, className) {
        const el = doc.createElement(tag); if (text !== undefined) el.textContent = String(text); if (className) el.className = className; return el;
    }
    function revokeDownload() { for (const url of downloadUrls.splice(0)) URL.revokeObjectURL(url); }
    function invalidate() { generation++; controller?.abort(); controller = new AbortController(); clearTimeout(timer); timer = null; }
    function close() {
        invalidate(); clearInterval(contextTimer); contextTimer = null; scope = null; currentJob = null; busy = false; modelSignature = null;
        revokeDownload(); dialog?.close(); if (refs) refs.report.replaceChildren();
        if (!disposed && previousFocus?.isConnected) previousFocus.focus();
    }
    function current(mark) {
        return !disposed && dialog?.open && generation === mark && scope?.key === getContext()?.key
            && getContext()?.models?.some(m => m.id === refs.model.value);
    }
    function controls() {
        const allowed = getContext()?.canManage === true;
        const active = ['queued', 'running'].includes(currentJob?.status);
        refs.start.disabled = busy || !allowed || !refs.model.value || active;
        refs.cancel.hidden = !allowed || !active;
        refs.cancel.disabled = busy || currentJob?.cancel_requested === true;
        refs.refresh.disabled = busy || !refs.model.value;
        refs.model.disabled = busy;
    }
    async function request(path, body, mark) {
        const signal = controller.signal;
        const token = await getAccessToken();
        if (!current(mark) || signal.aborted) throw new DOMException('Stale context', 'AbortError');
        if (!token) throw new Error('Войдите в проект, чтобы открыть проверку.');
        let response; let result;
        try {
            response = await fetchImpl(new URL(path.replace(/^\//, ''), base.href.replace(/\/?$/, '/')), {
                method: body === undefined ? 'GET' : 'POST', redirect: 'error',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            result = await response.json();
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            throw new Error('Нет связи с сервисом проверки. После восстановления соединения нажмите «Обновить».');
        }
        if (!response.ok) throw new Error(result?.error?.message || 'Сервис проверки временно недоступен.');
        return result;
    }
    function copyButton(label, text, status) {
        const copy = element('button', label, 'btn'); copy.type = 'button';
        // The handler belongs to this report node; replacing the report releases it.
        copy.onclick = async () => {
            copy.disabled = true;
            try {
                const clipboard = doc.defaultView?.navigator?.clipboard;
                if (!clipboard?.writeText) throw new Error('clipboard unavailable');
                await clipboard.writeText(text);
                if (status.isConnected) status.textContent = 'Скопировано';
            } catch {
                if (status.isConnected) status.textContent = 'Не удалось скопировать. Выделите текст и скопируйте его вручную.';
            } finally { copy.disabled = false; }
        };
        return copy;
    }
    function downloadLink(label, content, type, filename) {
        const url = URL.createObjectURL(new Blob([content], { type })); downloadUrls.push(url);
        const link = element('a', label, 'btn'); link.href = url; link.download = filename; return link;
    }
    function renderReport(job) {
        refs.report.replaceChildren(); revokeDownload();
        const report = job.report;
        if (!report) return;
        if (job.source_current === false) refs.report.append(element('p', 'Архив изменён. Ниже сохранённый отчёт предыдущей версии — запустите новую проверку.', 'model-check-stale'));
        if (job.engine_current === false) refs.report.append(element('p', 'Этот отчёт получен предыдущим или отключённым обработчиком. Для актуального результата нужна новая проверка.', 'model-check-stale'));
        refs.report.append(element('p', 'AGR Checker 1.6.1 · требования от 18.08.2026', 'muted'));
        if (job.finished_at && Number.isFinite(Date.parse(job.finished_at))) refs.report.append(element('p', `Дата проверки: ${new Date(job.finished_at).toLocaleString('ru-RU')}`, 'muted'));
        const counts = element('div', undefined, 'model-check-counts');
        for (const [state, label] of Object.entries(CHECK_STATES)) counts.append(element('span', `${label}: ${Number(report.summary?.[state]) || 0}`, `model-check-${state}`));
        refs.report.append(counts);
        refs.report.append(element('p', 'Проверяются автоматизируемые пункты. Непроверенные требования требуют отдельной проверки; отчёт не подтверждает приёмку проекта.', 'muted'));
        const copyStatus = element('p', '', 'muted model-check-copy-status'); copyStatus.setAttribute('role', 'status');
        const exports = element('div', undefined, 'model-check-actions model-check-exports');
        const text = reportText(job);
        exports.append(copyButton('Скопировать отчёт', text, copyStatus),
            downloadLink('Скачать отчёт TXT', text, 'text/plain;charset=utf-8', 'model-check-report.txt'),
            downloadLink('Скачать отчёт JSON', JSON.stringify(job, null, 2), 'application/json', 'model-check-report.json'));
        refs.report.append(exports, copyStatus);
        for (const [state, label] of Object.entries(CHECK_STATES)) {
            const items = (report.checks || []).filter(c => c.status === state);
            if (!items.length) continue;
            const group = element('details'); group.open = state === 'failed' || state === 'warning';
            group.append(element('summary', `${label} · ${items.length}`));
            for (const item of items) {
                const row = element('details', undefined, 'model-check-item');
                row.append(element('summary', checkTitle(item)));
                if (item.errors_text) row.append(element('pre', item.errors_text));
                if (item.recommendations_text) row.append(element('pre', item.recommendations_text));
                if (!item.errors_text && !item.recommendations_text) row.append(element('p', CHECK_STATES[item.status]));
                if (item.errors_text || item.recommendations_text) {
                    const status = element('p', '', 'muted model-check-copy-status'); status.setAttribute('role', 'status');
                    const actions = element('div', undefined, 'model-check-actions');
                    actions.append(copyButton('Скопировать замечание', `${checkTitle(item)}\n${checkDetailsText(item)}`, status));
                    const names = checkIdentifiers(item);
                    if (names.length) {
                        const identifiers = element('div', undefined, 'model-check-identifiers');
                        identifiers.append(element('p', 'Имена из сообщения чекера', 'muted'));
                        for (const name of names) {
                            const entry = element('div', undefined, 'model-check-identifier');
                            const copy = copyButton('Скопировать имя', name, status); copy.setAttribute('aria-label', `Скопировать имя ${name}`);
                            entry.append(element('code', name), copy); identifiers.append(entry);
                        }
                        row.append(identifiers);
                    }
                    row.append(actions, status);
                }
                group.append(row);
            }
            refs.report.append(group);
        }
        const supplement = report.geojson_supplement;
        if (supplement && supplement.status !== 'not_applicable') {
            const extra = element('details'); extra.append(element('summary', 'Дополнительные проверки GeoJSON'));
            for (const file of supplement.files || []) {
                extra.append(element('h4', file.archive_entry));
                for (const issue of file.issues || []) extra.append(element('pre', `${issue.severity}: ${issue.path}\n${issue.message}\n${issue.source?.clause || ''}`));
                for (const limitation of file.limitations || []) extra.append(element('p', limitation, 'muted'));
            }
            if (supplement.status !== 'completed') extra.append(element('p', 'Дополнительная проверка не завершена.'));
            refs.report.append(extra);
        }
        const identity = element('details'); identity.append(element('summary', 'Исходный файл и версия проверки'));
        identity.append(element('pre', `${job.source_name}\nSHA-256: ${job.source_sha256 || report.source_sha256}\nОбработчик: ${job.engine_revision}\nBlender: ${report.blender_version || '—'}`));
        refs.report.append(identity);
    }
    function renderJob(job) {
        currentJob = job;
        refs.status.textContent = job ? `${STATES[job.status] || 'Состояние неизвестно'}${job.status === 'running' ? ' · ' + (STAGES[job.stage] || 'Обработка') : ''}${job.cancel_requested && job.status === 'running' ? ' · отмена запрошена' : ''}` : 'Проверок этого архива пока нет.';
        refs.error.textContent = job?.error_code ? (ERRORS[job.error_code] || 'Проверка не завершена. Можно повторить запуск.') : '';
        if (job?.report) renderReport(job);
        else { refs.report.replaceChildren(); revokeDownload(); }
        controls();
    }
    function schedule(mark, retry = false) {
        clearTimeout(timer);
        if (current(mark) && (retry || ['queued', 'running'].includes(currentJob?.status))) timer = setTimeout(() => void load(mark, !currentJob?.id), retry ? Math.max(5000, pollMs) : pollMs);
    }
    async function load(mark = generation, list = true) {
        if (!current(mark) || busy) return;
        busy = true; controls(); let retry = false;
        try {
            let id = currentJob?.id;
            if (list) id = (await request(`models/${encodeURIComponent(refs.model.value)}/jobs`, undefined, mark)).jobs?.[0]?.id;
            if (!current(mark)) return;
            if (!id) { renderJob(null); return; }
            let job = (await request(`jobs/${encodeURIComponent(id)}`, undefined, mark)).job;
            if (job?.status === 'completed') job = (await request(`jobs/${encodeURIComponent(id)}/report`, undefined, mark)).job;
            if (current(mark)) renderJob(job);
        } catch (error) {
            if (current(mark) && error.name !== 'AbortError') { refs.error.textContent = error.message; retry = true; }
        } finally { if (current(mark)) { busy = false; controls(); schedule(mark, retry); } }
    }
    async function action(cancel = false) {
        const mark = generation;
        if (!current(mark) || busy || !getContext()?.canManage) return;
        busy = true; controls(); refs.error.textContent = ''; clearTimeout(timer);
        try {
            const result = await request(cancel ? `jobs/${encodeURIComponent(currentJob.id)}/cancel` : 'jobs', cancel ? {} : { model_id: refs.model.value }, mark);
            if (current(mark)) { renderJob(result.job); busy = false; await load(mark, false); }
        } catch (error) { if (current(mark) && error.name !== 'AbortError') refs.error.textContent = error.message; }
        finally { if (current(mark)) { busy = false; controls(); schedule(mark); } }
    }
    function selectModel() {
        invalidate(); busy = false; currentJob = null; refs.report.replaceChildren(); revokeDownload(); refs.error.textContent = '';
        refs.status.textContent = refs.model.value ? 'Получение состояния…' : 'Для проверки откройте комнату с загруженным и синхронизированным ZIP НПМ/ВПМ.';
        controls(); if (refs.model.value) void load();
    }
    function updateModels(models = []) {
        const signature = JSON.stringify(models.map(m => [m.id, m.name]));
        if (signature === modelSignature) return;
        const selected = refs.model.value;
        const previousName = refs.model.selectedOptions[0]?.textContent;
        refs.model.replaceChildren(...models.map(m => { const option = element('option', m.name); option.value = m.id; return option; }));
        if (models.some(m => m.id === selected)) refs.model.value = selected;
        modelSignature = signature;
        // A newly loaded ZIP becomes selectable without closing the panel. Adding
        // a different model must not reset a running job or an expanded report.
        if (selected !== refs.model.value || previousName !== refs.model.selectedOptions[0]?.textContent) selectModel();
    }
    function ensureDialog() {
        if (dialog) return;
        dialog = element('dialog', undefined, 'sheet model-check-dialog'); dialog.id = 'modelCheckDialog'; dialog.setAttribute('aria-labelledby', 'modelCheckTitle');
        const head = element('div', undefined, 'head'); const title = element('strong', 'Проверка модели'); title.id = 'modelCheckTitle';
        const exit = element('button', 'Закрыть', 'btn'); exit.type = 'button'; head.append(title, exit);
        const body = element('div', undefined, 'model-check-body');
        const label = element('label', 'Исходный ZIP'); const model = element('select'); model.id = 'modelCheckSource'; label.htmlFor = model.id;
        const hint = element('p', 'Проверяется исходный архив, сохранённый в проекте. Сначала дождитесь синхронизации загрузки.', 'muted');
        const row = element('div', undefined, 'model-check-actions');
        const start = element('button', 'Проверить модель', 'btn'); const cancel = element('button', 'Отменить проверку', 'btn'); const refresh = element('button', 'Обновить', 'btn');
        for (const el of [start, cancel, refresh]) el.type = 'button'; row.append(start, cancel, refresh);
        const status = element('p'); status.setAttribute('role', 'status');
        const error = element('p', undefined, 'model-check-error'); error.setAttribute('role', 'alert');
        const report = element('div', undefined, 'model-check-report'); body.append(label, model, hint, row, status, error, report);
        dialog.append(head, body); doc.body.append(dialog); refs = { model, start, cancel, refresh, status, error, report, hint };
        listen(exit, 'click', close); listen(dialog, 'cancel', e => { e.preventDefault(); close(); });
        // Keep Viewer camera/annotation shortcuts out of the report. Do not
        // prevent native defaults (Tab, Escape, text selection, copy).
        listen(dialog, 'keydown', e => e.stopPropagation());
        listen(model, 'change', selectModel); listen(start, 'click', () => void action()); listen(cancel, 'click', () => void action(true)); listen(refresh, 'click', () => void load());
    }
    function open() {
        if (disposed || !base) return;
        if (dialog?.open) close();
        ensureDialog(); scope = getContext(); previousFocus = doc.activeElement;
        modelSignature = null;
        refs.model.replaceChildren();
        refs.hint.textContent = scope?.canManage ? 'Проверяется исходный ZIP, сохранённый в проекте. Изменения материалов во Viewer на отчёт не влияют.' : 'Вы можете читать готовые отчёты. Запуск и отмена доступны владельцу проекта.';
        onOpen(); dialog.showModal(); updateModels(scope?.models);
        if (!refs.model.value) selectModel();
        contextTimer = setInterval(() => {
            const next = getContext();
            if (next?.key !== scope?.key || (refs.model.value && !next?.models?.some(m => m.id === refs.model.value))) close();
            else { updateModels(next?.models); controls(); }
        }, 500);
    }
    if (button) listen(button, 'click', open);
    return { open, close, dispose() { if (disposed) return; disposed = true; close(); for (const remove of listeners) remove(); dialog?.remove(); if (button) button.hidden = true; } };
}
