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
    const requestLayout = typeof options.requestLayout === 'function' ? options.requestLayout : () => {};

    const camsToggleBtn = options.camsToggleBtn || null;
    const camsBarEl = options.camsBarEl || null;
    const camsBarListEl = options.camsBarListEl || null;
    const camsDetailsEl = options.camsDetailsEl || null;
    const camsCountEl = options.camsCountEl || null;
    const camsSideListEl = options.camsSideListEl || null;
    const camPropsDetailsEl = options.camPropsDetailsEl || null;
    const camPropsTitleEl = options.camPropsTitleEl || null;
    const camPropsPanelEl = options.camPropsPanelEl || null;

    const promptFn =
        typeof options.prompt === 'function'
            ? options.prompt
            : (typeof globalThis !== 'undefined' && typeof globalThis.prompt === 'function'
                ? globalThis.prompt.bind(globalThis)
                : null);
    const promptCameraName =
        typeof options.promptCameraName === 'function'
            ? options.promptCameraName
            : null;
    const confirmFn =
        typeof options.confirm === 'function'
            ? options.confirm
            : (typeof globalThis !== 'undefined' && typeof globalThis.confirm === 'function'
                ? globalThis.confirm.bind(globalThis)
                : null);

    const presets = Array.isArray(options.initialPresets) ? [...options.initialPresets] : [];
    let activeId = null;
    let barVisible = false;
    let dragId = null;
    let suppressClicksUntil = 0;
    let editingId = null;
    let propsUI = null;

    const tmpVec3 = THREE ? new THREE.Vector3() : null;

    function readCameraShift() {
        const view = camera?.view;
        if (!view || !view.enabled) return { shiftX: 0, shiftY: 0 };

        const fullWidth = Number.isFinite(view.fullWidth) ? view.fullWidth : 1;
        const fullHeight = Number.isFinite(view.fullHeight) ? view.fullHeight : 1;
        const offsetX = Number.isFinite(view.offsetX) ? view.offsetX : 0;
        const offsetY = Number.isFinite(view.offsetY) ? view.offsetY : 0;

        return {
            shiftX: fullWidth ? offsetX / fullWidth : 0,
            shiftY: fullHeight ? offsetY / fullHeight : 0,
        };
    }

    function snapshotCurrentView() {
        if (!camera || !controls) return null;
        const shift = readCameraShift();
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
            shiftX: shift.shiftX,
            shiftY: shift.shiftY,
        };
    }

    function captureCurrentViewData() {
        if (!camera || !controls) return null;
        const shift = readCameraShift();
        return {
            position: camera.position?.toArray?.() || [0, 0, 0],
            target: controls.target?.toArray?.() || [0, 0, 0],
            up: camera.up?.toArray?.() || [0, 1, 0],
            fov: camera.fov,
            zoom: camera.zoom,
            near: camera.near,
            far: camera.far,
            shiftX: shift.shiftX,
            shiftY: shift.shiftY,
        };
    }

    function applyCameraShift(shiftX, shiftY) {
        if (!camera) return;
        const sx = Number.isFinite(shiftX) ? shiftX : 0;
        const sy = Number.isFinite(shiftY) ? shiftY : 0;

        const eps = 1e-9;
        if (Math.abs(sx) < eps && Math.abs(sy) < eps) {
            camera.clearViewOffset?.();
            return;
        }

        // Store as normalized offsets (fullWidth/fullHeight = 1) so we can persist shifts without depending on pixels.
        camera.setViewOffset?.(1, 1, sx, sy, 1, 1);
        if (camera.view) camera.view.enabled = true;
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
        applyCameraShift(preset.shiftX, preset.shiftY);
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

    function setPropsPanelVisible(visible) {
        if (!camPropsDetailsEl) return;
        camPropsDetailsEl.hidden = !visible;
        if (visible) camPropsDetailsEl.open = true;
    }

    function setPropsTitle(text) {
        if (camPropsTitleEl) camPropsTitleEl.textContent = text || '—';
    }

    function updatePresetLabels(preset) {
        if (!preset) return;
        const name = preset.name || 'Camera';
        setPropsTitle(name);

        const updateIn = (container) => {
            if (!container?.querySelectorAll) return;
            container.querySelectorAll(`.cam-chip[data-id="${preset.id}"] .cam-name`)
                .forEach((el) => { el.textContent = name; });
        };
        updateIn(camsBarListEl);
        updateIn(camsSideListEl);
    }

    function makeLabel(text, inputEl) {
        const label = document.createElement('label');
        label.className = 'cam-props-field';
        const cap = document.createElement('span');
        cap.className = 'cam-props-cap';
        cap.textContent = text;
        label.appendChild(cap);
        label.appendChild(inputEl);
        return label;
    }

    function makeNumberInput({ step = '0.01', min = null, max = null } = {}) {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = step;
        if (min != null) input.min = String(min);
        if (max != null) input.max = String(max);
        input.inputMode = 'decimal';
        return input;
    }

    function ensurePropsUI() {
        if (!camPropsPanelEl) return null;
        if (propsUI) return propsUI;

        camPropsPanelEl.innerHTML = '';

        const root = document.createElement('div');
        root.className = 'cam-props-root';

        const nameRow = document.createElement('div');
        nameRow.className = 'cam-props-row';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.spellcheck = false;
        nameInput.placeholder = 'Имя камеры';
        nameInput.className = 'cam-props-text';
        const nameLabel = makeLabel('Name', nameInput);
        nameRow.appendChild(nameLabel);

        const makeVec3Group = (title) => {
            const group = document.createElement('div');
            group.className = 'cam-props-group';
            const head = document.createElement('div');
            head.className = 'cam-props-head';
            head.textContent = title;
            const grid = document.createElement('div');
            grid.className = 'cam-props-grid';
            const x = makeNumberInput();
            const y = makeNumberInput();
            const z = makeNumberInput();
            grid.appendChild(makeLabel('X', x));
            grid.appendChild(makeLabel('Y', y));
            grid.appendChild(makeLabel('Z', z));
            group.appendChild(head);
            group.appendChild(grid);
            return { group, x, y, z };
        };

        const pos = makeVec3Group('Position');
        const tgt = makeVec3Group('Target');
        const up = makeVec3Group('Up');

        const lensGroup = document.createElement('div');
        lensGroup.className = 'cam-props-group';
        const lensHead = document.createElement('div');
        lensHead.className = 'cam-props-head';
        lensHead.textContent = 'Lens';
        const lensGrid = document.createElement('div');
        lensGrid.className = 'cam-props-grid cam-props-grid-2';

        const fovInput = makeNumberInput({ step: '0.1', min: 1, max: 179 });
        const zoomInput = makeNumberInput({ step: '0.01', min: 0.01 });
        const nearInput = makeNumberInput({ step: '0.001', min: 0.0001 });
        const farInput = makeNumberInput({ step: '1', min: 0.1 });

        lensGrid.appendChild(makeLabel('FOV', fovInput));
        lensGrid.appendChild(makeLabel('Zoom', zoomInput));
        lensGrid.appendChild(makeLabel('Near', nearInput));
        lensGrid.appendChild(makeLabel('Far', farInput));
        lensGroup.appendChild(lensHead);
        lensGroup.appendChild(lensGrid);

        const shiftGroup = document.createElement('div');
        shiftGroup.className = 'cam-props-group';
        const shiftHead = document.createElement('div');
        shiftHead.className = 'cam-props-head';
        shiftHead.textContent = 'Shift';
        const shiftGrid = document.createElement('div');
        shiftGrid.className = 'cam-props-grid cam-props-grid-2';
        const shiftXInput = makeNumberInput({ step: '0.001', min: -1, max: 1 });
        const shiftYInput = makeNumberInput({ step: '0.001', min: -1, max: 1 });
        shiftGrid.appendChild(makeLabel('Shift X', shiftXInput));
        shiftGrid.appendChild(makeLabel('Shift Y', shiftYInput));
        shiftGroup.appendChild(shiftHead);
        shiftGroup.appendChild(shiftGrid);

        const hint = document.createElement('div');
        hint.className = 'muted cam-props-hint';
        hint.textContent = 'Кнопка ⟳ обновляет сохранённый вид, ⚙ открывает свойства. Изменения сохраняются за камерой.';

        root.appendChild(nameRow);
        root.appendChild(pos.group);
        root.appendChild(tgt.group);
        root.appendChild(up.group);
        root.appendChild(lensGroup);
        root.appendChild(shiftGroup);
        root.appendChild(hint);
        camPropsPanelEl.appendChild(root);

        const readNum = (input, fallback) => {
            const v = Number.parseFloat(input.value);
            return Number.isFinite(v) ? v : fallback;
        };

        const writeVec3 = (arr, x, y, z) => {
            if (!Array.isArray(arr) || arr.length < 3) return;
            x.value = String(arr[0] ?? 0);
            y.value = String(arr[1] ?? 0);
            z.value = String(arr[2] ?? 0);
        };

        const applyFromInputs = () => {
            const preset = getPresetById(editingId);
            if (!preset) return;

            preset.name = String(nameInput.value || '').trim() || preset.name || 'Camera';

            if (Array.isArray(preset.position) && preset.position.length >= 3) {
                preset.position = [
                    readNum(pos.x, preset.position[0]),
                    readNum(pos.y, preset.position[1]),
                    readNum(pos.z, preset.position[2]),
                ];
            }
            if (Array.isArray(preset.target) && preset.target.length >= 3) {
                preset.target = [
                    readNum(tgt.x, preset.target[0]),
                    readNum(tgt.y, preset.target[1]),
                    readNum(tgt.z, preset.target[2]),
                ];
            }
            if (Array.isArray(preset.up) && preset.up.length >= 3) {
                preset.up = [
                    readNum(up.x, preset.up[0]),
                    readNum(up.y, preset.up[1]),
                    readNum(up.z, preset.up[2]),
                ];
            }

            preset.fov = readNum(fovInput, preset.fov);
            preset.zoom = readNum(zoomInput, preset.zoom);
            preset.near = readNum(nearInput, preset.near);
            preset.far = readNum(farInput, preset.far);
            preset.shiftX = readNum(shiftXInput, preset.shiftX ?? 0);
            preset.shiftY = readNum(shiftYInput, preset.shiftY ?? 0);

            updatePresetLabels(preset);
            if (activeId === preset.id) applyPreset(preset);
        };

        nameInput.addEventListener('change', applyFromInputs);
        [pos.x, pos.y, pos.z, tgt.x, tgt.y, tgt.z, up.x, up.y, up.z, fovInput, zoomInput, nearInput, farInput, shiftXInput, shiftYInput]
            .forEach((input) => input.addEventListener('input', applyFromInputs));

        propsUI = {
            nameInput,
            pos,
            tgt,
            up,
            fovInput,
            zoomInput,
            nearInput,
            farInput,
            shiftXInput,
            shiftYInput,
            writeVec3,
        };
        return propsUI;
    }

    function syncPropsPanel(preset) {
        const ui = ensurePropsUI();
        if (!ui || !preset) return;

        ui.nameInput.value = preset.name || '';
        ui.writeVec3(preset.position, ui.pos.x, ui.pos.y, ui.pos.z);
        ui.writeVec3(preset.target, ui.tgt.x, ui.tgt.y, ui.tgt.z);
        ui.writeVec3(preset.up, ui.up.x, ui.up.y, ui.up.z);
        ui.fovInput.value = String(preset.fov ?? '');
        ui.zoomInput.value = String(preset.zoom ?? '');
        ui.nearInput.value = String(preset.near ?? '');
        ui.farInput.value = String(preset.far ?? '');
        ui.shiftXInput.value = String(preset.shiftX ?? 0);
        ui.shiftYInput.value = String(preset.shiftY ?? 0);

        updatePresetLabels(preset);
    }

    function openPropsForPresetId(id) {
        const preset = getPresetById(id);
        if (!preset) return;
        editingId = id;

        if (typeof document !== 'undefined') {
            document.body?.classList?.remove?.('side-hidden');
        }

        setPropsPanelVisible(true);
        syncPropsPanel(preset);
        camPropsDetailsEl?.scrollIntoView?.({ block: 'nearest' });
        requestLayout();
    }

    function makePresetButton(preset, { active = false } = {}) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn cam-chip';
        btn.dataset.action = 'goto';
        btn.dataset.id = preset.id;
        btn.draggable = true;
        if (active) btn.classList.add('active');

        const name = document.createElement('span');
        name.className = 'cam-name';
        name.textContent = preset.name || 'Camera';

        const actions = document.createElement('span');
        actions.className = 'cam-actions';

        const refresh = document.createElement('span');
        refresh.className = 'cam-icon cam-refresh';
        refresh.textContent = '⟳\uFE0E';
        refresh.title = 'Обновить камеру из текущего вида';
        refresh.setAttribute('aria-label', 'Обновить камеру из текущего вида');
        refresh.dataset.action = 'update';
        refresh.dataset.id = preset.id;
        refresh.draggable = false;

        const props = document.createElement('span');
        props.className = 'cam-icon cam-props';
        props.textContent = '⚙\uFE0E';
        props.title = 'Свойства камеры';
        props.setAttribute('aria-label', 'Свойства камеры');
        props.dataset.action = 'props';
        props.dataset.id = preset.id;
        props.draggable = false;

        const del = document.createElement('span');
        del.className = 'cam-icon cam-x';
        del.textContent = '×';
        del.title = 'Удалить камеру';
        del.setAttribute('aria-label', 'Удалить камеру');
        del.dataset.action = 'delete';
        del.dataset.id = preset.id;
        del.draggable = false;

        actions.appendChild(refresh);
        actions.appendChild(props);
        actions.appendChild(del);

        btn.appendChild(name);
        btn.appendChild(actions);
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
        if (barVisible) requestLayout();
    }

    function setBarVisible(nextVisible) {
        barVisible = !!nextVisible;
        if (camsBarEl) camsBarEl.hidden = !barVisible;
        if (camsToggleBtn) {
            camsToggleBtn.classList.toggle('active', barVisible);
            camsToggleBtn.setAttribute('aria-pressed', barVisible ? 'true' : 'false');
        }
        requestLayout();
    }

    function toggleBarVisible() {
        setBarVisible(!barVisible);
    }

    async function addFromCurrentView() {
        const snap = snapshotCurrentView();
        if (!snap) return null;

        const defaultName = `Cam ${presets.length + 1}`;
        let nameRaw = null;
        if (promptCameraName) {
            try {
                nameRaw = await Promise.resolve(promptCameraName(defaultName));
            } catch (_) {
                nameRaw = null;
            }
        }
        if (nameRaw == null) {
            nameRaw = safePrompt(promptFn, 'Имя камеры', defaultName);
        }
        if (nameRaw == null) return null;
        const name = String(nameRaw).trim() || defaultName;
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
        if (editingId === id) {
            editingId = null;
            setPropsPanelVisible(false);
        }
        render();
        return true;
    }

    function updatePresetFromCurrentView(id) {
        const preset = getPresetById(id);
        if (!preset) return false;
        const snap = captureCurrentViewData();
        if (!snap) return false;

        preset.position = snap.position;
        preset.target = snap.target;
        preset.up = snap.up;
        preset.fov = snap.fov;
        preset.zoom = snap.zoom;
        preset.near = snap.near;
        preset.far = snap.far;
        preset.shiftX = snap.shiftX;
        preset.shiftY = snap.shiftY;

        if (editingId === id) syncPropsPanel(preset);
        return true;
    }

    function movePreset(fromId, toIndex) {
        const fromIndex = presets.findIndex((p) => p && p.id === fromId);
        if (fromIndex < 0) return false;
        if (!Number.isFinite(toIndex)) return false;

        const [moved] = presets.splice(fromIndex, 1);
        const nextIndex = Math.max(0, Math.min(presets.length, toIndex));
        presets.splice(nextIndex, 0, moved);
        render();
        return true;
    }

    function handleAction(action, id) {
        if (action === 'add') {
            void addFromCurrentView();
            return;
        }
        if (action === 'update') {
            updatePresetFromCurrentView(id);
            return;
        }
        if (action === 'props') {
            const preset = getPresetById(id);
            if (!preset) return;
            if (applyPreset(preset)) setActive(preset.id);
            openPropsForPresetId(preset.id);
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
            if (Date.now() < suppressClicksUntil) {
                event?.preventDefault?.();
                return;
            }
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

    function attachBarReorder(container) {
        if (!container?.addEventListener) return;

        const findChip = (el) => {
            const node = el?.closest?.('.cam-chip[data-id]');
            if (!(node instanceof HTMLElement)) return null;
            return node;
        };

        const computeInsertIndex = (clientX, fromId) => {
            const chips = Array.from(container.querySelectorAll('.cam-chip[data-id]'));
            for (const chip of chips) {
                const id = chip.dataset?.id;
                if (!id || id === fromId) continue;
                const rect = chip.getBoundingClientRect?.();
                if (!rect) continue;
                if (clientX < rect.left + rect.width / 2) {
                    return presets.findIndex((p) => p && p.id === id);
                }
            }
            return presets.length;
        };

        container.addEventListener('dragstart', (event) => {
            const el = event?.target;
            if (!(el instanceof HTMLElement)) return;
            const chip = findChip(el);
            if (!chip) return;
            const id = chip.dataset?.id;
            if (!id) return;

            dragId = id;
            chip.classList.add('dragging');

            const dt = event.dataTransfer;
            if (dt) {
                dt.effectAllowed = 'move';
                try { dt.setData('text/plain', id); } catch (_) {}
            }
        });

        container.addEventListener('dragenter', (event) => {
            if (!dragId) return;
            event.preventDefault();
        });

        container.addEventListener('dragover', (event) => {
            if (!dragId) return;
            event.preventDefault();
            const dt = event.dataTransfer;
            if (dt) dt.dropEffect = 'move';
        });

        container.addEventListener('drop', (event) => {
            event.preventDefault();

            const fromId =
                dragId ||
                (() => {
                    try { return event.dataTransfer?.getData?.('text/plain') || null; } catch (_) { return null; }
                })();
            if (!fromId) return;

            const fromIndex = presets.findIndex((p) => p && p.id === fromId);
            if (fromIndex < 0) return;

            let insertIndex = computeInsertIndex(event.clientX, fromId);
            if (!Number.isFinite(insertIndex)) insertIndex = presets.length;
            if (fromIndex < insertIndex) insertIndex -= 1;
            movePreset(fromId, insertIndex);
            suppressClicksUntil = Date.now() + 350;
        });

        container.addEventListener('dragend', (event) => {
            const el = event?.target;
            if (el instanceof HTMLElement) {
                const chip = findChip(el);
                chip?.classList?.remove?.('dragging');
            }
            dragId = null;
        });
    }

    attachListHandler(camsBarListEl);
    attachListHandler(camsSideListEl);
    attachBarReorder(camsBarListEl);
    camsToggleBtn?.addEventListener?.('click', toggleBarVisible);

    // initialize
    setBarVisible(false);
    setPropsPanelVisible(false);
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
