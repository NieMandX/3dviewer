function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function statusLabel(status) {
    if (status === 'fail') return 'FAIL';
    if (status === 'warn') return 'WARN';
    return 'PASS';
}

export function createModelChecksModalController(options = {}) {
    const modalEl = options.modalEl || null;
    const titleEl = options.titleEl || null;
    const summaryEl = options.summaryEl || null;
    const checksEl = options.checksEl || null;
    const modelsEl = options.modelsEl || null;
    const rerunBtn = options.rerunBtn || null;
    const closeBtn = options.closeBtn || null;

    let rerunHandler = null;
    let busy = false;
    let lastReport = null;

    function setBusy(nextBusy) {
        busy = !!nextBusy;
        if (rerunBtn) rerunBtn.disabled = busy;
    }

    function setRerunHandler(handler) {
        rerunHandler = typeof handler === 'function' ? handler : null;
        if (rerunBtn) rerunBtn.hidden = !rerunHandler;
    }

    function close() {
        modalEl?.classList?.remove?.('show');
    }

    function renderSummary(report) {
        if (!summaryEl) return;
        if (!report?.summary) {
            summaryEl.innerHTML = '<span class="muted">Загрузите модель, чтобы запустить проверки.</span>';
            return;
        }
        const summary = report.summary;
        summaryEl.innerHTML = `
            <div class="checks-badges">
                <span class="checks-badge checks-badge-pass">PASS: ${summary.passes}</span>
                <span class="checks-badge checks-badge-warn">WARN: ${summary.warnings}</span>
                <span class="checks-badge checks-badge-fail">FAIL: ${summary.errors}</span>
            </div>
            <div class="checks-kv">
                <span>Модели: <b>${summary.models}</b></span>
                <span>Треугольники: <b>${summary.triangles.toLocaleString('ru-RU')}</b></span>
                <span>Меши: <b>${summary.meshes.toLocaleString('ru-RU')}</b></span>
                <span>Draw calls: <b>${summary.drawCalls.toLocaleString('ru-RU')}</b></span>
                <span>Материалы: <b>${summary.materials.toLocaleString('ru-RU')}</b></span>
                <span>Текстуры: <b>${summary.textures.toLocaleString('ru-RU')}</b></span>
            </div>
        `;
    }

    function renderChecks(report) {
        if (!checksEl) return;
        const checks = Array.isArray(report?.checks) ? report.checks : [];
        if (!checks.length) {
            checksEl.innerHTML = '<div class="muted">Проверки еще не запускались.</div>';
            return;
        }

        checksEl.innerHTML = checks.map((check) => {
            const details = Array.isArray(check.details) && check.details.length
                ? `<ul class="checks-details">${check.details.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
                : '';
            return `
                <div class="checks-item checks-status-${escapeHtml(check.status)}">
                    <div class="checks-item-head">
                        <span class="checks-item-status">${statusLabel(check.status)}</span>
                        <span class="checks-item-title">${escapeHtml(check.title)}</span>
                    </div>
                    <div class="checks-item-message">${escapeHtml(check.message)}</div>
                    ${details}
                </div>
            `;
        }).join('');
    }

    function renderModels(report) {
        if (!modelsEl) return;
        const models = Array.isArray(report?.models) ? report.models : [];
        if (!models.length) {
            modelsEl.innerHTML = '<div class="muted">Данные по моделям отсутствуют.</div>';
            return;
        }

        const rows = models.slice(0, 25).map((model) => {
            const issues = Array.isArray(model.issues) && model.issues.length
                ? `<div class="checks-model-issues">${model.issues.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>`
                : '';
            return `
                <div class="checks-model-row checks-status-${escapeHtml(model.status)}">
                    <div class="checks-model-main">
                        <span class="checks-model-name">${escapeHtml(model.name)}</span>
                        <span class="checks-model-kind">${escapeHtml(model.zipKind || '—')}</span>
                        <span class="checks-model-tris">${model.triangles.toLocaleString('ru-RU')} tris</span>
                        <span class="checks-model-meshes">${model.meshes.toLocaleString('ru-RU')} meshes</span>
                    </div>
                    ${issues}
                </div>
            `;
        });
        modelsEl.innerHTML = rows.join('');
    }

    function renderReport(report) {
        lastReport = report || null;
        renderSummary(lastReport);
        renderChecks(lastReport);
        renderModels(lastReport);
    }

    async function rerun() {
        if (!rerunHandler || busy) return;
        setBusy(true);
        try {
            const report = await rerunHandler();
            if (report) {
                renderReport(report);
            }
        } catch (err) {
            console.error('Model checks rerun failed', err);
        } finally {
            setBusy(false);
        }
    }

    function open(report = null) {
        if (report) {
            renderReport(report);
        } else if (!lastReport) {
            renderReport(null);
        }
        modalEl?.classList?.add?.('show');
    }

    rerunBtn?.addEventListener?.('click', () => {
        void rerun();
    });
    closeBtn?.addEventListener?.('click', close);
    modalEl?.addEventListener?.('click', (event) => {
        if (event.target === modalEl) close();
    });
    modalEl?.addEventListener?.('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
        }
    });

    return Object.freeze({
        open,
        close,
        renderReport,
        setRerunHandler,
        isOpen: () => !!modalEl?.classList?.contains?.('show'),
    });
}
