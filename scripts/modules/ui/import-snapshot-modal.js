function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const SNAPSHOT_SECTIONS = Object.freeze([
    Object.freeze({ key: 'identity', title: 'Идентификация' }),
    Object.freeze({ key: 'importMeta', title: 'Метаданные импорта' }),
    Object.freeze({ key: 'orientationRaw', title: 'Ориентация и координаты' }),
    Object.freeze({ key: 'sceneSummaryRaw', title: 'Сводка входной сцены' }),
    Object.freeze({ key: 'nodes', title: 'Узлы (nodes[])' }),
    Object.freeze({ key: 'meshes', title: 'Меши (meshes[])' }),
    Object.freeze({ key: 'meshMaterialsRaw', title: 'Материалы на мешах' }),
    Object.freeze({ key: 'uvUdimRaw', title: 'UV и UDIM' }),
    Object.freeze({ key: 'materials', title: 'Каталог материалов' }),
    Object.freeze({ key: 'textures', title: 'Текстуры и пути' }),
    Object.freeze({ key: 'linksAndIndex', title: 'Индексы и быстрые карты' }),
]);

function sectionSizeLabel(value) {
    if (Array.isArray(value)) return `${value.length} записей`;
    if (value && typeof value === 'object') return `${Object.keys(value).length} ключей`;
    if (value == null) return 'нет данных';
    return '1 значение';
}

function safeStringify(value) {
    try {
        return JSON.stringify(value, null, 2);
    } catch (error) {
        return `{"error":"Не удалось сериализовать раздел: ${String(error?.message || error)}"}`;
    }
}

function toDisplayType(rawType) {
    const value = String(rawType || '').trim().toUpperCase();
    if (!value) return 'Не определено';
    if (value === 'SM' || value === 'VPM' || value === 'ВПМ') return 'ВПМ';
    if (value === 'NPM' || value === 'НПМ') return 'НПМ';
    return rawType;
}

export function createImportSnapshotModalController(options = {}) {
    const modalEl = options.modalEl || null;
    const titleEl = options.titleEl || null;
    const summaryEl = options.summaryEl || null;
    const sectionsEl = options.sectionsEl || null;
    const closeBtn = options.closeBtn || null;

    let snapshots = [];

    function close() {
        modalEl?.classList?.remove?.('show');
        modalEl?.setAttribute?.('aria-hidden', 'true');
    }

    function renderSummary() {
        if (!summaryEl) return;

        if (!snapshots.length) {
            summaryEl.innerHTML = `
                <div class="snapshot-badges">
                    <span class="snapshot-badge">Моделей: 0</span>
                </div>
                <div class="muted">После импорта модели здесь появится первичный слепок данных.</div>
            `;
            return;
        }

        const npmCount = snapshots.filter((item) => toDisplayType(item?.modelType) === 'НПМ').length;
        const vpmCount = snapshots.filter((item) => toDisplayType(item?.modelType) === 'ВПМ').length;
        summaryEl.innerHTML = `
            <div class="snapshot-badges">
                <span class="snapshot-badge">Моделей: ${snapshots.length}</span>
                <span class="snapshot-badge">НПМ: ${npmCount}</span>
                <span class="snapshot-badge">ВПМ: ${vpmCount}</span>
                <span class="snapshot-badge">Фиксация: до модификаций сцены</span>
            </div>
            <div class="muted">Раскройте секции ниже, чтобы посмотреть сохраненные данные по каждой модели.</div>
        `;
    }

    function renderModelCard(snapshot, index) {
        const name = snapshot?.fileName || `Модель ${index + 1}`;
        const kind = toDisplayType(snapshot?.modelType || snapshot?.zipKind);
        const capturedAt = snapshot?.capturedAt || '—';
        const sceneSummaryRaw = snapshot?.sceneSummaryRaw || {};
        const meshes = Number(sceneSummaryRaw.meshCount || 0).toLocaleString('ru-RU');
        const tris = Number(sceneSummaryRaw.triangleCount || 0).toLocaleString('ru-RU');
        const mats = Number(sceneSummaryRaw.materialCount || 0).toLocaleString('ru-RU');
        const tex = Number(sceneSummaryRaw.textureCount || 0).toLocaleString('ru-RU');

        const sectionsHtml = SNAPSHOT_SECTIONS.map((section) => {
            const value = snapshot?.[section.key];
            const size = sectionSizeLabel(value);
            return `
                <details class="snapshot-data-section" data-model-index="${index}" data-section-key="${escapeHtml(section.key)}">
                    <summary>
                        <span class="snapshot-data-title">${escapeHtml(section.title)}</span>
                        <span class="snapshot-data-size">${escapeHtml(size)}</span>
                    </summary>
                    <pre class="snapshot-json"><code>Раскройте секцию для загрузки данных…</code></pre>
                </details>
            `;
        }).join('');

        return `
            <article class="snapshot-model-card">
                <div class="snapshot-model-head">
                    <div class="snapshot-model-name">${escapeHtml(name)}</div>
                    <div class="snapshot-model-badges">
                        <span class="snapshot-badge">${escapeHtml(kind)}</span>
                        <span class="snapshot-badge">${escapeHtml(capturedAt)}</span>
                    </div>
                </div>
                <div class="snapshot-model-meta">
                    <span>Meshes: <b>${meshes}</b></span>
                    <span>Tris: <b>${tris}</b></span>
                    <span>Materials: <b>${mats}</b></span>
                    <span>Textures: <b>${tex}</b></span>
                </div>
                <div class="snapshot-model-sections">${sectionsHtml}</div>
            </article>
        `;
    }

    function renderModels() {
        if (!sectionsEl) return;
        if (!snapshots.length) {
            sectionsEl.innerHTML = '<div class="snapshot-empty muted">Слепки отсутствуют.</div>';
            return;
        }
        sectionsEl.innerHTML = snapshots.map((snapshot, index) => renderModelCard(snapshot, index)).join('');
    }

    function render() {
        if (titleEl) {
            titleEl.textContent = 'Слепок импорта: данные загруженных моделей';
        }
        renderSummary();
        renderModels();
    }

    function open(nextSnapshots = null) {
        snapshots = Array.isArray(nextSnapshots)
            ? nextSnapshots.filter((item) => item && typeof item === 'object')
            : [];
        render();
        modalEl?.classList?.add?.('show');
        modalEl?.setAttribute?.('aria-hidden', 'false');
    }

    function resolveSectionData(detailsEl) {
        if (!detailsEl || detailsEl.dataset.loaded === '1' || !detailsEl.open) return;
        const modelIndex = Number(detailsEl.dataset.modelIndex);
        const sectionKey = detailsEl.dataset.sectionKey;
        if (!Number.isFinite(modelIndex) || !sectionKey) return;
        const snapshot = snapshots[modelIndex];
        const payload = snapshot ? snapshot[sectionKey] : null;
        const codeEl = detailsEl.querySelector('code');
        if (!codeEl) return;
        codeEl.textContent = safeStringify(payload);
        detailsEl.dataset.loaded = '1';
    }

    closeBtn?.addEventListener?.('click', close);
    modalEl?.addEventListener?.('click', (event) => {
        if (event.target === modalEl) {
            close();
        }
    });
    modalEl?.addEventListener?.('toggle', (event) => {
        const detailsEl = event.target;
        if (!detailsEl?.classList?.contains?.('snapshot-data-section')) return;
        resolveSectionData(detailsEl);
    }, true);
    if (typeof window !== 'undefined') {
        window.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && modalEl?.classList?.contains?.('show')) {
                close();
            }
        });
    }

    return {
        close,
        open,
        render,
    };
}
