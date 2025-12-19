function safePrompt(promptFn, message, fallback = '') {
    if (typeof promptFn !== 'function') return fallback;
    try {
        const value = promptFn(message);
        if (value == null) return null;
        return String(value);
    } catch (_) {
        return fallback;
    }
}

function safeConfirm(confirmFn, message) {
    if (typeof confirmFn !== 'function') return false;
    try {
        return !!confirmFn(message);
    } catch (_) {
        return false;
    }
}

function makeId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createCameraPresetsController(options = {}) {
    const THREE = options.THREE || null;
    const camera = options.camera || null;
    const controls = options.controls || null;
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};

    const camsToggleBtn = options.camsToggleBtn || null;
    const camsBarEl = options.camsBarEl || null;
    const camsBarListEl = options.camsBarListEl || null;
    const camsDetailsEl = options.camsDetailsEl || null;
    const camsCountEl = options.camsCountEl || null;
    const camsSideListEl = options.camsSideListEl || null;

    const promptFn =
        typeof options.prompt === 'function'
            ? options.prompt
            : (typeof globalThis !== 'undefined' && typeof globalThis.prompt === 'function'
                ? globalThis.prompt.bind(globalThis)
                : null);
    const confirmFn =
        typeof options.confirm === 'function'
            ? options.confirm
            : (typeof globalThis !== 'undefined' && typeof globalThis.confirm === 'function'
                ? globalThis.confirm.bind(globalThis)
                : null);

    const presets = Array.isArray(options.initialPresets) ? [...options.initialPresets] : [];
    let activeId = null;
    let barVisible = false;

    const tmpVec3 = THREE ? new THREE.Vector3() : null;

    function snapshotCurrentView() {
        if (!camera || !controls) return null;
        return {
            id: makeId(),
            name: '',
            position: camera.position?.toArray?.() || [0, 0, 0],
            target: controls.target?.toArray?.() || [0, 0, 0],
            up: camera.up?.toArray?.() || [0, 1, 0],
            fov: camera.fov,
            zoom: camera.zoom,
            near: camera.near,
            far: camera.far,
        };
    }

    function applyPreset(preset) {
        if (!preset || !camera || !controls) return false;

        const pos = Array.isArray(preset.position) ? preset.position : null;
        const tgt = Array.isArray(preset.target) ? preset.target : null;
        const up = Array.isArray(preset.up) ? preset.up : null;

        if (pos?.length >= 3) camera.position.set(pos[0], pos[1], pos[2]);
        if (tgt?.length >= 3) controls.target.set(tgt[0], tgt[1], tgt[2]);
        if (up?.length >= 3 && camera.up?.set) camera.up.set(up[0], up[1], up[2]);

        if (typeof preset.fov === 'number' && Number.isFinite(preset.fov)) camera.fov = preset.fov;
        if (typeof preset.zoom === 'number' && Number.isFinite(preset.zoom)) camera.zoom = preset.zoom;
        if (typeof preset.near === 'number' && Number.isFinite(preset.near)) camera.near = preset.near;
        if (typeof preset.far === 'number' && Number.isFinite(preset.far)) camera.far = preset.far;
        camera.updateProjectionMatrix?.();

        controls.update?.();
        requestRender();
        return true;
    }

    function getPresetById(id) {
        if (!id) return null;
        return presets.find((p) => p && p.id === id) || null;
    }

    function setActive(id) {
        activeId = id || null;
        render();
    }

    function makePresetButton(preset, { active = false } = {}) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn cam-chip';
        btn.dataset.action = 'goto';
        btn.dataset.id = preset.id;
        if (active) btn.classList.add('active');

        const name = document.createElement('span');
        name.className = 'cam-name';
        name.textContent = preset.name || 'Camera';

        const del = document.createElement('span');
        del.className = 'cam-x';
        del.textContent = '×';
        del.title = 'Удалить камеру';
        del.setAttribute('aria-label', 'Удалить камеру');
        del.dataset.action = 'delete';
        del.dataset.id = preset.id;

        btn.appendChild(name);
        btn.appendChild(del);
        return btn;
    }

    function renderBar() {
        if (!camsBarListEl) return;
        camsBarListEl.innerHTML = '';

        presets.forEach((preset) => {
            camsBarListEl.appendChild(
                makePresetButton(preset, { active: activeId && preset.id === activeId }),
            );
        });

        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'btn cam-add';
        add.textContent = '+';
        add.title = 'Создать камеру из текущего вида';
        add.setAttribute('aria-label', 'Создать камеру из текущего вида');
        add.dataset.action = 'add';
        camsBarListEl.appendChild(add);
    }

    function renderSide() {
        if (!camsSideListEl) return;
        camsSideListEl.innerHTML = '';

        presets.forEach((preset) => {
            const row = document.createElement('div');
            row.className = 'cams-side-item';
            row.appendChild(
                makePresetButton(preset, { active: activeId && preset.id === activeId }),
            );
            camsSideListEl.appendChild(row);
        });

        if (presets.length) return;

        const hint = document.createElement('div');
        hint.className = 'muted';
        hint.style.fontSize = '12px';
        hint.textContent = 'Камер пока нет. Нажмите CAMS → “+” чтобы сохранить текущий вид.';
        camsSideListEl.appendChild(hint);
    }

    function updateCounts() {
        if (camsCountEl) camsCountEl.textContent = String(presets.length);
    }

    function render() {
        updateCounts();
        renderBar();
        renderSide();
    }

    function setBarVisible(nextVisible) {
        barVisible = !!nextVisible;
        if (camsBarEl) camsBarEl.hidden = !barVisible;
        if (camsToggleBtn) {
            camsToggleBtn.classList.toggle('active', barVisible);
            camsToggleBtn.setAttribute('aria-pressed', barVisible ? 'true' : 'false');
        }
    }

    function toggleBarVisible() {
        setBarVisible(!barVisible);
    }

    function addFromCurrentView() {
        const snap = snapshotCurrentView();
        if (!snap) return null;

        const defaultName = `Cam ${presets.length + 1}`;
        const nameRaw = safePrompt(promptFn, 'Как назвать эту камеру?', defaultName);
        if (nameRaw == null) return null;
        const name = nameRaw.trim() || defaultName;
        snap.name = name;

        presets.push(snap);
        setActive(snap.id);
        render();
        return snap;
    }

    function deletePreset(id) {
        const preset = getPresetById(id);
        if (!preset) return false;
        const ok = safeConfirm(confirmFn, `Вы точно хотите удалить камеру “${preset.name || 'Camera'}”?`);
        if (!ok) return false;

        const idx = presets.findIndex((p) => p && p.id === id);
        if (idx < 0) return false;
        presets.splice(idx, 1);
        if (activeId === id) activeId = null;
        render();
        return true;
    }

    function handleAction(action, id) {
        if (action === 'add') {
            addFromCurrentView();
            return;
        }
        if (action === 'goto') {
            const preset = getPresetById(id);
            if (!preset) return;
            if (applyPreset(preset)) setActive(preset.id);
            return;
        }
        if (action === 'delete') {
            deletePreset(id);
        }
    }

    function attachListHandler(container) {
        if (!container?.addEventListener) return;
        container.addEventListener('click', (event) => {
            const el = event?.target;
            if (!(el instanceof HTMLElement)) return;
            const actionEl = el.closest?.('[data-action]');
            if (!(actionEl instanceof HTMLElement)) return;
            const action = actionEl.dataset?.action;
            if (!action) return;
            const id = actionEl.dataset?.id || null;
            handleAction(action, id);
        });
    }

    attachListHandler(camsBarListEl);
    attachListHandler(camsSideListEl);
    camsToggleBtn?.addEventListener?.('click', toggleBarVisible);

    // initialize
    setBarVisible(false);
    render();

    function dispose() {
        // currently no-op (we only attach simple handlers once per page lifetime)
    }

    function captureDebugPoint() {
        if (!camera || !controls || !tmpVec3) return null;
        tmpVec3.copy(camera.position);
        return {
            position: tmpVec3.toArray(),
            target: controls.target?.toArray?.() || [0, 0, 0],
        };
    }

    return Object.freeze({
        getPresets: () => [...presets],
        addFromCurrentView,
        deletePreset,
        applyPreset,
        setActive,
        setBarVisible,
        isBarVisible: () => barVisible,
        dispose,
        captureDebugPoint,
    });
}
