const QUEST_UA_RX = /(OculusBrowser|Meta Quest|Quest)/i;

const MOVE_DEADZONE = 0.16;
const TURN_DEADZONE = 0.22;
const MOVE_SPEED_MPS = 2.8;
const TURN_SPEED_RAD = Math.PI * 0.9;
const PLAYER_RADIUS_M = 0.24;
const EYE_HEIGHT_M = 1.62;
const FLOOR_CAST_UP_M = 2.0;
const FLOOR_CAST_DISTANCE_M = 10.0;
const FLOOR_MIN_NORMAL_Y = 0.35;
const FLOOR_MAX_STEP_UP_M = 0.3;
const FLOOR_MAX_STEP_DOWN_M = 0.5;

function clampSigned(value, deadzone) {
    const v = Number(value) || 0;
    const dz = Math.max(0, Math.min(0.95, Number(deadzone) || 0));
    const abs = Math.abs(v);
    if (abs <= dz) return 0;
    const scaled = (abs - dz) / (1 - dz);
    return Math.sign(v) * Math.max(0, Math.min(1, scaled));
}

function nowMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

export function createVRController(options = {}) {
    const THREE = options.THREE || null;
    const renderer = options.renderer || null;
    const camera = options.camera || null;
    const controls = options.controls || null;
    const flightControls = options.flightControls || null;
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];
    const vrToggleBtn = options.vrToggleBtn || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const setStatusMessage = typeof options.setStatusMessage === 'function' ? options.setStatusMessage : () => {};

    const win = options.window || (typeof window !== 'undefined' ? window : null);
    const doc = options.document || (typeof document !== 'undefined' ? document : null);

    if (!THREE || !renderer || !camera) {
        return Object.freeze({
            update: () => false,
            enterVR: async () => false,
            exitVR: async () => false,
            isQuestDevice: () => false,
            isSupported: () => false,
            isPresenting: () => false,
            dispose: () => {},
        });
    }

    if (renderer.xr && Object.prototype.hasOwnProperty.call(renderer.xr, 'enabled')) {
        renderer.xr.enabled = true;
    }

    const state = {
        supportKnown: false,
        supported: false,
        supportPromise: null,
        isQuest: false,
        autoStartArmed: false,
        autoStartTriggered: false,
        autoStartListeners: [],
        currentSession: null,
        sessionActive: false,
        prevControlsEnabled: true,
        prevFlightEnabled: true,
        collidersSignature: '',
        colliderMeshes: [],
        lastUpdateTime: 0,
    };

    const raycaster = new THREE.Raycaster();
    const rayHits = [];
    const normalMatrix = new THREE.Matrix3();

    const upAxis = new THREE.Vector3(0, 1, 0);
    const downAxis = new THREE.Vector3(0, -1, 0);
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const moveDelta = new THREE.Vector3();
    const currentPos = new THREE.Vector3();
    const candidatePos = new THREE.Vector3();
    const rayStart = new THREE.Vector3();
    const rayDir = new THREE.Vector3();
    const slideDelta = new THREE.Vector3();
    const worldNormal = new THREE.Vector3();
    const lookDir = new THREE.Vector3();

    function detectQuestDevice() {
        if (typeof globalThis !== 'undefined' && typeof globalThis.__LPMVIEW_QUEST_DEVICE === 'boolean') {
            return globalThis.__LPMVIEW_QUEST_DEVICE;
        }
        const ua = String(win?.navigator?.userAgent || '');
        return QUEST_UA_RX.test(ua);
    }

    state.isQuest = detectQuestDevice();

    function updateButtonUi() {
        if (!vrToggleBtn) return;
        vrToggleBtn.classList.toggle('is-active', !!state.sessionActive);
        vrToggleBtn.classList.toggle('is-supported', !!state.supported);
        vrToggleBtn.classList.toggle('is-unsupported', state.supportKnown && !state.supported);
        vrToggleBtn.setAttribute('aria-pressed', state.sessionActive ? 'true' : 'false');

        if (state.sessionActive) {
            vrToggleBtn.textContent = 'VR ON';
            vrToggleBtn.title = 'Выйти из VR';
            vrToggleBtn.disabled = false;
            return;
        }

        if (!state.supportKnown) {
            vrToggleBtn.textContent = state.isQuest ? 'VR Q3' : 'VR';
            vrToggleBtn.title = state.isQuest
                ? 'Проверка WebXR на Quest...'
                : 'Проверка WebXR...';
            vrToggleBtn.disabled = true;
            return;
        }

        if (state.supported) {
            vrToggleBtn.textContent = state.isQuest ? 'VR Q3' : 'VR';
            vrToggleBtn.title = state.isQuest
                ? 'Войти в VR (Quest 3)'
                : 'Войти в VR';
            vrToggleBtn.disabled = false;
            return;
        }

        vrToggleBtn.textContent = 'VR N/A';
        vrToggleBtn.title = 'WebXR immersive-vr не поддерживается';
        vrToggleBtn.disabled = true;
    }

    function clearAutoStartListeners() {
        while (state.autoStartListeners.length) {
            const [target, type, handler, opts] = state.autoStartListeners.pop();
            try {
                target.removeEventListener(type, handler, opts);
            } catch (_) {}
        }
    }

    function addAutoStartListener(target, type, handler, opts) {
        if (!target?.addEventListener) return;
        target.addEventListener(type, handler, opts);
        state.autoStartListeners.push([target, type, handler, opts]);
    }

    function armQuestAutoStart() {
        if (!state.isQuest || !state.supported || state.autoStartArmed || state.autoStartTriggered) return;
        if (!doc) return;

        state.autoStartArmed = true;
        const opts = { passive: true, once: true };

        const run = async () => {
            state.autoStartTriggered = true;
            clearAutoStartListeners();
            try {
                await enterVR({ source: 'quest-auto' });
            } catch (_) {
                // На ряде прошивок браузер всё равно требует явный клик по кнопке.
                setStatusMessage('VR: нажмите кнопку VR для входа.');
            }
        };

        addAutoStartListener(doc, 'pointerup', run, opts);
        addAutoStartListener(doc, 'touchend', run, opts);
        addAutoStartListener(doc, 'keydown', run, opts);
    }

    async function ensureSupportKnown() {
        if (state.supportKnown) return state.supported;
        if (state.supportPromise) return state.supportPromise;

        state.supportPromise = (async () => {
            try {
                const xr = win?.navigator?.xr;
                if (!xr || typeof xr.isSessionSupported !== 'function') {
                    state.supported = false;
                } else {
                    state.supported = !!(await xr.isSessionSupported('immersive-vr'));
                }
            } catch (_) {
                state.supported = false;
            } finally {
                state.supportKnown = true;
                updateButtonUi();
                if (state.supported) {
                    armQuestAutoStart();
                }
            }
            return state.supported;
        })();

        return state.supportPromise;
    }

    function readInputAxes(session) {
        let moveX = 0;
        let moveY = 0;
        let turnX = 0;
        let moveAssigned = false;

        const sources = session?.inputSources ? Array.from(session.inputSources) : [];
        for (const source of sources) {
            const gamepad = source?.gamepad;
            if (!gamepad || !Array.isArray(gamepad.axes) || gamepad.axes.length < 2) continue;

            const axX = Number(gamepad.axes[0]) || 0;
            const axY = Number(gamepad.axes[1]) || 0;

            if (source.handedness === 'left') {
                moveX = axX;
                moveY = axY;
                moveAssigned = true;
                continue;
            }

            if (source.handedness === 'right') {
                turnX = axX;
                if (!moveAssigned) {
                    moveX = axX;
                    moveY = axY;
                }
                continue;
            }

            if (!moveAssigned) {
                moveX = axX;
                moveY = axY;
                moveAssigned = true;
            }
        }

        return {
            moveX: clampSigned(moveX, MOVE_DEADZONE),
            moveY: clampSigned(moveY, MOVE_DEADZONE),
            turnX: clampSigned(turnX, TURN_DEADZONE),
        };
    }

    function getWorldNormal(hit) {
        if (!hit?.face || !hit.object?.matrixWorld) {
            worldNormal.set(0, 1, 0);
            return worldNormal;
        }
        normalMatrix.getNormalMatrix(hit.object.matrixWorld);
        worldNormal.copy(hit.face.normal).applyMatrix3(normalMatrix).normalize();
        return worldNormal;
    }

    function findClosestHit(origin, direction, far, predicate = null) {
        const maxDistance = Math.max(0.001, Number(far) || 0.001);
        raycaster.near = 0;
        raycaster.far = maxDistance;
        raycaster.ray.origin.copy(origin);
        raycaster.ray.direction.copy(direction).normalize();

        let closest = null;
        for (const mesh of state.colliderMeshes) {
            if (!mesh?.isMesh || !mesh.geometry) continue;
            mesh.updateWorldMatrix?.(true, false);
            rayHits.length = 0;
            mesh.raycast(raycaster, rayHits);
            for (const hit of rayHits) {
                const distance = Number(hit?.distance);
                if (!Number.isFinite(distance) || distance <= 1e-4) continue;
                if (predicate && !predicate(hit)) continue;
                if (!closest || distance < closest.distance) {
                    closest = hit;
                }
            }
        }
        return closest;
    }

    function rebuildCollidersIfNeeded() {
        const signature = loadedModels
            .map((model) => `${model?.obj?.uuid || ''}:${String(model?.zipKind || '').toUpperCase()}`)
            .join('|');
        if (signature === state.collidersSignature) return;

        state.collidersSignature = signature;
        state.colliderMeshes.length = 0;

        loadedModels.forEach((model) => {
            if (!model?.obj) return;
            if (String(model.zipKind || '').toUpperCase() !== 'SM') return;
            model.obj.traverse((node) => {
                if (!node?.isMesh) return;
                if (!node.userData?.isCollision) return;
                state.colliderMeshes.push(node);
            });
        });
    }

    function translateCamera(delta) {
        if (!delta || delta.lengthSq() <= 1e-12) return false;
        camera.position.add(delta);
        if (controls?.target) {
            controls.target.add(delta);
        }
        return true;
    }

    function findMovementBlocker(start, end) {
        rayDir.subVectors(end, start);
        const distance = rayDir.length();
        if (!Number.isFinite(distance) || distance <= 1e-6) return null;
        rayDir.multiplyScalar(1 / distance);

        const offsets = [0.0, -0.55, -1.1];
        for (const offsetY of offsets) {
            rayStart.copy(start);
            rayStart.y += offsetY;
            const hit = findClosestHit(
                rayStart,
                rayDir,
                distance + PLAYER_RADIUS_M,
                (candidate) => Math.abs(getWorldNormal(candidate).y) < 0.8
            );
            if (hit) return hit;
        }
        return null;
    }

    function applyMovement(moveStep) {
        if (!moveStep || moveStep.lengthSq() <= 1e-12) return false;
        currentPos.copy(camera.position);
        candidatePos.copy(currentPos).add(moveStep);

        const blocker = findMovementBlocker(currentPos, candidatePos);
        if (!blocker) {
            return translateCamera(moveStep);
        }

        const n = getWorldNormal(blocker);
        slideDelta.copy(moveStep).addScaledVector(n, -moveStep.dot(n));
        slideDelta.y = 0;
        if (slideDelta.lengthSq() <= 1e-10) return false;

        candidatePos.copy(currentPos).add(slideDelta);
        const slideBlocker = findMovementBlocker(currentPos, candidatePos);
        if (slideBlocker) return false;

        return translateCamera(slideDelta);
    }

    function applyGroundSnap() {
        if (!state.colliderMeshes.length) return false;

        rayStart.copy(camera.position);
        rayStart.y += FLOOR_CAST_UP_M;
        const floorHit = findClosestHit(
            rayStart,
            downAxis,
            FLOOR_CAST_DISTANCE_M,
            (candidate) => getWorldNormal(candidate).y >= FLOOR_MIN_NORMAL_Y
        );
        if (!floorHit?.point) return false;

        const desiredEyeY = Number(floorHit.point.y) + EYE_HEIGHT_M;
        if (!Number.isFinite(desiredEyeY)) return false;

        const deltaYRaw = desiredEyeY - camera.position.y;
        if (Math.abs(deltaYRaw) <= 1e-4) return false;

        const maxDelta = deltaYRaw > 0 ? FLOOR_MAX_STEP_UP_M : FLOOR_MAX_STEP_DOWN_M;
        const deltaY = Math.sign(deltaYRaw) * Math.min(Math.abs(deltaYRaw), maxDelta);
        if (Math.abs(deltaY) <= 1e-4) return false;

        camera.position.y += deltaY;
        if (controls?.target) controls.target.y += deltaY;
        return true;
    }

    function applySmoothTurn(turnInput, dt) {
        const turn = clampSigned(turnInput, TURN_DEADZONE);
        if (!turn) return false;
        const angle = -turn * TURN_SPEED_RAD * dt;
        if (!Number.isFinite(angle) || Math.abs(angle) <= 1e-5) return false;

        camera.rotateOnWorldAxis(upAxis, angle);
        if (controls?.target) {
            lookDir.subVectors(controls.target, camera.position);
            if (lookDir.lengthSq() <= 1e-10) {
                lookDir.set(0, 0, -1);
            }
            lookDir.applyAxisAngle(upAxis, angle);
            controls.target.copy(camera.position).add(lookDir);
        }
        return true;
    }

    function handleSessionEnded() {
        state.currentSession = null;
        state.sessionActive = false;
        state.lastUpdateTime = 0;
        clearAutoStartListeners();

        if (controls) controls.enabled = state.prevControlsEnabled;
        if (flightControls?.setEnabled) flightControls.setEnabled(state.prevFlightEnabled);

        updateButtonUi();
        requestRender();
    }

    async function enterVR({ source = 'manual' } = {}) {
        if (state.sessionActive) return true;
        const xr = win?.navigator?.xr;
        if (!xr || !renderer?.xr?.setSession) return false;

        const supported = await ensureSupportKnown();
        if (!supported) return false;

        const session = await xr.requestSession('immersive-vr', {
            optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
        });

        if (renderer.xr?.setReferenceSpaceType) {
            renderer.xr.setReferenceSpaceType('local-floor');
        }

        await renderer.xr.setSession(session);

        state.currentSession = session;
        state.sessionActive = true;
        state.lastUpdateTime = 0;
        state.prevControlsEnabled = controls ? controls.enabled !== false : true;
        state.prevFlightEnabled = flightControls?.isEnabled ? !!flightControls.isEnabled() : true;

        if (controls) controls.enabled = false;
        if (flightControls?.setEnabled) flightControls.setEnabled(false);

        rebuildCollidersIfNeeded();
        session.addEventListener('end', handleSessionEnded, { once: true });
        updateButtonUi();
        requestRender();

        if (source === 'quest-auto') {
            setStatusMessage('VR: сессия запущена автоматически (Quest).');
        } else {
            setStatusMessage('VR: сессия запущена.');
        }
        return true;
    }

    async function exitVR() {
        const session = state.currentSession || renderer?.xr?.getSession?.();
        if (!session) return false;
        try {
            await session.end();
            return true;
        } catch (_) {
            return false;
        }
    }

    function toggleVR() {
        if (state.sessionActive) {
            void exitVR();
            return;
        }
        void enterVR({ source: 'button' });
    }

    function update() {
        if (!state.sessionActive) return false;
        const session = state.currentSession || renderer?.xr?.getSession?.();
        if (!session) return false;

        const now = nowMs();
        const dtRaw = state.lastUpdateTime ? (now - state.lastUpdateTime) / 1000 : 0;
        state.lastUpdateTime = now;
        const dt = Math.max(0, Math.min(0.1, dtRaw));
        if (!dt) return false;

        rebuildCollidersIfNeeded();

        const xrCamera = renderer?.xr?.getCamera?.(camera) || camera;
        const axes = readInputAxes(session);
        let changed = false;

        if (axes.turnX) {
            changed = applySmoothTurn(axes.turnX, dt) || changed;
        }

        if (axes.moveX || axes.moveY) {
            xrCamera.getWorldDirection(forward);
            forward.y = 0;
            if (forward.lengthSq() <= 1e-8) {
                forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
                forward.y = 0;
            }
            if (forward.lengthSq() > 1e-8) {
                forward.normalize();
                right.crossVectors(forward, upAxis).normalize();
                moveDelta.set(0, 0, 0);
                moveDelta.addScaledVector(forward, -axes.moveY * MOVE_SPEED_MPS * dt);
                moveDelta.addScaledVector(right, axes.moveX * MOVE_SPEED_MPS * dt);
                moveDelta.y = 0;
                changed = applyMovement(moveDelta) || changed;
            }
        }

        changed = applyGroundSnap() || changed;
        if (changed) requestRender();
        return changed;
    }

    function dispose() {
        clearAutoStartListeners();
        if (vrToggleBtn?.removeEventListener) {
            vrToggleBtn.removeEventListener('click', toggleVR);
        }
    }

    if (vrToggleBtn?.addEventListener) {
        vrToggleBtn.addEventListener('click', toggleVR);
    }

    updateButtonUi();
    void ensureSupportKnown();

    return Object.freeze({
        update,
        enterVR,
        exitVR,
        isQuestDevice: () => state.isQuest,
        isSupported: () => state.supported,
        isPresenting: () => state.sessionActive,
        dispose,
    });
}
