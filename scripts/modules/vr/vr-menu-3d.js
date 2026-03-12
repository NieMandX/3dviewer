const DEFAULT_ITEMS = Object.freeze([
    { id: 'exit_vr', label: 'EXIT', toggle: false },
    { id: 'reset_view', label: 'FIT', toggle: false },
    { id: 'toggle_ucx', label: 'UCX', toggle: true },
    { id: 'toggle_vpm', label: 'VPM', toggle: true },
    { id: 'toggle_npm', label: 'NPM', toggle: true },
    { id: 'toggle_bg', label: 'BG', toggle: true },
    { id: 'recenter_menu', label: 'CENTER', toggle: false },
]);

const BTN_W = 0.18;
const BTN_H = 0.06;
const BTN_GAP = 0.018;
const MENU_DISTANCE = 1.45;
const MAX_RAY_DISTANCE = 5.0;
const ACTION_COOLDOWN_MS = 220;
const TRIGGER_THRESHOLD = 0.62;
const LABEL_FONT_PX = 26;
const FOOTER_BTN_GAP = 0.04;
const PANEL_PADDING_X = 0.06;
const PANEL_PADDING_Y = 0.06;
const PANEL_SECTION_GAP = 0.04;

function nowMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function readButtonValue(button) {
    if (!button) return 0;
    const value = Number(button.value);
    if (Number.isFinite(value)) {
        return Math.max(0, Math.min(1, value));
    }
    return button.pressed ? 1 : 0;
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
    if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x, y, width, height, radius);
        return;
    }

    const r = Math.max(0, Math.min(radius, Math.min(width, height) * 0.5));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
}

function createLabelTexture({
    label,
    active = false,
    hovered = false,
    canvas = null,
    context = null,
    fontPx = LABEL_FONT_PX,
} = {}) {
    const cv = canvas || document.createElement('canvas');
    cv.width = 512;
    cv.height = 192;
    const ctx = context || cv.getContext('2d');
    if (!ctx) return { canvas: cv, context: null, texture: null };

    const bg = hovered
        ? 'rgba(255,255,255,0.28)'
        : (active ? 'rgba(47,122,255,0.85)' : 'rgba(18,20,28,0.78)');
    const border = hovered
        ? 'rgba(255,255,255,0.9)'
        : (active ? 'rgba(185,221,255,0.95)' : 'rgba(255,255,255,0.46)');
    const fg = active ? '#ffffff' : '#f5f7fb';

    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = bg;
    ctx.strokeStyle = border;
    ctx.lineWidth = 5;
    drawRoundedRect(ctx, 8, 8, cv.width - 16, cv.height - 16, 24);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = fg;
    ctx.font = `700 ${Math.max(12, Math.round(Number(fontPx) || LABEL_FONT_PX))}px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(label || '').toUpperCase(), cv.width * 0.5, cv.height * 0.52);

    return { canvas: cv, context: ctx, texture: null };
}

function createInfoTexture({
    title = '',
    lines = [],
    width = 1024,
    height = 512,
    titleFontPx = 44,
    fontPx = 26,
    canvas = null,
    context = null,
    background = 'rgba(11,14,20,0.22)',
    border = 'rgba(255,255,255,0.18)',
    color = '#f5f7fb',
} = {}) {
    const cv = canvas || document.createElement('canvas');
    cv.width = width;
    cv.height = height;
    const ctx = context || cv.getContext('2d');
    if (!ctx) return { canvas: cv, context: null, texture: null };

    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = background;
    ctx.strokeStyle = border;
    ctx.lineWidth = 4;
    drawRoundedRect(ctx, 8, 8, cv.width - 16, cv.height - 16, 28);
    ctx.fill();
    if (border) ctx.stroke();

    const textLines = Array.isArray(lines) ? lines.filter(Boolean).map((line) => String(line)) : [];
    const topPad = 36;
    const sidePad = 36;
    let cursorY = topPad;

    if (title) {
        ctx.fillStyle = '#ffffff';
        ctx.font = `700 ${Math.max(16, Math.round(Number(titleFontPx) || 44))}px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(String(title), cv.width * 0.5, cursorY);
        cursorY += Math.max(42, titleFontPx * 1.2);
    }

    ctx.fillStyle = color;
    ctx.font = `600 ${Math.max(12, Math.round(Number(fontPx) || 26))}px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const lineHeight = Math.max(18, fontPx * 1.35);
    for (const line of textLines) {
        ctx.fillText(line, cv.width * 0.5, cursorY, cv.width - (sidePad * 2));
        cursorY += lineHeight;
    }

    return { canvas: cv, context: ctx, texture: null };
}

function createLine(THREE) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3)
    );
    const material = new THREE.LineBasicMaterial({
        color: 0x80b5ff,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
    });
    const line = new THREE.Line(geometry, material);
    line.name = 'VRMenuRay';
    line.visible = false;
    line.frustumCulled = false;
    line.renderOrder = 9999;
    return line;
}

function updateLineWorldPoints(line, start, end) {
    const positionAttr = line?.geometry?.getAttribute?.('position') || null;
    const array = positionAttr?.array || null;
    if (!array || array.length < 6) return false;

    array[0] = start.x;
    array[1] = start.y;
    array[2] = start.z;
    array[3] = end.x;
    array[4] = end.y;
    array[5] = end.z;
    positionAttr.needsUpdate = true;
    line.geometry.computeBoundingSphere?.();
    return true;
}

function computeGridMetrics({ itemCount, columns, buttonWidth, buttonHeight, buttonGap }) {
    const colCount = Math.max(1, Math.round(columns) || 1);
    const rowCount = Math.max(1, Math.ceil(Math.max(0, itemCount) / colCount));
    const width = (colCount * buttonWidth) + ((colCount - 1) * buttonGap);
    const height = itemCount > 0
        ? ((rowCount * buttonHeight) + ((rowCount - 1) * buttonGap))
        : 0;
    return { colCount, rowCount, width, height };
}

export function createVRMenu3D(options = {}) {
    const THREE = options.THREE || null;
    const scene = options.scene || null;
    const renderer = options.renderer || null;
    const camera = options.camera || null;
    const getAttachmentRoot = typeof options.getAttachmentRoot === 'function'
        ? options.getAttachmentRoot
        : () => scene;
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const onAction = typeof options.onAction === 'function' ? options.onAction : () => false;
    const getActionState = typeof options.getActionState === 'function' ? options.getActionState : () => null;
    const items = Array.isArray(options.items) && options.items.length ? options.items : DEFAULT_ITEMS;
    const footerItem = options.footerItem && typeof options.footerItem === 'object' ? options.footerItem : null;
    const modalView = options.modalView && typeof options.modalView === 'object' ? options.modalView : null;
    const buttonWidth = Number.isFinite(options.buttonWidth) ? Math.max(0.08, options.buttonWidth) : BTN_W;
    const buttonHeight = Number.isFinite(options.buttonHeight) ? Math.max(0.04, options.buttonHeight) : BTN_H;
    const buttonGap = Number.isFinite(options.buttonGap) ? Math.max(0.008, options.buttonGap) : BTN_GAP;
    const labelFontPx = Number.isFinite(options.labelFontPx) ? Math.max(12, options.labelFontPx) : LABEL_FONT_PX;
    const footerButtonWidth = Number.isFinite(options.footerButtonWidth) ? Math.max(buttonWidth, options.footerButtonWidth) : 0;
    const footerButtonHeight = Number.isFinite(options.footerButtonHeight) ? Math.max(0.04, options.footerButtonHeight) : buttonHeight;
    const footerButtonGap = Number.isFinite(options.footerButtonGap) ? Math.max(0.008, options.footerButtonGap) : FOOTER_BTN_GAP;
    const footerLabelFontPx = Number.isFinite(options.footerLabelFontPx) ? Math.max(12, options.footerLabelFontPx) : labelFontPx;
    const columnCount = Number.isFinite(options.columns)
        ? Math.max(1, Math.round(options.columns))
        : (items.length > 12 ? 5 : 3);

    if (!THREE || !scene || !renderer || !camera) {
        return Object.freeze({
            show: () => false,
            hide: () => false,
            toggle: () => false,
            update: () => false,
            recenter: () => false,
            isVisible: () => false,
            openOrderPanel: () => false,
            closeOrderPanel: () => false,
            isOrderPanelVisible: () => false,
            dispose: () => {},
        });
    }

    const MAIN_VIEW_ID = 'main';
    const ORDER_VIEW_ID = String(modalView?.id || 'order');

    const raycaster = new THREE.Raycaster();
    const rayOrigin = new THREE.Vector3();
    const rayDir = new THREE.Vector3();
    const rayEnd = new THREE.Vector3();
    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();
    const visualRayStart = new THREE.Vector3();
    const visualRayEnd = new THREE.Vector3();
    const hitTest = [];

    const root = new THREE.Group();
    root.name = 'VRMenuRoot';
    root.visible = false;
    scene.add(root);

    const state = {
        visible: false,
        disposed: false,
        activeViewId: MAIN_VIEW_ID,
        lastActionAt: 0,
        lastStateRefreshAt: 0,
        items: [],
        byMesh: new Map(),
        byId: new Map(),
        views: new Map(),
        hoveredByController: [null, null],
        triggerPrev: [false, false],
        controllers: [],
    };

    function registerButton(button) {
        state.byMesh.set(button.mesh.uuid, button);
        state.byId.set(button.id, button);
        state.items.push(button);
        button.view.buttons.push(button);
    }

    function setButtonVisual(button, { hovered = false, active = false } = {}) {
        const prevLabel = button.labelText;
        const prevActive = button.active;
        const prevHovered = button.hovered;

        button.active = !!active;
        button.hovered = !!hovered;

        if (prevLabel === button.labelText && prevActive === button.active && prevHovered === button.hovered) {
            return false;
        }

        const rendered = createLabelTexture({
            label: button.labelText,
            active: button.active,
            hovered: button.hovered,
            canvas: button.canvas,
            context: button.context,
            fontPx: button.fontPx,
        });
        button.canvas = rendered.canvas;
        button.context = rendered.context;
        if (!button.texture) {
            button.texture = new THREE.CanvasTexture(button.canvas);
            button.texture.needsUpdate = true;
            button.texture.anisotropy = 2;
            button.texture.minFilter = THREE.LinearFilter;
            button.texture.magFilter = THREE.LinearFilter;
            button.material.map = button.texture;
        } else {
            button.texture.needsUpdate = true;
        }
        button.material.needsUpdate = true;
        return true;
    }

    function createButton(def, view, {
        x = 0,
        y = 0,
        width = buttonWidth,
        height = buttonHeight,
        fontPx = labelFontPx,
    } = {}) {
        const material = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 1.0,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
        mesh.position.set(x, y, 0);
        mesh.renderOrder = 9001;
        view.group.add(mesh);

        const button = {
            id: def.id,
            toggle: !!def.toggle,
            labelText: String(def.label || def.id || '').trim(),
            active: false,
            hovered: false,
            mesh,
            material,
            texture: null,
            canvas: null,
            context: null,
            fontPx,
            view,
        };

        setButtonVisual(button, { hovered: false, active: false });
        registerButton(button);
        return button;
    }

    function createStaticTextPlane(view, {
        title = '',
        lines = [],
        y = 0,
        width = 0.8,
        height = 0.2,
        titleFontPx = 44,
        fontPx = 26,
    } = {}) {
        const material = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 1,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
        mesh.position.set(0, y, 0);
        mesh.renderOrder = 9001;
        view.group.add(mesh);

        const rendered = createInfoTexture({ title, lines, titleFontPx, fontPx });
        const texture = new THREE.CanvasTexture(rendered.canvas);
        texture.needsUpdate = true;
        texture.anisotropy = 2;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        material.map = texture;
        material.needsUpdate = true;

        view.staticPlanes.push({ mesh, material, texture });
        return mesh;
    }

    function createView({
        id,
        items: viewItems,
        columns,
        buttonWidth: viewButtonWidth,
        buttonHeight: viewButtonHeight,
        buttonGap: viewButtonGap,
        labelFontPx: viewLabelFontPx,
        footerItem: viewFooterItem = null,
        footerButtonWidth: viewFooterWidth = 0,
        footerButtonHeight: viewFooterHeight = viewButtonHeight,
        footerButtonGap: viewFooterGap = FOOTER_BTN_GAP,
        footerLabelFontPx: viewFooterFontPx = viewLabelFontPx,
        title = '',
        infoLines = [],
        titleFontPx = 44,
        infoFontPx = 26,
        minPanelWidth = 0,
    }) {
        const group = new THREE.Group();
        group.name = `VRMenuView_${id}`;
        group.visible = false;
        root.add(group);

        const metrics = computeGridMetrics({
            itemCount: viewItems.length,
            columns,
            buttonWidth: viewButtonWidth,
            buttonHeight: viewButtonHeight,
            buttonGap: viewButtonGap,
        });

        const titleHeight = title ? 0.1 : 0;
        const infoHeight = infoLines.length ? Math.max(0.18, (infoLines.length * 0.038) + 0.1) : 0;
        const footerHeight = viewFooterItem ? viewFooterHeight : 0;
        const sectionGap = PANEL_SECTION_GAP;
        const blockWidth = Math.max(metrics.width, viewFooterItem ? (viewFooterWidth || metrics.width) : 0);
        const panelWidth = Math.max(minPanelWidth || 0, blockWidth + (PANEL_PADDING_X * 2));

        let panelHeight = PANEL_PADDING_Y * 2;
        if (titleHeight) panelHeight += titleHeight;
        if (infoHeight) panelHeight += infoHeight;
        if (metrics.height > 0) panelHeight += metrics.height;
        if (footerHeight) panelHeight += footerHeight;

        const blocks = [titleHeight, infoHeight, metrics.height, footerHeight].filter((value) => value > 0).length;
        if (blocks > 1) {
            panelHeight += sectionGap * (blocks - 1);
        }

        const panelGeometry = new THREE.PlaneGeometry(panelWidth, panelHeight);
        const panelMaterial = new THREE.MeshBasicMaterial({
            color: 0x0f121a,
            transparent: true,
            opacity: 0.68,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
        });
        const panel = new THREE.Mesh(panelGeometry, panelMaterial);
        panel.renderOrder = 9000;
        panel.position.set(0, 0, -0.01);
        group.add(panel);

        const view = {
            id,
            group,
            panel,
            panelGeometry,
            panelMaterial,
            buttons: [],
            staticPlanes: [],
        };

        let cursorTop = (panelHeight * 0.5) - PANEL_PADDING_Y;

        if (titleHeight) {
            createStaticTextPlane(view, {
                title,
                lines: [],
                y: cursorTop - (titleHeight * 0.5),
                width: panelWidth - (PANEL_PADDING_X * 1.2),
                height: titleHeight,
                titleFontPx,
                fontPx: Math.max(18, titleFontPx * 0.6),
            });
            cursorTop -= titleHeight + sectionGap;
        }

        if (infoHeight) {
            createStaticTextPlane(view, {
                title: '',
                lines: infoLines,
                y: cursorTop - (infoHeight * 0.5),
                width: panelWidth - (PANEL_PADDING_X * 1.2),
                height: infoHeight,
                titleFontPx,
                fontPx: infoFontPx,
            });
            cursorTop -= infoHeight + sectionGap;
        }

        if (metrics.height > 0) {
            const xOffset = -((metrics.colCount - 1) * (viewButtonWidth + viewButtonGap)) * 0.5;
            const yOffset = ((metrics.rowCount - 1) * (viewButtonHeight + viewButtonGap)) * 0.5;
            const gridCenterY = cursorTop - (metrics.height * 0.5) + (viewButtonHeight * 0.5);

            viewItems.forEach((def, index) => {
                const row = Math.floor(index / metrics.colCount);
                const col = index % metrics.colCount;
                const x = xOffset + (col * (viewButtonWidth + viewButtonGap));
                const y = gridCenterY + yOffset - (row * (viewButtonHeight + viewButtonGap));
                createButton(def, view, {
                    x,
                    y,
                    width: viewButtonWidth,
                    height: viewButtonHeight,
                    fontPx: viewLabelFontPx,
                });
            });
            cursorTop -= metrics.height + sectionGap;
        }

        if (viewFooterItem) {
            const footerWidth = viewFooterWidth > 0 ? viewFooterWidth : blockWidth;
            const footerY = cursorTop - (viewFooterHeight * 0.5);
            createButton(viewFooterItem, view, {
                x: 0,
                y: footerY,
                width: footerWidth,
                height: viewFooterHeight,
                fontPx: viewFooterFontPx,
            });
        }

        state.views.set(id, view);
        return view;
    }

    createView({
        id: MAIN_VIEW_ID,
        items,
        columns: columnCount,
        buttonWidth,
        buttonHeight,
        buttonGap,
        labelFontPx,
        footerItem,
        footerButtonWidth,
        footerButtonHeight,
        footerButtonGap,
        footerLabelFontPx,
        minPanelWidth: 0.86,
    });

    if (modalView?.items?.length) {
        createView({
            id: ORDER_VIEW_ID,
            items: modalView.items,
            columns: Number.isFinite(modalView.columns) ? modalView.columns : 2,
            buttonWidth: Number.isFinite(modalView.buttonWidth) ? modalView.buttonWidth : 0.24,
            buttonHeight: Number.isFinite(modalView.buttonHeight) ? modalView.buttonHeight : 0.068,
            buttonGap: Number.isFinite(modalView.buttonGap) ? modalView.buttonGap : 0.02,
            labelFontPx: Number.isFinite(modalView.labelFontPx) ? modalView.labelFontPx : 34,
            footerItem: modalView.footerItem || null,
            footerButtonWidth: Number.isFinite(modalView.footerButtonWidth) ? modalView.footerButtonWidth : 0.72,
            footerButtonHeight: Number.isFinite(modalView.footerButtonHeight) ? modalView.footerButtonHeight : 0.072,
            footerButtonGap: Number.isFinite(modalView.footerButtonGap) ? modalView.footerButtonGap : 0.03,
            footerLabelFontPx: Number.isFinite(modalView.footerLabelFontPx) ? modalView.footerLabelFontPx : 34,
            title: String(modalView.title || ''),
            infoLines: Array.isArray(modalView.lines) ? modalView.lines : [],
            titleFontPx: Number.isFinite(modalView.titleFontPx) ? modalView.titleFontPx : 48,
            infoFontPx: Number.isFinite(modalView.infoFontPx) ? modalView.infoFontPx : 24,
            minPanelWidth: Number.isFinite(modalView.minPanelWidth) ? modalView.minPanelWidth : 0.94,
        });
    }

    function getView(id) {
        return state.views.get(id) || null;
    }

    function getActiveView() {
        return getView(state.activeViewId) || getView(MAIN_VIEW_ID);
    }

    function setActiveView(nextId, { force = false } = {}) {
        const resolvedId = state.views.has(nextId) ? nextId : MAIN_VIEW_ID;
        if (!force && state.activeViewId === resolvedId) return false;
        state.activeViewId = resolvedId;
        state.hoveredByController[0] = null;
        state.hoveredByController[1] = null;

        for (const [viewId, view] of state.views.entries()) {
            view.group.visible = state.visible && viewId === resolvedId;
        }

        let changed = false;
        for (const button of state.items) {
            changed = setButtonVisual(button, {
                hovered: false,
                active: button.active,
            }) || changed;
        }
        changed = refreshActionStates(true) || changed;
        if (state.visible) requestRender();
        return changed;
    }

    function ensureControllers() {
        if (!renderer?.xr?.getController) return;
        if (state.controllers.length) return;

        for (let i = 0; i < 2; i += 1) {
            const controller = renderer.xr.getController(i);
            if (!controller) continue;
            const grip = renderer.xr.getControllerGrip ? renderer.xr.getControllerGrip(i) : null;
            const attachRoot = getAttachmentRoot?.() || scene;
            if (!controller.parent) {
                attachRoot.add(controller);
                controller.userData.__vrMenuAttachedRoot = attachRoot;
            }
            if (grip && !grip.parent) {
                attachRoot.add(grip);
                grip.userData.__vrMenuAttachedRoot = attachRoot;
            }
            const line = createLine(THREE);
            scene.add(line);

            const onConnected = (event) => {
                controller.userData.inputSource = event?.data || null;
            };
            const onDisconnected = () => {
                controller.userData.inputSource = null;
            };

            controller.addEventListener('connected', onConnected);
            controller.addEventListener('disconnected', onDisconnected);

            state.controllers.push({
                controller,
                grip,
                line,
                onConnected,
                onDisconnected,
            });
        }
    }

    function setLinesVisible(next) {
        for (const data of state.controllers) {
            if (data?.line) data.line.visible = !!next;
        }
    }

    function recenter() {
        if (state.disposed) return false;
        camera.updateWorldMatrix(true, false);
        camera.getWorldPosition(camPos);
        camera.getWorldDirection(camDir);
        camDir.y = 0;
        if (camDir.lengthSq() <= 1e-8) {
            camDir.set(0, 0, -1);
        } else {
            camDir.normalize();
        }

        root.position.copy(camPos).addScaledVector(camDir, MENU_DISTANCE);
        root.position.y = Math.max(0.5, camPos.y - 0.12);
        lookTarget.copy(camPos);
        lookTarget.y = root.position.y;
        root.lookAt(lookTarget);
        root.updateMatrixWorld(true);
        requestRender();
        return true;
    }

    function show({ doRecenter = true } = {}) {
        if (state.disposed || state.visible) return false;
        state.visible = true;
        root.visible = true;
        setActiveView(MAIN_VIEW_ID, { force: true });
        if (doRecenter) recenter();
        setLinesVisible(true);
        refreshActionStates(true);
        requestRender();
        return true;
    }

    function hide() {
        if (state.disposed || !state.visible) return false;
        state.visible = false;
        root.visible = false;
        state.hoveredByController[0] = null;
        state.hoveredByController[1] = null;
        state.triggerPrev[0] = false;
        state.triggerPrev[1] = false;
        setLinesVisible(false);
        setActiveView(MAIN_VIEW_ID, { force: true });
        for (const button of state.items) {
            setButtonVisual(button, { hovered: false, active: button.active });
        }
        requestRender();
        return true;
    }

    function toggle() {
        if (state.visible) {
            hide();
        } else {
            show({ doRecenter: true });
        }
        return state.visible;
    }

    function refreshActionStates(force = false) {
        const now = nowMs();
        if (!force && (now - state.lastStateRefreshAt) < 180) return false;
        state.lastStateRefreshAt = now;

        let changed = false;
        for (const button of state.items) {
            const extState = getActionState(button.id) || null;
            if (!extState) continue;

            if (typeof extState.label === 'string' && extState.label.trim()) {
                button.labelText = extState.label.trim();
            }
            const nextActive = !!extState.active;
            changed = setButtonVisual(button, { hovered: button.hovered, active: nextActive }) || changed;
        }
        return changed;
    }

    function updateHoverVisuals() {
        const activeView = getActiveView();
        let changed = false;
        for (const button of state.items) {
            const isActiveViewButton = button.view === activeView;
            const isHovered = isActiveViewButton && (
                state.hoveredByController[0] === button ||
                state.hoveredByController[1] === button
            );
            changed = setButtonVisual(button, {
                hovered: isHovered,
                active: button.active,
            }) || changed;
        }
        return changed;
    }

    function getControllerTriggerPressed(controllerData) {
        const inputSource = controllerData?.controller?.userData?.inputSource || null;
        const gamepad = inputSource?.gamepad || null;
        const trigger = readButtonValue(gamepad?.buttons?.[0]);
        return trigger >= TRIGGER_THRESHOLD;
    }

    function computeControllerHit(controllerData) {
        const controller = controllerData?.controller || null;
        const activeView = getActiveView();
        if (!controller || !activeView) return null;

        controller.updateWorldMatrix(true, false);
        rayOrigin.setFromMatrixPosition(controller.matrixWorld);
        rayDir.set(0, 0, -1);
        rayDir.transformDirection(controller.matrixWorld);

        raycaster.near = 0;
        raycaster.far = MAX_RAY_DISTANCE;
        raycaster.set(rayOrigin, rayDir);
        hitTest.length = 0;
        raycaster.intersectObjects(activeView.buttons.map((it) => it.mesh), false, hitTest);
        rayEnd.copy(rayOrigin).addScaledVector(rayDir, MAX_RAY_DISTANCE);
        return {
            hit: hitTest.length ? (hitTest[0] || null) : null,
            farPoint: rayEnd,
        };
    }

    function updateVisualRay(controllerData, hitData) {
        const line = controllerData?.line || null;
        if (!line) return false;
        if (!controllerData?.controller?.userData?.inputSource) {
            line.visible = false;
            return false;
        }

        const grip = controllerData?.grip || null;
        const controller = controllerData?.controller || null;
        const originNode = grip || controller;
        if (!originNode) {
            line.visible = false;
            return false;
        }

        originNode.updateWorldMatrix(true, false);
        visualRayStart.setFromMatrixPosition(originNode.matrixWorld);

        if (hitData?.hit?.point) {
            visualRayEnd.copy(hitData.hit.point);
        } else if (hitData?.farPoint) {
            visualRayEnd.copy(hitData.farPoint);
        } else {
            line.visible = false;
            return false;
        }

        line.visible = true;
        return updateLineWorldPoints(line, visualRayStart, visualRayEnd);
    }

    function invokeAction(button) {
        if (!button) return false;
        const now = nowMs();
        if ((now - state.lastActionAt) < ACTION_COOLDOWN_MS) return false;
        state.lastActionAt = now;

        const acted = !!onAction(button.id);
        if (acted) {
            refreshActionStates(true);
            requestRender();
        }
        return acted;
    }

    function update({ session = null } = {}) {
        if (state.disposed || !state.visible || !session) return false;
        ensureControllers();

        let changed = false;
        changed = refreshActionStates(false) || changed;

        for (let i = 0; i < state.controllers.length; i += 1) {
            const ctrlData = state.controllers[i];
            const hitData = computeControllerHit(ctrlData);
            const hit = hitData?.hit || null;
            const hoveredButton = hit ? (state.byMesh.get(hit.object.uuid) || null) : null;
            state.hoveredByController[i] = hoveredButton;

            changed = updateVisualRay(ctrlData, hitData) || changed;

            const pressed = getControllerTriggerPressed(ctrlData);
            if (pressed && !state.triggerPrev[i] && hoveredButton) {
                changed = invokeAction(hoveredButton) || changed;
            }
            state.triggerPrev[i] = pressed;
        }

        changed = updateHoverVisuals() || changed;
        if (changed) requestRender();
        return changed;
    }

    function openOrderPanel() {
        if (!modalView?.items?.length) return false;
        return !!setActiveView(ORDER_VIEW_ID);
    }

    function closeOrderPanel() {
        return !!setActiveView(MAIN_VIEW_ID);
    }

    function isOrderPanelVisible() {
        return state.visible && state.activeViewId === ORDER_VIEW_ID;
    }

    function isVisible() {
        return !!state.visible;
    }

    function dispose() {
        if (state.disposed) return;
        state.disposed = true;

        hide();

        for (const data of state.controllers) {
            if (data?.line) {
                data.line.parent?.remove?.(data.line);
                data.line.geometry?.dispose?.();
                data.line.material?.dispose?.();
            }
            const controllerRoot = data?.controller?.userData?.__vrMenuAttachedRoot || null;
            if (controllerRoot && data.controller.parent === controllerRoot) {
                controllerRoot.remove(data.controller);
                delete data.controller.userData.__vrMenuAttachedRoot;
            }
            const gripRoot = data?.grip?.userData?.__vrMenuAttachedRoot || null;
            if (gripRoot && data.grip.parent === gripRoot) {
                gripRoot.remove(data.grip);
                delete data.grip.userData.__vrMenuAttachedRoot;
            }
            if (data?.controller && data?.onConnected) {
                data.controller.removeEventListener('connected', data.onConnected);
            }
            if (data?.controller && data?.onDisconnected) {
                data.controller.removeEventListener('disconnected', data.onDisconnected);
            }
        }
        state.controllers.length = 0;

        for (const button of state.items) {
            if (button?.texture) button.texture.dispose?.();
            if (button?.material) button.material.dispose?.();
            if (button?.mesh?.geometry) button.mesh.geometry.dispose?.();
            if (button?.mesh?.parent) button.mesh.parent.remove(button.mesh);
        }
        state.items.length = 0;
        state.byId.clear();
        state.byMesh.clear();

        for (const view of state.views.values()) {
            for (const staticPlane of view.staticPlanes) {
                staticPlane.texture?.dispose?.();
                staticPlane.material?.dispose?.();
                staticPlane.mesh?.geometry?.dispose?.();
                staticPlane.mesh?.parent?.remove?.(staticPlane.mesh);
            }
            view.panelGeometry?.dispose?.();
            view.panelMaterial?.dispose?.();
            view.group?.parent?.remove?.(view.group);
        }
        state.views.clear();

        if (root.parent) root.parent.remove(root);
    }

    return Object.freeze({
        show,
        hide,
        toggle,
        update,
        recenter,
        isVisible,
        openOrderPanel,
        closeOrderPanel,
        isOrderPanelVisible,
        dispose,
    });
}
