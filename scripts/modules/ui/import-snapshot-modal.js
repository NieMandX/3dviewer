function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export const DEFAULT_IMPORT_SNAPSHOT_SECTIONS = Object.freeze([
    Object.freeze({
        key: 'identity',
        title: 'Идентификация',
        note: 'Базовые идентификаторы конкретного импорта.',
        fields: Object.freeze([
            Object.freeze({ key: 'snapshotId', description: 'Уникальный ID слепка в сессии.' }),
            Object.freeze({ key: 'modelId', description: 'Внутренний ID модели в пайплайне.' }),
            Object.freeze({ key: 'modelType', description: 'Определенный тип: ВПМ или НПМ.' }),
            Object.freeze({ key: 'fileName', description: 'Имя исходного файла.' }),
            Object.freeze({ key: 'sourceContainer', description: 'Источник: direct file или zip entry.' }),
            Object.freeze({ key: 'capturedAt', description: 'Время фиксации слепка.' }),
        ]),
    }),
    Object.freeze({
        key: 'importMeta',
        title: 'Метаданные импорта',
        note: 'Техническая информация для повторяемости диагностики.',
        fields: Object.freeze([
            Object.freeze({ key: 'importSessionId', description: 'ID текущей импорт-сессии.' }),
            Object.freeze({ key: 'importOrder', description: 'Порядок загрузки внутри сессии.' }),
            Object.freeze({ key: 'byteSize', description: 'Размер исходного файла в байтах.' }),
            Object.freeze({ key: 'hash', description: 'Хэш входного буфера.' }),
            Object.freeze({ key: 'parseDurationMs', description: 'Длительность парсинга.' }),
            Object.freeze({ key: 'parseWarningsRaw', description: 'Предупреждения парсера.' }),
        ]),
    }),
    Object.freeze({
        key: 'orientationRaw',
        title: 'Ориентация и координаты',
        note: 'Сырые параметры ориентации до нормализации во вьюере.',
        fields: Object.freeze([
            Object.freeze({ key: 'rawUpAxis', description: 'Ось Up в исходном FBX.' }),
            Object.freeze({ key: 'rawFrontAxis', description: 'Ось Front в исходном FBX.' }),
            Object.freeze({ key: 'rawCoordSystem', description: 'Тип системы координат (LH/RH).' }),
            Object.freeze({ key: 'unitScaleFactor', description: 'Масштаб единиц исходной сцены.' }),
            Object.freeze({ key: 'preRotationFlags', description: 'Наличие pre-rotation у узлов.' }),
            Object.freeze({ key: 'viewerTransformPlan', description: 'Какие выравнивания планирует вьюер.' }),
        ]),
    }),
    Object.freeze({
        key: 'sceneSummaryRaw',
        title: 'Сводка входной сцены',
        note: 'Счетчики до переименований и служебных модификаций.',
        fields: Object.freeze([
            Object.freeze({ key: 'nodeCount', description: 'Количество узлов сцены.' }),
            Object.freeze({ key: 'meshCount', description: 'Количество мешей.' }),
            Object.freeze({ key: 'materialSlotCount', description: 'Количество material slots.' }),
            Object.freeze({ key: 'textureRefCount', description: 'Количество ссылок на текстуры.' }),
            Object.freeze({ key: 'uvSetCount', description: 'Количество UV-наборов.' }),
            Object.freeze({ key: 'hasAnimationLightsCameras', description: 'Наличие анимации/света/камер.' }),
        ]),
    }),
    Object.freeze({
        key: 'nodes',
        title: 'Узлы (nodes[])',
        note: 'Иерархия и исходные локальные трансформы.',
        fields: Object.freeze([
            Object.freeze({ key: 'nodeId', description: 'ID узла.' }),
            Object.freeze({ key: 'nameRaw', description: 'Исходное имя узла.' }),
            Object.freeze({ key: 'parentId', description: 'ID родительского узла.' }),
            Object.freeze({ key: 'nodeTypeRaw', description: 'Тип узла: mesh/null/light/camera.' }),
            Object.freeze({ key: 'localTransformRaw', description: 'P/R/S до модификаций.' }),
            Object.freeze({ key: 'visibilityRaw', description: 'Исходная видимость.' }),
        ]),
    }),
    Object.freeze({
        key: 'meshes',
        title: 'Меши (meshes[])',
        note: 'Геометрические параметры для проверок МКА.',
        fields: Object.freeze([
            Object.freeze({ key: 'meshId', description: 'ID меша.' }),
            Object.freeze({ key: 'meshNameRaw', description: 'Исходное имя меша.' }),
            Object.freeze({ key: 'ownerNodeId', description: 'ID родительского узла.' }),
            Object.freeze({ key: 'vertexCountRaw', description: 'Количество вершин.' }),
            Object.freeze({ key: 'triangleCountRaw', description: 'Количество треугольников.' }),
            Object.freeze({ key: 'boundingBoxRaw', description: 'Габариты до правок вьюера.' }),
            Object.freeze({ key: 'isUcXByNameRaw', description: 'UCX-признак по исходному имени.' }),
        ]),
    }),
    Object.freeze({
        key: 'meshMaterialsRaw',
        title: 'Материалы на мешах',
        note: 'Первичные назначения материалов из исходного файла.',
        fields: Object.freeze([
            Object.freeze({ key: 'slotIndex', description: 'Индекс material slot.' }),
            Object.freeze({ key: 'materialIdRef', description: 'Ссылка на материал в materials[].' }),
            Object.freeze({ key: 'materialNameRaw', description: 'Имя материала в исходнике.' }),
            Object.freeze({ key: 'materialPresentInSource', description: 'Материал был в исходном FBX.' }),
            Object.freeze({ key: 'assignedByViewer', description: 'Материал назначен уже во вьюере.' }),
            Object.freeze({ key: 'sourceNote', description: 'Служебный комментарий назначения.' }),
        ]),
    }),
    Object.freeze({
        key: 'uvUdimRaw',
        title: 'UV и UDIM',
        note: 'Сырые UV/UDIM-параметры до split/пересборки.',
        fields: Object.freeze([
            Object.freeze({ key: 'uvChannelCount', description: 'Количество UV-каналов.' }),
            Object.freeze({ key: 'uvSetNamesRaw', description: 'Имена UV-наборов.' }),
            Object.freeze({ key: 'uvBoundsRaw', description: 'Границы UV по каналам.' }),
            Object.freeze({ key: 'udimTilesRaw', description: 'Обнаруженные UDIM-тайлы.' }),
            Object.freeze({ key: 'uvOutOfRangePercent', description: 'Доля UV вне диапазона.' }),
            Object.freeze({ key: 'requiresViewerSplit', description: 'Нужна ли пересборка во вьюере.' }),
        ]),
    }),
    Object.freeze({
        key: 'materials',
        title: 'Каталог материалов (materials[])',
        note: 'Параметры материалов в оригинальном состоянии.',
        fields: Object.freeze([
            Object.freeze({ key: 'materialId', description: 'ID материала.' }),
            Object.freeze({ key: 'materialNameRaw', description: 'Исходное имя материала.' }),
            Object.freeze({ key: 'shadingModelRaw', description: 'Исходная шейдинговая модель.' }),
            Object.freeze({ key: 'opacityModeRaw', description: 'Параметры прозрачности/альфы.' }),
            Object.freeze({ key: 'twoSidedRaw', description: 'Исходная двусторонность.' }),
            Object.freeze({ key: 'textureBindingsRaw', description: 'Текстурные привязки.' }),
        ]),
    }),
    Object.freeze({
        key: 'textures',
        title: 'Текстуры и пути (textures[])',
        note: 'Сведения о файлах текстур и способе их подключения.',
        fields: Object.freeze([
            Object.freeze({ key: 'textureId', description: 'ID текстуры.' }),
            Object.freeze({ key: 'filePathRaw', description: 'Исходный путь к текстуре.' }),
            Object.freeze({ key: 'fileName', description: 'Имя файла текстуры.' }),
            Object.freeze({ key: 'mimeOrFormatRaw', description: 'Формат файла (png/jpg/tga...).' }),
            Object.freeze({ key: 'resolutionRaw', description: 'Размер текстуры (W x H).' }),
            Object.freeze({ key: 'embedState', description: 'Состояние: embedded/external/missing.' }),
        ]),
    }),
    Object.freeze({
        key: 'linksAndIndex',
        title: 'Индексы и быстрые карты',
        note: 'Служебные индексы для быстрых проверок без полного обхода сцены.',
        fields: Object.freeze([
            Object.freeze({ key: 'meshByName', description: 'Индекс мешей по имени.' }),
            Object.freeze({ key: 'nodeChildrenMap', description: 'Индекс дочерних узлов.' }),
            Object.freeze({ key: 'materialsById', description: 'Быстрый доступ к материалам.' }),
            Object.freeze({ key: 'texturesById', description: 'Быстрый доступ к текстурам.' }),
            Object.freeze({ key: 'ucxMeshIds', description: 'Список UCX-мешей.' }),
            Object.freeze({ key: 'precheckFindings', description: 'Ранние находки precheck.' }),
        ]),
    }),
]);

export function createImportSnapshotModalController(options = {}) {
    const modalEl = options.modalEl || null;
    const titleEl = options.titleEl || null;
    const summaryEl = options.summaryEl || null;
    const sectionsEl = options.sectionsEl || null;
    const closeBtn = options.closeBtn || null;

    let sections = Array.isArray(options.sections) && options.sections.length
        ? options.sections
        : DEFAULT_IMPORT_SNAPSHOT_SECTIONS;

    function close() {
        modalEl?.classList?.remove?.('show');
        modalEl?.setAttribute?.('aria-hidden', 'true');
    }

    function buildSection(section, index) {
        const fields = Array.isArray(section?.fields) ? section.fields : [];
        const fieldsHtml = fields.length
            ? fields.map((item) => `
                <div class="snapshot-field">
                    <div class="snapshot-field-name">${escapeHtml(item?.key || '—')}</div>
                    <div class="snapshot-field-description">${escapeHtml(item?.description || '')}</div>
                </div>
            `).join('')
            : '<div class="snapshot-empty muted">Поля не заданы.</div>';

        return `
            <section class="snapshot-section">
                <div class="snapshot-section-head">
                    <div class="snapshot-section-index">${index + 1}</div>
                    <div class="snapshot-section-meta">
                        <div class="snapshot-section-title">${escapeHtml(section?.title || section?.key || 'Раздел')}</div>
                        <div class="snapshot-section-note">${escapeHtml(section?.note || '')}</div>
                    </div>
                </div>
                <div class="snapshot-field-grid">${fieldsHtml}</div>
            </section>
        `;
    }

    function render() {
        if (titleEl) {
            titleEl.textContent = 'Слепок импорта: поля до модификаций сцены';
        }
        if (summaryEl) {
            const totalSections = sections.length;
            const totalFields = sections.reduce((acc, section) => {
                const list = Array.isArray(section?.fields) ? section.fields : [];
                return acc + list.length;
            }, 0);
            summaryEl.innerHTML = `
                <div class="snapshot-badges">
                    <span class="snapshot-badge">Разделов: ${totalSections}</span>
                    <span class="snapshot-badge">Полей: ${totalFields}</span>
                    <span class="snapshot-badge">Фиксация: до добавления в сцену</span>
                </div>
                <div class="muted">Временный справочник структуры import snapshot для разработки чекера.</div>
            `;
        }
        if (sectionsEl) {
            sectionsEl.innerHTML = sections.length
                ? sections.map((section, index) => buildSection(section, index)).join('')
                : '<div class="snapshot-empty muted">Нет данных для отображения.</div>';
        }
    }

    function open(nextSections = null) {
        if (Array.isArray(nextSections) && nextSections.length) {
            sections = nextSections;
        }
        render();
        modalEl?.classList?.add?.('show');
        modalEl?.setAttribute?.('aria-hidden', 'false');
    }

    function setSections(nextSections) {
        sections = Array.isArray(nextSections) && nextSections.length
            ? nextSections
            : DEFAULT_IMPORT_SNAPSHOT_SECTIONS;
    }

    closeBtn?.addEventListener?.('click', close);
    modalEl?.addEventListener?.('click', (event) => {
        if (event.target === modalEl) {
            close();
        }
    });
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
        setSections,
    };
}
