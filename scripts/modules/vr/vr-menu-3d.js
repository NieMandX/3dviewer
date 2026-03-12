const DEFAULT_ITEMS = Object.freeze([
    { id: 'exit_vr', label: 'EXIT VR', toggle: false },
    { id: 'reset_view', label: 'RESET VIEW', toggle: false },
    { id: 'toggle_ucx', label: 'UCX', toggle: true },
    { id: 'toggle_vpm', label: 'VPM', toggle: true },
    { id: 'toggle_npm', label: 'NPM', toggle: true },
    { id: 'toggle_bg', label: 'BG', toggle: true },
    { id: 'recenter_menu', label: 'RECENTER', toggle: false },
]);

const BTN_W = 0.36;
const BTN_H = 0.12;
const BTN_GAP = 0.035;
const MENU_DISTANCE = 1.45;
const MAX_RAY_DISTANCE = 5.0;
const ACTION_COOLDOWN_MS = 220;
const TRIGGER_THRESHOLD = 0.62;

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

function createLabelTexture({ label, active = false, hovered = false, canvas = null, context = null } = {}) {
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
    if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(8, 8, cv.width - 16, cv.height - 16, 24);
        ctx.fill();
        ctx.stroke();
    } else {
        ctx.fillRect(8, 8, cv.width - 16, cv.height - 16);
        ctx.strokeRect(8, 8, cv.width - 16, cv.height - 16);
    }

    ctx.fillStyle = fg;
    ctx.font = '700 52px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(label || '').toUpperCase(), cv.width * 0.5, cv.height * 0.52);

    return { canvas: cv, context: ctx, texture: null };
}

function createLine(THREE) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3)
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
    line.scale.z = MAX_RAY_DISTANCE;
    return line;
}

export function createVRMenu3D(options = {}) {
    const THREE = options.THREE || null;
    const scene = options.scene || null;
    const renderer = options.renderer || null;
    const camera = options.camera || null;
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const onAction = typeof options.onAction === 'function' ? options.onAction : () => false;
    const getActionState = typeof options.getActionState === 'function' ? options.getActionState : () => null;
    const items = Array.isArray(options.items) && options.items.length ? options.items : DEFAULT_ITEMS;

    if (!THREE || !scene || !renderer || !camera) {
        return Object.freeze({
            show: () => false,
            hide: () => false,
            toggle: () => false,
            update: () => false,
            recenter: () => false,
            isVisible: () => false,
            dispose: () => {},
        });
    }

    const raycaster = new THREE.Raycaster();
    const rayOrigin = new THREE.Vector3();
    const rayDir = new THREE.Vector3();
    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();
    const hitTest = [];

    const root = new THREE.Group();
    root.name = 'VRMenuRoot';
    root.visible = false;
    scene.add(root);

    const state = {
        visible: false,
        disposed: false,
        lastActionAt: 0,
        lastStateRefreshAt: 0,
        items: [],
        byMesh: new Map(),
        byId: new Map(),
        hoveredByController: [null, null],
        triggerPrev: [false, false],
        controllers: [],
    };

    const colCount = 3;
    const rowCount = Math.ceil(items.length / colCount);
    const menuWidth = (colCount * BTN_W) + ((colCount - 1) * BTN_GAP) + 0.12;
    const menuHeight = (rowCount * BTN_H) + ((rowCount - 1) * BTN_GAP) + 0.12;

    const panelGeometry = new THREE.PlaneGeometry(menuWidth, menuHeight);
    const panelMaterial = new THREE.MeshBasicMaterial({
        color: 0x0f121a,
        transparent: true,
        opacity: 0.56,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
    });
    const panel = new THREE.Mesh(panelGeometry, panelMaterial);
    panel.renderOrder = 9000;
    panel.position.set(0, 0, -0.01);
    root.add(panel);

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

    function createButton(def, index) {
        const row = Math.floor(index / colCount);
        const col = index % colCount;

        const xOffset = -((colCount - 1) * (BTN_W + BTN_GAP)) * 0.5;
        const yOffset = ((rowCount - 1) * (BTN_H + BTN_GAP)) * 0.5;

        const x = xOffset + (col * (BTN_W + BTN_GAP));
        const y = yOffset - (row * (BTN_H + BTN_GAP));

        const material = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 1.0,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(BTN_W, BTN_H), material);
        mesh.position.set(x, y, 0);
        mesh.renderOrder = 9001;
        root.add(mesh);

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
        };

        setButtonVisual(button, { hovered: false, active: false });
        state.byMesh.set(mesh.uuid, button);
        state.byId.set(button.id, button);
        state.items.push(button);
    }

    items.forEach((def, index) => createButton(def, index));

    function ensureControllers() {
        if (!renderer?.xr?.getController) return;
        if (state.controllers.length) return;

        for (let i = 0; i < 2; i += 1) {
            const controller = renderer.xr.getController(i);
            const grip = typeof renderer?.xr?.getControllerGrip === 'function'
                ? renderer.xr.getControllerGrip(i)
                : null;
            if (!controller) continue;
            if (!controller.parent) {
                scene.add(controller);
                controller.userData.__vrMenuAttachedToScene = true;
            }
            if (grip && !grip.parent) {
                scene.add(grip);
                grip.userData.__vrMenuAttachedToScene = true;
            }

            const rayNode = grip || controller;
            const line = createLine(THREE);
            rayNode.add(line);

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
                rayNode,
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
        let changed = false;
        for (const button of state.items) {
            const isHovered =
                state.hoveredByController[0] === button ||
                state.hoveredByController[1] === button;
            changed = setButtonVisual(button, { hovered: isHovered, active: button.active }) || changed;
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
        const rayObject = controllerData?.rayNode || controllerData?.controller || null;
        if (!rayObject) return null;

        rayObject.updateWorldMatrix(true, false);
        rayOrigin.setFromMatrixPosition(rayObject.matrixWorld);
        rayDir.set(0, 0, -1);
        rayDir.transformDirection(rayObject.matrixWorld);

        raycaster.near = 0;
        raycaster.far = MAX_RAY_DISTANCE;
        raycaster.set(rayOrigin, rayDir);
        hitTest.length = 0;
        raycaster.intersectObjects(state.items.map((it) => it.mesh), false, hitTest);
        if (!hitTest.length) return null;
        return hitTest[0] || null;
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
            const hit = computeControllerHit(ctrlData);
            const hoveredButton = hit ? (state.byMesh.get(hit.object.uuid) || null) : null;
            state.hoveredByController[i] = hoveredButton;

            if (ctrlData?.line) {
                ctrlData.line.visible = true;
                ctrlData.line.scale.z = hit?.distance ? Math.max(0.06, hit.distance) : MAX_RAY_DISTANCE;
            }

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

    function isVisible() {
        return !!state.visible;
    }

    function dispose() {
        if (state.disposed) return;
        state.disposed = true;

        hide();

        for (const data of state.controllers) {
            if (data?.rayNode && data?.line) {
                data.rayNode.remove(data.line);
                data.line.geometry?.dispose?.();
                data.line.material?.dispose?.();
            }
            if (data?.controller?.userData?.__vrMenuAttachedToScene && data.controller.parent === scene) {
                scene.remove(data.controller);
                delete data.controller.userData.__vrMenuAttachedToScene;
            }
            if (data?.grip?.userData?.__vrMenuAttachedToScene && data.grip.parent === scene) {
                scene.remove(data.grip);
                delete data.grip.userData.__vrMenuAttachedToScene;
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

        panelGeometry.dispose?.();
        panelMaterial.dispose?.();
        if (root.parent) root.parent.remove(root);
    }

    return Object.freeze({
        show,
        hide,
        toggle,
        update,
        recenter,
        isVisible,
        dispose,
    });
}
