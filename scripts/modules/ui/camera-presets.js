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
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    return template.replace(/[xy]/g, (ch) => {
        const rnd = Math.floor(Math.random() * 16);
        const val = ch === 'x' ? rnd : (rnd & 0x3) | 0x8;
        return val.toString(16);
    });
}

export function createCameraPresetsController(options = {}) {
    const THREE = options.THREE || null;
    const camera = options.camera || null;
    const controls = options.controls || null;
    const annotateCanvasEl = options.annotateCanvasEl || null;
    const annotateToolbarEl = options.annotateToolbarEl || null;
    const annoToggleBtn = options.annoToggleBtn || null;
    const annoVisibleBtn = options.annoVisibleBtn || null;
    const annoDrawBtn = options.annoDrawBtn || null;
    const annoColorEl = options.annoColorEl || null;
    const annoDashEl = options.annoDashEl || null;
    const annoWidthEl = options.annoWidthEl || null;
    const annoUndoBtn = options.annoUndoBtn || null;
    const annoClearBtn = options.annoClearBtn || null;
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
    const annotationsEnabled = options.annotationsEnabled !== false;

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
    const promptTransition =
        typeof options.promptTransition === 'function'
            ? options.promptTransition
            : null;
    const promptAnnotationText =
        typeof options.promptAnnotationText === 'function'
            ? options.promptAnnotationText
            : null;
    const onChange =
        typeof options.onChange === 'function'
            ? options.onChange
            : null;
    const confirmCameraDelete =
        typeof options.confirmCameraDelete === 'function'
            ? options.confirmCameraDelete
            : null;
    const confirmFn =
        typeof options.confirm === 'function'
            ? options.confirm
            : (typeof globalThis !== 'undefined' && typeof globalThis.confirm === 'function'
                ? globalThis.confirm.bind(globalThis)
                : null);

    const presets = Array.isArray(options.initialPresets) ? [...options.initialPresets] : [];
    const transitions = new Map();
    let activeId = null;
    let lastCreatedId = null;
    let barVisible = false;
    let dragId = null;
    let suppressClicksUntil = 0;
    let editingId = null;
    let propsUI = null;
    let playToken = 0;
    let playing = false;
    let changeTimer = null;
    let suppressChange = false;
    let disposed = false;
    let transitionRafToken = 0;
    let transitionAbort = null;
    let stateVersion = 0;
    const cleanupFns = [];

    function addListener(target, type, handler, options) {
        if (!target?.addEventListener || typeof handler !== 'function') return false;
        target.addEventListener(type, handler, options);
        cleanupFns.push(() => {
            try {
                target.removeEventListener(type, handler, options);
            } catch (_) {}
        });
        return true;
    }

    function requestAnimationFrameSafe(callback) {
        if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
        return setTimeout(() => callback(Date.now()), 16);
    }

    function cancelAnimationFrameSafe(token) {
        if (!token) return;
        if (typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(token);
        } else {
            clearTimeout(token);
        }
    }

    function cancelActiveTransition() {
        if (transitionRafToken) {
            cancelAnimationFrameSafe(transitionRafToken);
            transitionRafToken = 0;
        }
        const abort = transitionAbort;
        transitionAbort = null;
        abort?.();
    }

    function stopPlayback({ updateUi = true } = {}) {
        playToken += 1;
        playing = false;
        cancelActiveTransition();
        if (updateUi && !disposed) render();
    }

    const tmpVec3 = THREE ? new THREE.Vector3() : null;
    ensureDefaultPreset();
    const annotations = annotationsEnabled ? createAnnotationsController() : createNullAnnotationsController();
    let annoToolbarReady = false;
    let annoHotkeysReady = false;

    function setAnnotationsToolbarVisible(visible) {
        if (!annotationsEnabled || !annotateToolbarEl) return;
        const next = !!visible;
        annotateToolbarEl.hidden = !next;
        if (annoToggleBtn) {
            annoToggleBtn.classList.toggle('active', next);
            annoToggleBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
        }
        syncAnnotationsToolbar();
    }

    function toggleAnnotationsToolbarVisible() {
        if (!annotationsEnabled || !annotateToolbarEl) return;
        setAnnotationsToolbarVisible(!!annotateToolbarEl.hidden);
    }

    function syncAnnotationsToolbar() {
        if (!annotationsEnabled || !annotateToolbarEl) return;
        const visible = annotations.getVisibleForActivePreset();
        const drawing = annotations.getDrawEnabled();

        if (annoVisibleBtn) annoVisibleBtn.classList.toggle('active', !!visible);
        if (annoDrawBtn) annoDrawBtn.classList.toggle('active', !!drawing);

        const tool = annotations.getTool();
        annotateToolbarEl.querySelectorAll?.('.anno-tool')?.forEach((btn) => {
            const t = btn?.dataset?.tool;
            btn.classList.toggle('active', t && t === tool);
        });

        if (annoColorEl && typeof annoColorEl.value === 'string') annoColorEl.value = annotations.getColor();
        if (annoDashEl && typeof annoDashEl.value === 'string') annoDashEl.value = annotations.getDash();
        if (annoWidthEl) annoWidthEl.value = String(annotations.getWidth());
    }

    function ensureAnnotationsToolbar() {
        if (!annotationsEnabled || !annotateToolbarEl || annoToolbarReady) return;
        annoToolbarReady = true;

        addListener(annotateToolbarEl, 'click', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const btn = target.closest?.('.anno-tool');
            if (!btn) return;
            const tool = btn.dataset.tool;
            if (!tool) return;
            annotations.setTool(tool);
            annotations.setVisibleForActivePreset(true);
            annotations.setDrawEnabled(true);
            syncAnnotationsToolbar();
        });

        addListener(annoVisibleBtn, 'click', () => {
            const next = !annotations.getVisibleForActivePreset();
            if (!next) annotations.setDrawEnabled(false);
            annotations.setVisibleForActivePreset(next);
            syncAnnotationsToolbar();
        });

        addListener(annoDrawBtn, 'click', () => {
            const next = !annotations.getDrawEnabled();
            if (next) annotations.setVisibleForActivePreset(true);
            annotations.setDrawEnabled(next);
            syncAnnotationsToolbar();
        });

        addListener(annoUndoBtn, 'click', () => {
            annotations.undo();
            syncAnnotationsToolbar();
        });

        addListener(annoClearBtn, 'click', () => {
            annotations.clear();
            syncAnnotationsToolbar();
        });

        addListener(annoColorEl, 'input', () => {
            annotations.setColor(annoColorEl.value);
            syncAnnotationsToolbar();
        });

        addListener(annoDashEl, 'change', () => {
            annotations.setDash(annoDashEl.value);
            syncAnnotationsToolbar();
        });

        addListener(annoWidthEl, 'input', () => {
            annotations.setWidth(annoWidthEl.value);
            syncAnnotationsToolbar();
        });

        syncAnnotationsToolbar();
    }

    if (annotationsEnabled) {
        ensureAnnotationsToolbar();
        setAnnotationsToolbarVisible(false);
        addListener(annoToggleBtn, 'click', toggleAnnotationsToolbarVisible);
    }

    function isEditableElement(el) {
        if (!el) return false;
        const tag = String(el.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        if (el.isContentEditable) return true;
        return false;
    }

    function isAnyModalOpen() {
        if (typeof document === 'undefined') return false;
        return !!document.querySelector?.('.modal.show');
    }

    function ensureAnnotationsHotkeys() {
        if (!annotationsEnabled || annoHotkeysReady) return;
        const win =
            (typeof globalThis !== 'undefined' ? globalThis.window : null) ||
            null;
        if (!win?.addEventListener) return;
        annoHotkeysReady = true;

        const repeatSensitiveCodes = new Set(['KeyX', 'KeyH', 'Escape', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']);
        const toolByDigit = Object.freeze({
            Digit1: 'pencil',
            Digit2: 'line',
            Digit3: 'rect',
            Digit4: 'circle',
            Digit5: 'text',
        });

        addListener(win, 'keydown', (event) => {
            if (!event) return;
            if (event.defaultPrevented) return;
            if (isAnyModalOpen()) return;
            if (isEditableElement(event.target)) return;

            const code = event.code;

            // Undo (Ctrl+Z / ⌘Z)
            if ((event.ctrlKey || event.metaKey) && code === 'KeyZ' && !event.shiftKey) {
                if (annotations.undo()) syncAnnotationsToolbar();
                event.preventDefault?.();
                return;
            }

            if (event.ctrlKey || event.metaKey || event.altKey) return;

            if (event.repeat && repeatSensitiveCodes.has(code)) return;

            if (code === 'KeyX') {
                const next = !annotations.getDrawEnabled();
                if (next) annotations.setVisibleForActivePreset(true);
                annotations.setDrawEnabled(next);
                syncAnnotationsToolbar();
                event.preventDefault?.();
                return;
            }

            if (code === 'Escape') {
                if (annotations.getDrawEnabled()) {
                    annotations.setDrawEnabled(false);
                    syncAnnotationsToolbar();
                    event.preventDefault?.();
                }
                return;
            }

            if (code === 'KeyH') {
                const next = !annotations.getVisibleForActivePreset();
                if (!next) annotations.setDrawEnabled(false);
                annotations.setVisibleForActivePreset(next);
                syncAnnotationsToolbar();
                event.preventDefault?.();
                return;
            }

            const tool = toolByDigit[code];
            if (tool) {
                annotations.setTool(tool);
                annotations.setVisibleForActivePreset(true);
                annotations.setDrawEnabled(true);
                syncAnnotationsToolbar();
                event.preventDefault?.();
                return;
            }

            if (code === 'BracketLeft' || code === 'BracketRight') {
                const delta = code === 'BracketRight' ? 1 : -1;
                annotations.setWidth(annotations.getWidth() + delta);
                syncAnnotationsToolbar();
                event.preventDefault?.();
                return;
            }
        });
    }

    if (annotationsEnabled) ensureAnnotationsHotkeys();

    function normalizePoint(p) {
        return {
            x: Math.min(1, Math.max(0, Number(p?.x) || 0)),
            y: Math.min(1, Math.max(0, Number(p?.y) || 0)),
        };
    }

    function getActivePreset() {
        return activeId ? getPresetById(activeId) : null;
    }

    function ensureAnnotationsDefaults(preset) {
        if (!preset || typeof preset !== 'object') return;
        if (!Array.isArray(preset.annotations)) preset.annotations = [];
        if (typeof preset.annotationsVisible !== 'boolean') preset.annotationsVisible = true;
    }

    function ensureDefaultPreset() {
        if (presets.length) {
            if (!activeId && presets[0]?.id) activeId = presets[0].id;
            if (!lastCreatedId && activeId) lastCreatedId = activeId;
            return;
        }

        const snap = snapshotCurrentView();
        if (!snap) return;
        snap.name = 'Cam 1';
        snap.isDefault = true;
        presets.push(snap);
        activeId = snap.id;
        lastCreatedId = snap.id;
    }

    function clonePreset(preset) {
        if (!preset) return null;
        return {
            ...preset,
            position: Array.isArray(preset.position) ? [...preset.position] : preset.position,
            target: Array.isArray(preset.target) ? [...preset.target] : preset.target,
            up: Array.isArray(preset.up) ? [...preset.up] : preset.up,
            annotations: Array.isArray(preset.annotations) ? [...preset.annotations] : preset.annotations,
        };
    }

    function serializeTransitions() {
        const result = [];
        transitions.forEach((value, key) => {
            const [fromId, toId] = String(key).split('->');
            if (!fromId || !toId) return;
            result.push({
                fromId,
                toId,
                seconds: value?.seconds ?? 0,
                type: value?.type ?? 'ease-in-out',
                trajectory: value?.trajectory ?? 'linear',
            });
        });
        return result;
    }

    function scheduleChange() {
        if (disposed) return;
        if (!onChange || suppressChange) return;
        if (changeTimer) clearTimeout(changeTimer);
        changeTimer = setTimeout(() => {
            changeTimer = null;
            if (disposed) return;
            if (suppressChange) return;
            onChange({
                presets: presets.map(clonePreset).filter((p) => p),
                transitions: serializeTransitions(),
                activeId,
                lastCreatedId,
            });
        }, 200);
    }

    function markStateDirty() {
        stateVersion += 1;
        scheduleChange();
    }

    function loadState(state = {}) {
        if (disposed) return false;
        const nextPresets = Array.isArray(state.presets) ? state.presets : null;
        if (!nextPresets) return false;
        suppressChange = true;
        presets.length = 0;
        nextPresets.forEach((preset) => {
            if (!preset) return;
            const clone = clonePreset(preset);
            if (!clone.id) clone.id = makeId();
            presets.push(clone);
        });
        transitions.clear();
        const nextTransitions = Array.isArray(state.transitions) ? state.transitions : [];
        nextTransitions.forEach((tr) => {
            if (!tr?.fromId || !tr?.toId) return;
            transitions.set(transitionKey(tr.fromId, tr.toId), {
                seconds: Math.max(0, Number(tr.seconds) || 0),
                type: normalizeTransitionType(tr.type),
                trajectory: normalizeTransitionTrajectory(tr.trajectory),
            });
        });
        ensureDefaultPreset();
        const nextActive = state.activeId && presets.some((p) => p.id === state.activeId)
            ? state.activeId
            : presets[0]?.id || null;
        const nextLast = state.lastCreatedId && presets.some((p) => p.id === state.lastCreatedId)
            ? state.lastCreatedId
            : nextActive;
        activeId = nextActive;
        lastCreatedId = nextLast;
        suppressChange = false;
        stateVersion += 1;
        render();
        return true;
    }

    function createAnnotationsController() {
        const canvas = annotateCanvasEl;
        const ctx = canvas?.getContext?.('2d', { alpha: true }) || null;
        let dpr = 1;
        let rect = null;

        let drawEnabled = false;
        let tool = 'pencil'; // pencil | line | rect | circle | text
        let dash = 'solid'; // solid | dashed | dotted
        let color = '#ffcc00';
        let width = 3;

        let draft = null;
        let draftPresetId = null;
        let pointerId = null;
        let prevControlsEnabled = null;
        let redrawScheduled = false;
        let redrawRafToken = 0;
        let resizeObserver = null;
        const annotationCleanups = [];

        function addAnnotationListener(target, type, handler, options) {
            if (!target?.addEventListener || typeof handler !== 'function') return false;
            target.addEventListener(type, handler, options);
            annotationCleanups.push(() => {
                try {
                    target.removeEventListener(type, handler, options);
                } catch (_) {}
            });
            return true;
        }

        function getViewRect() {
            if (!canvas?.getBoundingClientRect) return null;
            return canvas.getBoundingClientRect();
        }

        function resizeToRect(nextRect) {
            if (!canvas || !ctx || !nextRect) return;
            const nextDpr = Math.max(1, Math.floor((globalThis.devicePixelRatio || 1) * 100) / 100);
            const w = Math.max(1, Math.round(nextRect.width * nextDpr));
            const h = Math.max(1, Math.round(nextRect.height * nextDpr));
            if (canvas.width !== w || canvas.height !== h || dpr !== nextDpr) {
                dpr = nextDpr;
                canvas.width = w;
                canvas.height = h;
            }
        }

        function canvasPointFromEvent(e) {
            const r = rect || getViewRect();
            if (!r || r.width <= 0 || r.height <= 0) return null;
            const x = (e.clientX - r.left) / r.width;
            const y = (e.clientY - r.top) / r.height;
            return normalizePoint({ x, y });
        }

        function setCanvasActive(active) {
            if (!canvas) return;
            canvas.classList.toggle('active', !!active);
        }

        function setDrawEnabled(enabled) {
            drawEnabled = !!enabled;
            setCanvasActive(drawEnabled);
            scheduleDraw();
        }

        function setTool(nextTool) {
            const t = String(nextTool || '').trim().toLowerCase();
            tool = ['pencil', 'line', 'rect', 'circle', 'text'].includes(t) ? t : 'pencil';
        }

        function setDash(nextDash) {
            const t = String(nextDash || '').trim().toLowerCase();
            dash = ['solid', 'dashed', 'dotted'].includes(t) ? t : 'solid';
        }

        function setColor(nextColor) {
            const c = String(nextColor || '').trim();
            color = c || '#ffcc00';
        }

        function setWidth(nextWidth) {
            const n = Number(nextWidth);
            width = Number.isFinite(n) ? Math.max(1, Math.min(40, n)) : width;
        }

        function applyLineStyle(style) {
            if (!ctx) return;
            const w = Math.max(1, Number(style?.width) || 1);
            const d = String(style?.dash || 'solid');
            ctx.lineWidth = w * dpr;
            ctx.strokeStyle = String(style?.color || '#ffcc00');
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            if (d === 'dashed') ctx.setLineDash([w * 4 * dpr, w * 2 * dpr]);
            else if (d === 'dotted') ctx.setLineDash([w * 1 * dpr, w * 2 * dpr]);
            else ctx.setLineDash([]);
        }

        function drawShape(shape, opts = {}) {
            if (!ctx || !rect) return;
            if (!shape || typeof shape !== 'object') return;

            const alpha = typeof opts.alpha === 'number' ? Math.max(0, Math.min(1, opts.alpha)) : 1;
            ctx.save();
            ctx.globalAlpha = alpha;

            const style = shape.style || {};
            applyLineStyle(style);

            const toPx = (p) => ({
                x: (Number(p?.x) || 0) * rect.width * dpr,
                y: (Number(p?.y) || 0) * rect.height * dpr,
            });

            if (shape.type === 'path') {
                const pts = Array.isArray(shape.points) ? shape.points : [];
                if (pts.length < 2) {
                    ctx.restore();
                    return;
                }
                ctx.beginPath();
                const p0 = toPx(pts[0]);
                ctx.moveTo(p0.x, p0.y);
                for (let i = 1; i < pts.length; i++) {
                    const pi = toPx(pts[i]);
                    ctx.lineTo(pi.x, pi.y);
                }
                ctx.stroke();
                ctx.restore();
                return;
            }

            if (shape.type === 'line') {
                const a = toPx(shape.a);
                const b = toPx(shape.b);
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.stroke();
                ctx.restore();
                return;
            }

            if (shape.type === 'rect') {
                const a = toPx(shape.a);
                const b = toPx(shape.b);
                const x = Math.min(a.x, b.x);
                const y = Math.min(a.y, b.y);
                const w = Math.abs(a.x - b.x);
                const h = Math.abs(a.y - b.y);
                ctx.beginPath();
                ctx.rect(x, y, w, h);
                ctx.stroke();
                ctx.restore();
                return;
            }

            if (shape.type === 'circle') {
                const c = toPx(shape.c);
                const r = Math.max(0, (Number(shape.r) || 0) * Math.min(rect.width, rect.height) * dpr);
                ctx.beginPath();
                ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
                return;
            }

            if (shape.type === 'text') {
                const p = toPx(shape.p);
                const text = String(shape.text || '');
                const fontSize = Math.max(10, Number(shape.fontSize) || Math.round((Number(style.width) || 2) * 6 + 10));
                ctx.setLineDash([]);
                ctx.fillStyle = String(style?.color || '#ffcc00');
                ctx.font = `${Math.round(fontSize * dpr)}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
                ctx.textBaseline = 'top';
                ctx.fillText(text, p.x, p.y);
                ctx.restore();
                return;
            }

            ctx.restore();
        }

        function clearCanvas() {
            if (!ctx || !canvas) return;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }

        function renderNow() {
            if (!ctx || !canvas) return;
            rect = getViewRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) return;
            resizeToRect(rect);
            clearCanvas();

            const preset = getActivePreset();
            if (!preset) return;
            ensureAnnotationsDefaults(preset);
            if (!preset.annotationsVisible) return;

            const list = Array.isArray(preset.annotations) ? preset.annotations : [];
            for (const shape of list) drawShape(shape);
            if (draft) drawShape(draft, { alpha: 0.65 });
        }

        function scheduleDraw() {
            if (disposed) return;
            if (!canvas) return;
            if (redrawScheduled) return;
            redrawScheduled = true;
            redrawRafToken = requestAnimationFrameSafe(() => {
                redrawRafToken = 0;
                if (disposed) return;
                redrawScheduled = false;
                renderNow();
            });
        }

        async function commitTextAt(p) {
            const preset = getActivePreset();
            if (!preset) return;
            const presetId = preset.id;
            const version = stateVersion;

            let text = null;
            if (promptAnnotationText) {
                try {
                    text = await Promise.resolve(promptAnnotationText(''));
                } catch (_) {
                    text = null;
                }
            } else {
                text = safePrompt(promptFn, 'Текст аннотации', '');
            }
            if (text == null) return;
            const t = String(text).trim();
            if (!t) return;
            if (disposed || version !== stateVersion || activeId !== presetId) return;

            const targetPreset = getPresetById(presetId);
            if (!targetPreset) return;
            ensureAnnotationsDefaults(targetPreset);
            if (!targetPreset.annotationsVisible) targetPreset.annotationsVisible = true;

            targetPreset.annotations.push({
                type: 'text',
                p,
                text: t,
                fontSize: Math.max(10, Math.round(width * 6 + 10)),
                style: { color, width, dash: 'solid' },
            });
            markStateDirty();
            scheduleDraw();
        }

        function getStyleSnapshot() {
            return { color, width, dash };
        }

        function ensurePointerCapture(e) {
            try {
                canvas?.setPointerCapture?.(e.pointerId);
            } catch (_) {}
        }

        function releasePointerCapture(e) {
            try {
                canvas?.releasePointerCapture?.(e.pointerId);
            } catch (_) {}
        }

        function beginStroke(e) {
            if (!drawEnabled) return;
            if (!canvas || !ctx) return;
            if (!activeId) return;

            const preset = getActivePreset();
            if (!preset) return;
            ensureAnnotationsDefaults(preset);
            if (!preset.annotationsVisible) {
                preset.annotationsVisible = true;
                markStateDirty();
            }

            rect = getViewRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) return;

            const p = canvasPointFromEvent(e);
            if (!p) return;
            draftPresetId = preset.id;

            if (controls && prevControlsEnabled == null) {
                prevControlsEnabled = controls.enabled;
                controls.enabled = false;
            }

            if (tool === 'text') {
                const textPresetId = draftPresetId;
                void (async () => {
                    try {
                        await commitTextAt(p);
                    } finally {
                        if (draftPresetId === textPresetId) draftPresetId = null;
                        if (controls && prevControlsEnabled != null) {
                            controls.enabled = prevControlsEnabled;
                            prevControlsEnabled = null;
                        }
                        scheduleDraw();
                    }
                })();
                return;
            }

            pointerId = e.pointerId;
            ensurePointerCapture(e);

            const style = getStyleSnapshot();
            if (tool === 'pencil') {
                draft = { type: 'path', points: [p], style };
            } else if (tool === 'line') {
                draft = { type: 'line', a: p, b: p, style };
            } else if (tool === 'rect') {
                draft = { type: 'rect', a: p, b: p, style };
            } else if (tool === 'circle') {
                draft = { type: 'circle', c: p, r: 0, style };
            }
            scheduleDraw();
        }

        function moveStroke(e) {
            if (!drawEnabled) return;
            if (!draft || pointerId == null || e.pointerId !== pointerId) return;
            const p = canvasPointFromEvent(e);
            if (!p) return;

            if (draft.type === 'path') {
                draft.points.push(p);
            } else if (draft.type === 'line' || draft.type === 'rect') {
                draft.b = p;
            } else if (draft.type === 'circle') {
                const dx = p.x - draft.c.x;
                const dy = p.y - draft.c.y;
                draft.r = Math.sqrt(dx * dx + dy * dy);
            }
            scheduleDraw();
        }

        function endStroke(e) {
            if (!drawEnabled) return;
            if (!draft || pointerId == null || e.pointerId !== pointerId) return;

            const preset = getActivePreset();
            if (!preset || !draftPresetId || activeId !== draftPresetId || preset.id !== draftPresetId) {
                draft = null;
                draftPresetId = null;
                pointerId = null;
                releasePointerCapture(e);
                scheduleDraw();
                return;
            }
            ensureAnnotationsDefaults(preset);

            const shape = draft;
            draft = null;
            draftPresetId = null;
            pointerId = null;
            releasePointerCapture(e);

            let added = false;
            if (shape.type === 'path') {
                const pts = Array.isArray(shape.points) ? shape.points : [];
                if (pts.length >= 2) {
                    preset.annotations.push(shape);
                    added = true;
                }
            } else if (shape.type === 'circle') {
                if ((Number(shape.r) || 0) > 0.0001) {
                    preset.annotations.push(shape);
                    added = true;
                }
            } else {
                preset.annotations.push(shape);
                added = true;
            }
            if (added) markStateDirty();

            if (controls && prevControlsEnabled != null) {
                controls.enabled = prevControlsEnabled;
                prevControlsEnabled = null;
            }

            scheduleDraw();
        }

        function cancelStroke(e) {
            if (!drawEnabled) return;
            if (pointerId != null && e?.pointerId === pointerId) {
                releasePointerCapture(e);
            }
            draft = null;
            draftPresetId = null;
            pointerId = null;
            if (controls && prevControlsEnabled != null) {
                controls.enabled = prevControlsEnabled;
                prevControlsEnabled = null;
            }
            scheduleDraw();
        }

        function undo() {
            const preset = getActivePreset();
            if (!preset) return false;
            ensureAnnotationsDefaults(preset);
            if (!preset.annotations.length) return false;
            preset.annotations.pop();
            markStateDirty();
            scheduleDraw();
            return true;
        }

        function clear() {
            const preset = getActivePreset();
            if (!preset) return false;
            ensureAnnotationsDefaults(preset);
            if (!preset.annotations.length) return false;
            preset.annotations.length = 0;
            markStateDirty();
            scheduleDraw();
            return true;
        }

        function setVisibleForActivePreset(visible) {
            const preset = getActivePreset();
            if (!preset) return false;
            ensureAnnotationsDefaults(preset);
            const next = !!visible;
            if (preset.annotationsVisible === next) {
                scheduleDraw();
                return true;
            }
            preset.annotationsVisible = next;
            markStateDirty();
            scheduleDraw();
            return true;
        }

        function getVisibleForActivePreset() {
            const preset = getActivePreset();
            if (!preset) return false;
            ensureAnnotationsDefaults(preset);
            return !!preset.annotationsVisible;
        }

        function attach() {
            if (!canvas) return;
            addAnnotationListener(canvas, 'pointerdown', beginStroke);
            addAnnotationListener(canvas, 'pointermove', moveStroke);
            addAnnotationListener(canvas, 'pointerup', endStroke);
            addAnnotationListener(canvas, 'pointercancel', cancelStroke);
            addAnnotationListener(globalThis?.window, 'resize', scheduleDraw);
            if (typeof ResizeObserver !== 'undefined') {
                try {
                    resizeObserver = new ResizeObserver(() => scheduleDraw());
                    resizeObserver.observe(canvas);
                } catch (_) {
                    /* ignore */
                }
            }
            scheduleDraw();
        }

        attach();

        return Object.freeze({
            scheduleDraw,
            setDrawEnabled,
            getDrawEnabled: () => drawEnabled,
            setTool,
            getTool: () => tool,
            setDash,
            getDash: () => dash,
            setColor,
            getColor: () => color,
            setWidth,
            getWidth: () => width,
            undo,
            clear,
            setVisibleForActivePreset,
            getVisibleForActivePreset,
            dispose: () => {
                drawEnabled = false;
                draft = null;
                draftPresetId = null;
                pointerId = null;
                if (controls && prevControlsEnabled != null) {
                    controls.enabled = prevControlsEnabled;
                    prevControlsEnabled = null;
                }
                if (redrawRafToken) {
                    cancelAnimationFrameSafe(redrawRafToken);
                    redrawRafToken = 0;
                }
                redrawScheduled = false;
                try { resizeObserver?.disconnect?.(); } catch (_) {}
                resizeObserver = null;
                annotationCleanups.splice(0).forEach((cleanup) => {
                    try { cleanup(); } catch (_) {}
                });
                setCanvasActive(false);
                clearCanvas();
            },
        });
    }

    function createNullAnnotationsController() {
        return Object.freeze({
            scheduleDraw: () => {},
            setDrawEnabled: () => {},
            getDrawEnabled: () => false,
            setTool: () => {},
            getTool: () => 'pencil',
            setDash: () => {},
            getDash: () => 'solid',
            setColor: () => {},
            getColor: () => '#ffcc00',
            setWidth: () => {},
            getWidth: () => 3,
            undo: () => false,
            clear: () => false,
            setVisibleForActivePreset: () => false,
            getVisibleForActivePreset: () => false,
            dispose: () => {},
        });
    }

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

        // IMPORTANT:
        // `PerspectiveCamera.setViewOffset()` mutates `camera.aspect = fullWidth / fullHeight`.
        // If we pass (1, 1, ...) the camera becomes square and the whole view looks "squashed",
        // and `clearViewOffset()` won't restore the old aspect.
        // So we always use the actual viewport size (or a safe fallback) for fullWidth/fullHeight.
        const viewEl = controls?.domElement || null;
        const fullWidth =
            Math.max(
                1,
                Math.round(
                    (viewEl && Number.isFinite(viewEl.clientWidth) && viewEl.clientWidth > 0)
                        ? viewEl.clientWidth
                        : (viewEl && Number.isFinite(viewEl.width) && viewEl.width > 0 ? viewEl.width : 0),
                ),
            );
        const fullHeight =
            Math.max(
                1,
                Math.round(
                    (viewEl && Number.isFinite(viewEl.clientHeight) && viewEl.clientHeight > 0)
                        ? viewEl.clientHeight
                        : (viewEl && Number.isFinite(viewEl.height) && viewEl.height > 0 ? viewEl.height : 0),
                ),
            );
        const viewAspect = fullWidth / fullHeight;

        const eps = 1e-9;
        if (Math.abs(sx) < eps && Math.abs(sy) < eps) {
            camera.clearViewOffset?.();
            if (Number.isFinite(viewAspect) && viewAspect > 0) camera.aspect = viewAspect;
            return;
        }

        // Store shift as normalized offsets (offsetX/fullWidth, offsetY/fullHeight), independent of pixels.
        camera.setViewOffset?.(fullWidth, fullHeight, sx * fullWidth, sy * fullHeight, fullWidth, fullHeight);
        if (camera.view) camera.view.enabled = true;
    }

    function applyPreset(preset) {
        if (disposed) return false;
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
        annotations.scheduleDraw();
        return true;
    }

    function transitionKey(fromId, toId) {
        return `${fromId || ''}->${toId || ''}`;
    }

    function normalizeTransitionType(type) {
        const v = String(type || '').trim().toLowerCase();
        if (v === 'linear') return 'linear';
        if (v === 'soft-in' || v === 'ease-in') return 'soft-in';
        if (v === 'soft-out' || v === 'ease-out') return 'soft-out';
        if (v === 'ease-in-out' || v === 'soft') return 'ease-in-out';
        return 'ease-in-out';
    }

    function normalizeTransitionTrajectory(trajectory) {
        const v = String(trajectory || '').trim().toLowerCase();
        if (v === 'spline' || v === 'curve' || v === 'curved') return 'spline';
        if (v === 'linear' || v === 'line') return 'linear';
        return 'linear';
    }

    function getTransition(fromId, toId) {
        const key = transitionKey(fromId, toId);
        const raw = transitions.get(key);
        if (typeof raw === 'number' && Number.isFinite(raw)) {
            return { seconds: Math.max(0, raw), type: 'ease-in-out', trajectory: 'linear' };
        }
        if (!raw || typeof raw !== 'object') {
            return { seconds: 0, type: 'ease-in-out', trajectory: 'linear' };
        }
        const seconds =
            typeof raw.seconds === 'number' && Number.isFinite(raw.seconds)
                ? Math.max(0, raw.seconds)
                : 0;
        return {
            seconds,
            type: normalizeTransitionType(raw.type),
            trajectory: normalizeTransitionTrajectory(raw.trajectory),
        };
    }

    function setTransition(fromId, toId, { seconds, type, trajectory } = {}) {
        if (disposed) return false;
        const key = transitionKey(fromId, toId);
        transitions.set(key, {
            seconds: Math.max(0, Number(seconds) || 0),
            type: normalizeTransitionType(type),
            trajectory: normalizeTransitionTrajectory(trajectory),
        });
        markStateDirty();
        return true;
    }

    async function editTransition(fromId, toId) {
        if (disposed) return;
        const from = getPresetById(fromId);
        const to = getPresetById(toId);
        if (!from || !to) return;
        const version = stateVersion;

        const current = getTransition(fromId, toId);
        let result = null;

        if (promptTransition) {
            try {
                result = await Promise.resolve(promptTransition({
                    from,
                    to,
                    seconds: current.seconds,
                    type: current.type,
                    trajectory: current.trajectory,
                }));
            } catch (_) {
                result = null;
            }
        }
        if (disposed) return;
        if (version !== stateVersion || !getPresetById(fromId) || !getPresetById(toId)) return;

        if (result == null) {
            const secRaw = safePrompt(
                promptFn,
                `Переход “${from.name || 'Camera'}” → “${to.name || 'Camera'}” (сек)`,
                String(current.seconds),
            );
            if (secRaw == null) return;
            const seconds = Number.parseFloat(String(secRaw).replace(',', '.'));
            if (!Number.isFinite(seconds) || seconds < 0) return;

            const typeRaw = safePrompt(promptFn, 'Тип перехода: soft-in / soft-out / ease-in-out / linear', current.type);
            if (typeRaw == null) return;
            const trajectoryRaw = safePrompt(promptFn, 'Траектория: linear / spline', current.trajectory);
            if (trajectoryRaw == null) return;
            setTransition(fromId, toId, { seconds, type: typeRaw, trajectory: trajectoryRaw });
            render();
            return;
        }

        if (typeof result === 'number' || typeof result === 'string') {
            const seconds = Number.parseFloat(String(result).replace(',', '.'));
            if (!Number.isFinite(seconds) || seconds < 0) return;
            setTransition(fromId, toId, { seconds, type: current.type, trajectory: current.trajectory });
            render();
            return;
        }

        const seconds = Number.parseFloat(String(result.seconds ?? current.seconds).replace(',', '.'));
        if (!Number.isFinite(seconds) || seconds < 0) return;
        setTransition(fromId, toId, {
            seconds,
            type: result.type ?? current.type,
            trajectory: result.trajectory ?? current.trajectory,
        });
        render();
    }

    function getPresetById(id) {
        if (!id) return null;
        return presets.find((p) => p && p.id === id) || null;
    }

    function setActive(id) {
        if (disposed) return;
        activeId = id || null;
        render();
        annotations.scheduleDraw();
    }

    function setPropsPanelVisible(visible) {
        if (!camPropsDetailsEl) return;
        camPropsDetailsEl.hidden = !visible;
        if (visible) camPropsDetailsEl.open = true;
        else camPropsDetailsEl.open = false;
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

    function makeTransitionButton(fromPreset, toPreset) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn cam-transition';
        btn.textContent = '→';
        btn.dataset.action = 'transition';
        btn.dataset.from = fromPreset.id;
        btn.dataset.to = toPreset.id;

        const tr = getTransition(fromPreset.id, toPreset.id);
        const fromName = fromPreset.name || 'Camera';
        const toName = toPreset.name || 'Camera';
        btn.title = `Переход ${fromName} → ${toName}: ${tr.seconds}s · ${tr.type} · ${tr.trajectory}`;
        btn.setAttribute('aria-label', btn.title);
        return btn;
    }

    function makePlayButton() {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn cam-play';
        btn.textContent = playing ? '■' : '▶';
        btn.dataset.action = 'play';
        btn.title = playing ? 'Остановить' : 'Проиграть переходы';
        btn.setAttribute('aria-label', btn.title);
        if (playing) btn.classList.add('active');
        return btn;
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

        let annotGroup = null;
        let annotVisibleBtn = null;
        let annotDrawBtn = null;
        let annotUndoBtn = null;
        let annotClearBtn = null;
        let annotToolSel = null;
        let annotDashSel = null;
        let annotColorInput = null;
        let annotWidthInput = null;

        if (annotationsEnabled) {
            annotGroup = document.createElement('div');
            annotGroup.className = 'cam-props-group';
            const annotHead = document.createElement('div');
            annotHead.className = 'cam-props-head';
            annotHead.textContent = 'Annotations';

            const annotActions = document.createElement('div');
            annotActions.className = 'cam-props-row';
            annotActions.style.alignItems = 'center';

            annotVisibleBtn = document.createElement('button');
            annotVisibleBtn.type = 'button';
            annotVisibleBtn.className = 'btn cam-annot-visible';
            annotVisibleBtn.textContent = 'Скрыть';
            annotVisibleBtn.title = 'Показать/скрыть аннотации этой камеры';

            annotDrawBtn = document.createElement('button');
            annotDrawBtn.type = 'button';
            annotDrawBtn.className = 'btn cam-annot-draw';
            annotDrawBtn.textContent = 'Рисовать';
            annotDrawBtn.title = 'Включить/выключить режим рисования';

            annotUndoBtn = document.createElement('button');
            annotUndoBtn.type = 'button';
            annotUndoBtn.className = 'btn cam-annot-undo';
            annotUndoBtn.textContent = 'Undo';
            annotUndoBtn.title = 'Отменить последний штрих';

            annotClearBtn = document.createElement('button');
            annotClearBtn.type = 'button';
            annotClearBtn.className = 'btn cam-annot-clear';
            annotClearBtn.textContent = 'Clear';
            annotClearBtn.title = 'Очистить аннотации этой камеры';

            annotActions.appendChild(annotVisibleBtn);
            annotActions.appendChild(annotDrawBtn);
            annotActions.appendChild(annotUndoBtn);
            annotActions.appendChild(annotClearBtn);

            const annotGrid = document.createElement('div');
            annotGrid.className = 'cam-props-grid cam-props-grid-2';

            annotToolSel = document.createElement('select');
            annotToolSel.className = 'cam-props-select';
            [
                ['pencil', 'Pencil'],
                ['line', 'Line'],
                ['rect', 'Rect'],
                ['circle', 'Circle'],
                ['text', 'Text'],
            ].forEach(([value, label]) => {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = label;
                annotToolSel.appendChild(opt);
            });

            annotDashSel = document.createElement('select');
            annotDashSel.className = 'cam-props-select';
            [
                ['solid', 'Solid'],
                ['dashed', 'Dashed'],
                ['dotted', 'Dotted'],
            ].forEach(([value, label]) => {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = label;
                annotDashSel.appendChild(opt);
            });

            annotColorInput = document.createElement('input');
            annotColorInput.type = 'color';
            annotColorInput.value = '#ffcc00';

            annotWidthInput = makeNumberInput({ step: '1', min: 1, max: 40 });

            annotGrid.appendChild(makeLabel('Tool', annotToolSel));
            annotGrid.appendChild(makeLabel('Line', annotDashSel));
            annotGrid.appendChild(makeLabel('Color', annotColorInput));
            annotGrid.appendChild(makeLabel('Width', annotWidthInput));

            annotGroup.appendChild(annotHead);
            annotGroup.appendChild(annotActions);
            annotGroup.appendChild(annotGrid);
        }

        const hint = document.createElement('div');
        hint.className = 'muted cam-props-hint';
        hint.textContent = 'Кнопка ⟳ обновляет сохранённый вид, ⚙ открывает свойства. Изменения сохраняются за камерой.';

        root.appendChild(nameRow);
        root.appendChild(pos.group);
        root.appendChild(tgt.group);
        root.appendChild(up.group);
        root.appendChild(lensGroup);
        root.appendChild(shiftGroup);
        if (annotGroup) root.appendChild(annotGroup);
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
            markStateDirty();
        };

        addListener(nameInput, 'change', applyFromInputs);
        [pos.x, pos.y, pos.z, tgt.x, tgt.y, tgt.z, up.x, up.y, up.z, fovInput, zoomInput, nearInput, farInput, shiftXInput, shiftYInput]
            .forEach((input) => addListener(input, 'input', applyFromInputs));

        const syncAnnotButtons = () => {
            if (!annotationsEnabled || !annotVisibleBtn || !annotDrawBtn || !annotToolSel || !annotDashSel || !annotColorInput || !annotWidthInput) return;
            const preset = getPresetById(editingId);
            if (!preset) return;
            ensureAnnotationsDefaults(preset);

            const visible = !!preset.annotationsVisible;
            annotVisibleBtn.textContent = visible ? 'Скрыть' : 'Показать';
            annotVisibleBtn.classList.toggle('active', visible);

            const drawing = annotations.getDrawEnabled();
            annotDrawBtn.textContent = drawing ? 'Рисование' : 'Рисовать';
            annotDrawBtn.classList.toggle('active', drawing);

            annotToolSel.value = annotations.getTool();
            annotDashSel.value = annotations.getDash();
            annotColorInput.value = annotations.getColor();
            annotWidthInput.value = String(annotations.getWidth());
        };

        if (annotationsEnabled && annotVisibleBtn && annotDrawBtn && annotUndoBtn && annotClearBtn && annotToolSel && annotDashSel && annotColorInput && annotWidthInput) {
            addListener(annotVisibleBtn, 'click', () => {
                const preset = getPresetById(editingId);
                if (!preset) return;
                ensureAnnotationsDefaults(preset);
                preset.annotationsVisible = !preset.annotationsVisible;
                markStateDirty();
                annotations.scheduleDraw();
                syncAnnotButtons();
                syncAnnotationsToolbar();
            });

            addListener(annotDrawBtn, 'click', () => {
                const enabled = !annotations.getDrawEnabled();
                annotations.setDrawEnabled(enabled);
                if (enabled) {
                    const preset = getPresetById(editingId);
                    if (preset) {
                        ensureAnnotationsDefaults(preset);
                        if (!preset.annotationsVisible) {
                            preset.annotationsVisible = true;
                            markStateDirty();
                        }
                    }
                }
                syncAnnotButtons();
                syncAnnotationsToolbar();
            });

            addListener(annotUndoBtn, 'click', () => {
                annotations.undo();
                syncAnnotButtons();
                syncAnnotationsToolbar();
            });

            addListener(annotClearBtn, 'click', () => {
                annotations.clear();
                syncAnnotButtons();
                syncAnnotationsToolbar();
            });

            addListener(annotToolSel, 'change', () => {
                annotations.setTool(annotToolSel.value);
                syncAnnotButtons();
                syncAnnotationsToolbar();
            });
            addListener(annotDashSel, 'change', () => {
                annotations.setDash(annotDashSel.value);
                syncAnnotButtons();
                syncAnnotationsToolbar();
            });
            addListener(annotColorInput, 'input', () => {
                annotations.setColor(annotColorInput.value);
                syncAnnotButtons();
                syncAnnotationsToolbar();
            });
            addListener(annotWidthInput, 'input', () => {
                annotations.setWidth(annotWidthInput.value);
                syncAnnotButtons();
                syncAnnotationsToolbar();
            });
        }

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
            annotVisibleBtn,
            annotDrawBtn,
            annotUndoBtn,
            annotClearBtn,
            annotToolSel,
            annotDashSel,
            annotColorInput,
            annotWidthInput,
            syncAnnotButtons,
            writeVec3,
        };
        return propsUI;
    }

    function syncPropsPanel(preset) {
        const ui = ensurePropsUI();
        if (!ui || !preset) return;

        ensureAnnotationsDefaults(preset);

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

        ui.syncAnnotButtons?.();
        updatePresetLabels(preset);
    }

    function openPropsForPresetId(id) {
        if (disposed) return;
        const preset = getPresetById(id);
        if (!preset) return;
        editingId = id;

        setPropsPanelVisible(true);
        syncPropsPanel(preset);
        requestLayout();
    }

    function closePropsPanel() {
        if (disposed) return;
        editingId = null;
        setPropsPanelVisible(false);
        setPropsTitle('—');
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

        actions.appendChild(refresh);
        actions.appendChild(props);
        if (!preset.isDefault) {
            const del = document.createElement('span');
            del.className = 'cam-icon cam-x';
            del.textContent = '×';
            del.title = 'Удалить камеру';
            del.setAttribute('aria-label', 'Удалить камеру');
            del.dataset.action = 'delete';
            del.dataset.id = preset.id;
            del.draggable = false;
            actions.appendChild(del);
        }

        btn.appendChild(name);
        btn.appendChild(actions);
        return btn;
    }

    function renderBar() {
        if (!camsBarListEl) return;
        camsBarListEl.innerHTML = '';

        for (let i = 0; i < presets.length; i++) {
            const preset = presets[i];
            camsBarListEl.appendChild(
                makePresetButton(preset, { active: activeId && preset.id === activeId }),
            );
            if (i < presets.length - 1) {
                camsBarListEl.appendChild(makeTransitionButton(preset, presets[i + 1]));
            }
        }

        if (presets.length > 0) {
            camsBarListEl.appendChild(makePlayButton());
        }

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
        if (disposed) return;
        updateCounts();
        renderBar();
        renderSide();
        syncAnnotationsToolbar();
        if (barVisible) requestLayout();
    }

    function setBarVisible(nextVisible) {
        if (disposed) return;
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
        if (disposed) return null;
        const snap = snapshotCurrentView();
        if (!snap) return null;
        const version = stateVersion;

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
        if (disposed) return null;
        if (version !== stateVersion) return null;
        if (nameRaw == null) return null;
        const name = String(nameRaw).trim() || defaultName;
        snap.name = name;

        presets.push(snap);
        lastCreatedId = snap.id;
        setActive(snap.id);
        render();
        markStateDirty();
        return snap;
    }

    function addFromSnapshot(snapshot, name, { activate = false } = {}) {
        if (disposed) return null;
        if (!snapshot) return null;
        const snap = {
            id: makeId(),
            name: String(name || '').trim() || `Cam ${presets.length + 1}`,
            position: Array.isArray(snapshot.position) ? [...snapshot.position] : snapshot.position,
            target: Array.isArray(snapshot.target) ? [...snapshot.target] : snapshot.target,
            up: Array.isArray(snapshot.up) ? [...snapshot.up] : snapshot.up,
            fov: snapshot.fov,
            zoom: snapshot.zoom,
            near: snapshot.near,
            far: snapshot.far,
            shiftX: snapshot.shiftX ?? 0,
            shiftY: snapshot.shiftY ?? 0,
        };
        presets.push(snap);
        lastCreatedId = snap.id;
        if (activate) {
            setActive(snap.id);
        } else {
            render();
        }
        markStateDirty();
        return snap;
    }

    async function deletePreset(id) {
        if (disposed) return false;
        const preset = getPresetById(id);
        if (!preset) return false;
        if (preset.isDefault) return false;
        if (presets.length <= 1) return false;
        const version = stateVersion;
        let ok = false;
        if (confirmCameraDelete) {
            try {
                ok = await Promise.resolve(confirmCameraDelete(preset));
            } catch (_) {
                ok = false;
            }
        } else {
            ok = safeConfirm(confirmFn, `Вы точно хотите удалить камеру “${preset.name || 'Camera'}”?`);
        }
        if (disposed) return false;
        if (version !== stateVersion) return false;
        if (!ok) return false;

        const idx = presets.findIndex((p) => p && p.id === id);
        if (idx < 0) return false;
        presets.splice(idx, 1);
        for (const key of Array.from(transitions.keys())) {
            if (key.startsWith(`${id}->`) || key.endsWith(`->${id}`)) transitions.delete(key);
        }
        if (lastCreatedId === id) lastCreatedId = presets[presets.length - 1]?.id || null;
        if (activeId === id) {
            const next = presets[Math.min(idx, presets.length - 1)] || presets[presets.length - 1] || null;
            activeId = next?.id || null;
            if (next) applyPreset(next);
        }
        if (editingId === id) {
            editingId = null;
            setPropsPanelVisible(false);
        }
        render();
        markStateDirty();
        return true;
    }

    function updatePresetFromCurrentView(id) {
        if (disposed) return false;
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
        markStateDirty();
        return true;
    }

    function updateLastCreatedFromCurrentView() {
        const id = lastCreatedId || activeId;
        if (!id) return false;
        return updatePresetFromCurrentView(id);
    }

    function movePreset(fromId, toIndex) {
        if (disposed) return false;
        const fromIndex = presets.findIndex((p) => p && p.id === fromId);
        if (fromIndex < 0) return false;
        if (!Number.isFinite(toIndex)) return false;

        const [moved] = presets.splice(fromIndex, 1);
        const nextIndex = Math.max(0, Math.min(presets.length, toIndex));
        presets.splice(nextIndex, 0, moved);
        render();
        markStateDirty();
        return true;
    }

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    function smoothstep(t) {
        return t * t * (3 - 2 * t);
    }

    function easeIn(t) {
        return t * t * t;
    }

    function easeOut(t) {
        const inv = 1 - t;
        return 1 - inv * inv * inv;
    }

    function buildCatmullSegmentCurve(p0, p1, p2, p3) {
        if (!THREE) return null;
        return new THREE.CatmullRomCurve3([p0, p1, p2, p3], false, 'centripetal');
    }

    function animateTransition(fromPreset, toPreset, seconds, type, trajectory, token) {
        if (!THREE || !camera || !controls) return Promise.resolve(false);
        if (disposed) return Promise.resolve(false);
        const duration = Math.max(0, Number(seconds) || 0);
        if (duration <= 0) {
            if (disposed || token !== playToken) return Promise.resolve(false);
            applyPreset(toPreset);
            return Promise.resolve(true);
        }

        const fromPos = new THREE.Vector3().fromArray(fromPreset.position || [0, 0, 0]);
        const toPos = new THREE.Vector3().fromArray(toPreset.position || [0, 0, 0]);
        const fromTgt = new THREE.Vector3().fromArray(fromPreset.target || [0, 0, 0]);
        const toTgt = new THREE.Vector3().fromArray(toPreset.target || [0, 0, 0]);
        const fromUp = new THREE.Vector3().fromArray(fromPreset.up || [0, 1, 0]);
        const toUp = new THREE.Vector3().fromArray(toPreset.up || [0, 1, 0]);

        const fromFov = Number.isFinite(fromPreset.fov) ? fromPreset.fov : camera.fov;
        const toFov = Number.isFinite(toPreset.fov) ? toPreset.fov : camera.fov;
        const fromZoom = Number.isFinite(fromPreset.zoom) ? fromPreset.zoom : camera.zoom;
        const toZoom = Number.isFinite(toPreset.zoom) ? toPreset.zoom : camera.zoom;
        const fromNear = Number.isFinite(fromPreset.near) ? fromPreset.near : camera.near;
        const toNear = Number.isFinite(toPreset.near) ? toPreset.near : camera.near;
        const fromFar = Number.isFinite(fromPreset.far) ? fromPreset.far : camera.far;
        const toFar = Number.isFinite(toPreset.far) ? toPreset.far : camera.far;

        const fromShiftX = Number.isFinite(fromPreset.shiftX) ? fromPreset.shiftX : 0;
        const toShiftX = Number.isFinite(toPreset.shiftX) ? toPreset.shiftX : 0;
        const fromShiftY = Number.isFinite(fromPreset.shiftY) ? fromPreset.shiftY : 0;
        const toShiftY = Number.isFinite(toPreset.shiftY) ? toPreset.shiftY : 0;

        const tmpPos = new THREE.Vector3();
        const tmpTgt = new THREE.Vector3();
        const tmpUp = new THREE.Vector3();

        const path = normalizeTransitionTrajectory(trajectory);
        const useSpline = path === 'spline';
        let posCurve = null;
        let tgtCurve = null;
        let segStart = 0;
        let segScale = 1;
        if (useSpline) {
            const fromIndex = presets.findIndex((p) => p && p.id === fromPreset.id);
            const toIndex = presets.findIndex((p) => p && p.id === toPreset.id);
            if (fromIndex >= 0 && toIndex === fromIndex + 1) {
                const prevPreset = presets[fromIndex - 1] || null;
                const nextPreset = presets[toIndex + 1] || null;
                const p0 = Array.isArray(prevPreset?.position) && prevPreset.position.length >= 3
                    ? new THREE.Vector3().fromArray(prevPreset.position)
                    : fromPos.clone();
                const p3 = Array.isArray(nextPreset?.position) && nextPreset.position.length >= 3
                    ? new THREE.Vector3().fromArray(nextPreset.position)
                    : toPos.clone();
                posCurve = buildCatmullSegmentCurve(p0, fromPos, toPos, p3);

                const t0 = Array.isArray(prevPreset?.target) && prevPreset.target.length >= 3
                    ? new THREE.Vector3().fromArray(prevPreset.target)
                    : fromTgt.clone();
                const t3 = Array.isArray(nextPreset?.target) && nextPreset.target.length >= 3
                    ? new THREE.Vector3().fromArray(nextPreset.target)
                    : toTgt.clone();
                tgtCurve = buildCatmullSegmentCurve(t0, fromTgt, toTgt, t3);

                const segments = 3;
                segStart = 1 / segments;
                segScale = 1 / segments;
            }
        }

        return new Promise((resolve) => {
            const start = performance.now();
            const durMs = duration * 1000;
            let settled = false;

            const finish = (result) => {
                if (settled) return;
                settled = true;
                if (transitionAbort === abort) transitionAbort = null;
                transitionRafToken = 0;
                resolve(result);
            };

            const abort = () => finish(false);
            transitionAbort = abort;

            const tick = (now) => {
                transitionRafToken = 0;
                if (disposed || token !== playToken) {
                    finish(false);
                    return;
                }

                const t = Math.min(1, Math.max(0, (now - start) / durMs));
                const easing = normalizeTransitionType(type);
                const k = easing === 'linear'
                    ? t
                    : (easing === 'soft-in'
                        ? easeIn(t)
                        : (easing === 'soft-out'
                            ? easeOut(t)
                            : smoothstep(t)));

                tmpTgt.lerpVectors(fromTgt, toTgt, k);
                if (posCurve) posCurve.getPoint(segStart + segScale * k, tmpPos);
                else tmpPos.lerpVectors(fromPos, toPos, k);
                if (tgtCurve) tgtCurve.getPoint(segStart + segScale * k, tmpTgt);
                else tmpTgt.lerpVectors(fromTgt, toTgt, k);
                tmpUp.lerpVectors(fromUp, toUp, k);
                if (tmpUp.lengthSq() > 1e-12) tmpUp.normalize();

                camera.position.copy(tmpPos);
                camera.up.copy(tmpUp);
                controls.target.copy(tmpTgt);

                camera.fov = lerp(fromFov, toFov, k);
                camera.zoom = lerp(fromZoom, toZoom, k);
                camera.near = Math.max(0.0001, lerp(fromNear, toNear, k));
                camera.far = Math.max(camera.near + 0.01, lerp(fromFar, toFar, k));

                applyCameraShift(lerp(fromShiftX, toShiftX, k), lerp(fromShiftY, toShiftY, k));
                camera.updateProjectionMatrix?.();

                controls.update?.();
                requestRender();

                if (t >= 1) {
                    finish(true);
                    return;
                }
                transitionRafToken = requestAnimationFrameSafe(tick);
            };

            transitionRafToken = requestAnimationFrameSafe(tick);
        });
    }

    async function playSequence() {
        if (disposed) return;
        if (!presets.length) return;

        const token = ++playToken;
        playing = true;
        render();

        const prevControlsEnabled = controls?.enabled;
        const prevDamping = controls?.enableDamping;
        if (controls) {
            controls.enabled = false;
            controls.enableDamping = false;
        }

        try {
            let startIndex = activeId ? presets.findIndex((p) => p && p.id === activeId) : -1;
            if (startIndex < 0 || startIndex >= presets.length - 1) startIndex = 0;

            const startPreset = presets[startIndex];
            if (startPreset) {
                applyPreset(startPreset);
                setActive(startPreset.id);
            }

            for (let i = startIndex; i < presets.length - 1; i++) {
                if (token !== playToken) return;
                const fromPreset = presets[i];
                const toPreset = presets[i + 1];
                const tr = getTransition(fromPreset.id, toPreset.id);
                await animateTransition(fromPreset, toPreset, tr.seconds, tr.type, tr.trajectory, token);
                if (token !== playToken) return;
                setActive(toPreset.id);
            }
        } finally {
            if (controls) {
                controls.enabled = prevControlsEnabled ?? true;
                controls.enableDamping = prevDamping ?? true;
            }
            if (token === playToken) {
                playing = false;
                render();
            }
        }
    }

    function handleAction(action, payload) {
        if (disposed) return;
        const id = payload?.id || null;
        const from = payload?.from || null;
        const to = payload?.to || null;

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
            if (camPropsDetailsEl && !camPropsDetailsEl.hidden && editingId === preset.id) {
                closePropsPanel();
                return;
            }
            if (applyPreset(preset)) setActive(preset.id);
            openPropsForPresetId(preset.id);
            return;
        }
        if (action === 'transition') {
            if (!from || !to) return;
            void editTransition(from, to);
            return;
        }
        if (action === 'play') {
            if (playing) {
                stopPlayback();
                return;
            }
            void playSequence();
            return;
        }
        if (action === 'goto') {
            const preset = getPresetById(id);
            if (!preset) return;
            if (applyPreset(preset)) setActive(preset.id);
            return;
        }
        if (action === 'delete') {
            void deletePreset(id);
        }
    }

    function attachListHandler(container) {
        if (!container?.addEventListener) return;
        addListener(container, 'click', (event) => {
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
            handleAction(action, {
                id: actionEl.dataset?.id || null,
                from: actionEl.dataset?.from || null,
                to: actionEl.dataset?.to || null,
            });
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

        addListener(container, 'dragstart', (event) => {
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

        addListener(container, 'dragenter', (event) => {
            if (!dragId) return;
            event.preventDefault();
        });

        addListener(container, 'dragover', (event) => {
            if (!dragId) return;
            event.preventDefault();
            const dt = event.dataTransfer;
            if (dt) dt.dropEffect = 'move';
        });

        addListener(container, 'drop', (event) => {
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

        addListener(container, 'dragend', (event) => {
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
    addListener(camsToggleBtn, 'click', toggleBarVisible);

    // initialize
    setBarVisible(false);
    setPropsPanelVisible(false);
    render();

    function dispose() {
        if (disposed) return;
        disposed = true;
        stopPlayback({ updateUi: false });
        if (changeTimer) {
            clearTimeout(changeTimer);
            changeTimer = null;
        }
        try { annotations.dispose?.(); } catch (_) {}
        cleanupFns.splice(0).reverse().forEach((cleanup) => {
            try { cleanup(); } catch (_) {}
        });
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
        getTransitions: () => serializeTransitions(),
        getActiveId: () => activeId,
        getLastCreatedId: () => lastCreatedId,
        addFromCurrentView,
        addFromSnapshot,
        deletePreset,
        updateLastCreatedFromCurrentView,
        applyPreset,
        setActive,
        setBarVisible,
        isBarVisible: () => barVisible,
        loadState,
        dispose,
        captureDebugPoint,
    });
}
