export function createAppbarVisibilityTogglesController(options = {}) {
    const solidToggleBtn = options.solidToggleBtn || null;
    const collToggleBtn = options.collToggleBtn || null;
    const vpmToggleBtn = options.vpmToggleBtn || null;
    const npmToggleBtn = options.npmToggleBtn || null;

    const schedulePanelRefresh =
        typeof options.schedulePanelRefresh === 'function' ? options.schedulePanelRefresh : () => {};

    const api = options.api || {};
    const handleEyeToggleRaw = typeof api.handleEyeToggleRaw === 'function' ? api.handleEyeToggleRaw : () => {};

    const getNonGlassState = typeof api.getNonGlassState === 'function'
        ? api.getNonGlassState
        : () => ({ hasAny: false, anyVisible: false, suppressed: false });
    const toggleNonGlassSuppressed = typeof api.toggleNonGlassSuppressed === 'function' ? api.toggleNonGlassSuppressed : () => {};
    const applyNonGlassSuppression = typeof api.applyNonGlassSuppression === 'function' ? api.applyNonGlassSuppression : () => {};

    const getCollisionsState = typeof api.getCollisionsState === 'function'
        ? api.getCollisionsState
        : () => ({ hasAny: false, anyVisible: false });
    const toggleCollisionsVisible = typeof api.toggleCollisionsVisible === 'function' ? api.toggleCollisionsVisible : () => {};

    const getVPMModelsState = typeof api.getVPMModelsState === 'function'
        ? api.getVPMModelsState
        : () => ({ hasAny: false, anyVisible: false });
    const toggleVPMModelsVisible = typeof api.toggleVPMModelsVisible === 'function' ? api.toggleVPMModelsVisible : () => {};

    const getNPMModelsState = typeof api.getNPMModelsState === 'function'
        ? api.getNPMModelsState
        : () => ({ hasAny: false, anyVisible: false });
    const toggleNPMModelsVisible = typeof api.toggleNPMModelsVisible === 'function' ? api.toggleNPMModelsVisible : () => {};

    function enforceSuppressionIfNeeded() {
        if (!getNonGlassState().suppressed) return false;
        applyNonGlassSuppression({ captureNew: true });
        return true;
    }

    function updateSolidToggleBtnUI() {
        if (!solidToggleBtn) return;
        const state = getNonGlassState();
        solidToggleBtn.disabled = !state.hasAny && !state.suppressed;
        solidToggleBtn.classList.toggle('active', state.suppressed);
        solidToggleBtn.textContent = 'GLS';
        solidToggleBtn.setAttribute('aria-pressed', state.suppressed ? 'true' : 'false');
        solidToggleBtn.title = state.suppressed
            ? 'Показать всё (включая не-стекло)'
            : (state.hasAny ? 'Оставить только стекло' : 'Не найдено объектов кроме стекла');
    }

    function updateCollisionsToggleBtnUI() {
        if (!collToggleBtn) return;
        const state = getCollisionsState();
        collToggleBtn.disabled = !state.hasAny || getNonGlassState().suppressed;
        collToggleBtn.classList.toggle('active', state.anyVisible);
        collToggleBtn.textContent = 'UCX';
        collToggleBtn.setAttribute('aria-pressed', state.anyVisible ? 'true' : 'false');
        collToggleBtn.title = state.hasAny
            ? (state.anyVisible ? 'Скрыть коллизии (UCX)' : 'Показать коллизии (UCX)')
            : 'Коллизии (UCX) не найдены';
    }

    function updateVPMToggleBtnUI() {
        if (!vpmToggleBtn) return;
        const state = getVPMModelsState();
        vpmToggleBtn.disabled = !state.hasAny || getNonGlassState().suppressed;
        vpmToggleBtn.classList.toggle('active', state.anyVisible);
        vpmToggleBtn.textContent = 'ВПМ';
        vpmToggleBtn.setAttribute('aria-pressed', state.anyVisible ? 'true' : 'false');
        vpmToggleBtn.title = state.hasAny
            ? (state.anyVisible ? 'Скрыть ВПМ модели' : 'Показать ВПМ модели')
            : 'ВПМ модели не найдены';
    }

    function updateNPMToggleBtnUI() {
        if (!npmToggleBtn) return;
        const state = getNPMModelsState();
        npmToggleBtn.disabled = !state.hasAny || getNonGlassState().suppressed;
        npmToggleBtn.classList.toggle('active', state.anyVisible);
        npmToggleBtn.textContent = 'НПМ';
        npmToggleBtn.setAttribute('aria-pressed', state.anyVisible ? 'true' : 'false');
        npmToggleBtn.title = state.hasAny
            ? (state.anyVisible ? 'Скрыть НПМ модели' : 'Показать НПМ модели')
            : 'НПМ модели не найдены';
    }

    function updateAll() {
        updateSolidToggleBtnUI();
        updateCollisionsToggleBtnUI();
        updateVPMToggleBtnUI();
        updateNPMToggleBtnUI();
    }

    function handleEyeToggle(el) {
        handleEyeToggleRaw(el);
        enforceSuppressionIfNeeded();
        updateAll();
    }

    if (solidToggleBtn) {
        solidToggleBtn.addEventListener('click', () => {
            toggleNonGlassSuppressed();
            schedulePanelRefresh(true);
            updateAll();
        });
    }
    if (collToggleBtn) {
        collToggleBtn.addEventListener('click', () => {
            toggleCollisionsVisible();
            enforceSuppressionIfNeeded();
            updateAll();
        });
    }
    if (vpmToggleBtn) {
        vpmToggleBtn.addEventListener('click', () => {
            toggleVPMModelsVisible();
            enforceSuppressionIfNeeded();
            updateAll();
        });
    }
    if (npmToggleBtn) {
        npmToggleBtn.addEventListener('click', () => {
            toggleNPMModelsVisible();
            enforceSuppressionIfNeeded();
            updateAll();
        });
    }

    return Object.freeze({
        handleEyeToggle,
        updateAll,
        enforceSuppressionIfNeeded,
    });
}
