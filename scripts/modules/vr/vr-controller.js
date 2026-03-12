const QUEST_UA_RX = /(OculusBrowser|Meta Quest|Quest)/i;

const MOVE_DEADZONE = 0.16;
const TURN_DEADZONE = 0.22;
const MOVE_SPEED_MPS = 2.8;
const VERTICAL_SPEED_MPS = 2.4;
const TURN_SPEED_RAD = Math.PI * 0.9;
const BOOST_MULTIPLIER = 2.8;
const PLAYER_RADIUS_M = 0.24;
const FLOOR_CAST_UP_M = 2.0;
const FLOOR_CAST_DISTANCE_M = 10.0;
const FLOOR_MIN_NORMAL_Y = 0.35;
const FLOOR_MAX_STEP_UP_M = 0.3;
const FLOOR_MAX_STEP_DOWN_M = 0.5;
const FLOOR_REATTACH_THRESHOLD_M = 0.12;
const DEFAULT_LOOK_DISTANCE_M = 5.0;

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

function getBestAxesPair(axesLike) {
    if (!axesLike || typeof axesLike.length !== 'number' || axesLike.length < 2) {
        return null;
    }

    let best = null;
    let bestMagnitude = -1;

    for (let i = 0; i + 1 < axesLike.length; i += 2) {
        const x = Number(axesLike[i]) || 0;
        const y = Number(axesLike[i + 1]) || 0;
        const magnitude = (x * x) + (y * y);
        if (magnitude > bestMagnitude) {
            bestMagnitude = magnitude;
            best = { x, y, magnitude };
        }
    }

    return best;
}

function readButtonValue(button) {
    if (!button) return 0;
    const value = Number(button.value);
    if (Number.isFinite(value)) {
        return Math.max(0, Math.min(1, value));
    }
    return button.pressed ? 1 : 0;
}

export function createVRController(options = {}) {
    const THREE = options.THREE || null;
    const scene = options.scene || null;
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

    if (!THREE || !scene || !renderer || !camera) {
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
        xrRig: null,
        desktopCameraParent: null,
        pendingCalibration: false,
        desiredHeadYaw: 0,
        floorSnapSuppressed: false,
    };

    const raycaster = new THREE.Raycaster();
    const rayHits = [];
    const normalMatrix = new THREE.Matrix3();

    const upAxis = new THREE.Vector3(0, 1, 0);
    const downAxis = new THREE.Vector3(0, -1, 0);
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const moveDelta = new THREE.Vector3();
    const currentHeadWorldPos = new THREE.Vector3();
    const candidateHeadWorldPos = new THREE.Vector3();
    const rayStart = new THREE.Vector3();
    const rayDir = new THREE.Vector3();
    const slideDelta = new THREE.Vector3();
    const worldNormal = new THREE.Vector3();
    const lookDir = new THREE.Vector3();
    const desiredHeadWorldPos = new THREE.Vector3();
    const localHeadOffset = new THREE.Vector3();
    const worldHeadOffset = new THREE.Vector3();
    const cameraWorldPos = new THREE.Vector3();
    const rigQuat = new THREE.Quaternion();

    function detectQuestDevice() {
        if (typeof globalThis !== 'undefined' && typeof globalThis.__LPMVIEW_QUEST_DEVICE === 'boolean') {
            return globalThis.__LPMVIEW_QUEST_DEVICE;
        }
        const ua = String(win?.navigator?.userAgent || '');
        return QUEST_UA_RX.test(ua);
    }

    state.isQuest = detectQuestDevice();

    function setVrUiActive(next) {
        if (!doc?.body?.classList) return;
        doc.body.classList.toggle('vr-ui-active', !!next);
    }

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

    function ensureXrRig() {
        if (state.xrRig) return state.xrRig;
        state.xrRig = new THREE.Group();
        state.xrRig.name = 'XRUserRig';
        scene.add(state.xrRig);
        return state.xrRig;
    }

    function syncXrCameraPose() {
        if (typeof renderer?.xr?.updateCamera !== 'function') return;
        try {
            renderer.xr.updateCamera(camera);
        } catch (_) {}
    }

    function setFlatForwardFromCamera(target) {
        target.set(0, 0, -1);
        camera.getWorldDirection(target);
        target.y = 0;
        if (target.lengthSq() <= 1e-8) {
            target.set(0, 0, -1).applyQuaternion(camera.quaternion);
            target.y = 0;
        }
        if (target.lengthSq() <= 1e-8) {
            target.set(0, 0, -1);
        } else {
            target.normalize();
        }
        return target;
    }

    function yawFromDirection(direction) {
        const x = Number(direction?.x) || 0;
        const z = Number(direction?.z) || 0;
        if ((x * x + z * z) <= 1e-10) return 0;
        return Math.atan2(x, -z);
    }

    function captureDesktopCameraPose() {
        camera.updateWorldMatrix(true, false);
        camera.getWorldPosition(desiredHeadWorldPos);
        setFlatForwardFromCamera(forward);
        state.desiredHeadYaw = yawFromDirection(forward);
    }

    function alignRigToHeadPose(targetYaw, targetHeadWorldPos) {
        const rig = ensureXrRig();

        rig.rotation.set(0, targetYaw, 0);
        rigQuat.setFromAxisAngle(upAxis, targetYaw);

        localHeadOffset.copy(camera.position);
        worldHeadOffset.copy(localHeadOffset).applyQuaternion(rigQuat);

        rig.position.copy(targetHeadWorldPos).sub(worldHeadOffset);
        rig.updateMatrixWorld(true);
    }

    function calibrateRigFromCurrentView() {
        ensureXrRig();
        syncXrCameraPose();

        if (!Number.isFinite(camera.position.x) || !Number.isFinite(camera.position.y) || !Number.isFinite(camera.position.z)) {
            return false;
        }

        const currentHeadYaw = yawFromDirection(setFlatForwardFromCamera(forward));
        const targetRigYaw = state.desiredHeadYaw - currentHeadYaw;

        alignRigToHeadPose(targetRigYaw, desiredHeadWorldPos);
        state.pendingCalibration = false;
        return true;
    }

    function syncDesktopControlsFromCamera() {
        if (!controls?.target) return;

        camera.updateWorldMatrix(true, false);
        camera.getWorldPosition(cameraWorldPos);
        camera.getWorldDirection(lookDir);
        if (lookDir.lengthSq() <= 1e-10) {
            lookDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
        }
        if (lookDir.lengthSq() <= 1e-10) {
            lookDir.set(0, 0, -1);
        } else {
            lookDir.normalize();
        }

        const currentDistance = cameraWorldPos.distanceTo(controls.target);
        const distance = Number.isFinite(currentDistance) && currentDistance > 0.05
            ? currentDistance
            : DEFAULT_LOOK_DISTANCE_M;

        controls.target.copy(cameraWorldPos).addScaledVector(lookDir, distance);
        controls.update?.();
    }

    function restoreDesktopCameraParent() {
        const parent = state.desktopCameraParent || scene;

        if (parent?.attach) {
            parent.attach(camera);
        } else {
            scene.attach(camera);
        }

        camera.updateMatrixWorld(true);

        state.desktopCameraParent = null;
        syncDesktopControlsFromCamera();
    }

    function readInputAxes(session) {
        let moveX = 0;
        let moveY = 0;
        let turnX = 0;
        let verticalY = 0;
        let boost = 0;
        let moveAssigned = false;

        const sources = session?.inputSources ? Array.from(session.inputSources) : [];
        for (const source of sources) {
            const gamepad = source?.gamepad;
            const axes = gamepad?.axes;
            if (!gamepad || !axes || typeof axes.length !== 'number' || axes.length < 2) continue;

            const pair = getBestAxesPair(axes);
            if (!pair) continue;

            const axX = pair.x;
            const axY = pair.y;

            if (source.handedness === 'left') {
                moveX = axX;
                moveY = axY;
                boost = Math.max(boost, readButtonValue(gamepad.buttons?.[0]));
                moveAssigned = true;
                continue;
            }

            if (source.handedness === 'right') {
                turnX = axX;
                verticalY = -axY;
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
            verticalY: clampSigned(verticalY, MOVE_DEADZONE),
            boost: Math.max(0, Math.min(1, boost)),
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

    function translateRig(delta) {
        const rig = state.xrRig;
        if (!rig || !delta || delta.lengthSq() <= 1e-12) return false;
        rig.position.add(delta);
        rig.updateMatrixWorld(true);
        return true;
    }

    function findGroundLevelAtRig() {
        const rig = state.xrRig;
        if (!rig || !state.colliderMeshes.length) return null;

        rayStart.copy(rig.position);
        rayStart.y += FLOOR_CAST_UP_M;
        const floorHit = findClosestHit(
            rayStart,
            downAxis,
            FLOOR_CAST_DISTANCE_M,
            (candidate) => getWorldNormal(candidate).y >= FLOOR_MIN_NORMAL_Y
        );
        return floorHit?.point ? Number(floorHit.point.y) : null;
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
        camera.getWorldPosition(currentHeadWorldPos);
        candidateHeadWorldPos.copy(currentHeadWorldPos).add(moveStep);

        const blocker = findMovementBlocker(currentHeadWorldPos, candidateHeadWorldPos);
        if (!blocker) {
            return translateRig(moveStep);
        }

        const n = getWorldNormal(blocker);
        slideDelta.copy(moveStep).addScaledVector(n, -moveStep.dot(n));
        slideDelta.y = 0;
        if (slideDelta.lengthSq() <= 1e-10) return false;

        candidateHeadWorldPos.copy(currentHeadWorldPos).add(slideDelta);
        const slideBlocker = findMovementBlocker(currentHeadWorldPos, candidateHeadWorldPos);
        if (slideBlocker) return false;

        return translateRig(slideDelta);
    }

    function applyGroundSnap() {
        const rig = state.xrRig;
        if (!rig || !state.colliderMeshes.length) return false;
        const desiredRigY = findGroundLevelAtRig();
        if (!Number.isFinite(desiredRigY)) return false;

        if (state.floorSnapSuppressed) {
            const heightAboveFloor = rig.position.y - desiredRigY;
            if (heightAboveFloor > FLOOR_REATTACH_THRESHOLD_M) {
                return false;
            }
            state.floorSnapSuppressed = false;
        }

        const deltaYRaw = desiredRigY - rig.position.y;
        if (Math.abs(deltaYRaw) <= 1e-4) return false;

        const maxDelta = deltaYRaw > 0 ? FLOOR_MAX_STEP_UP_M : FLOOR_MAX_STEP_DOWN_M;
        const deltaY = Math.sign(deltaYRaw) * Math.min(Math.abs(deltaYRaw), maxDelta);
        if (Math.abs(deltaY) <= 1e-4) return false;

        rig.position.y += deltaY;
        rig.updateMatrixWorld(true);
        return true;
    }

    function applyVerticalMovement(verticalInput, dt, speedScale = 1) {
        const rig = state.xrRig;
        if (!rig) return false;

        const input = clampSigned(verticalInput, MOVE_DEADZONE);
        if (!input || !dt) return false;

        const deltaY = input * VERTICAL_SPEED_MPS * Math.max(0, speedScale) * dt;
        if (!Number.isFinite(deltaY) || Math.abs(deltaY) <= 1e-5) return false;

        let nextY = rig.position.y + deltaY;
        const floorY = findGroundLevelAtRig();

        if (Number.isFinite(floorY) && nextY <= floorY + 1e-4) {
            nextY = floorY;
            state.floorSnapSuppressed = false;
        } else {
            state.floorSnapSuppressed = true;
        }

        if (Math.abs(nextY - rig.position.y) <= 1e-5) return false;
        rig.position.y = nextY;
        rig.updateMatrixWorld(true);
        return true;
    }

    function applySmoothTurn(turnInput, dt) {
        const rig = state.xrRig;
        if (!rig) return false;

        const turn = clampSigned(turnInput, TURN_DEADZONE);
        if (!turn) return false;
        const angle = -turn * TURN_SPEED_RAD * dt;
        if (!Number.isFinite(angle) || Math.abs(angle) <= 1e-5) return false;

        camera.getWorldPosition(currentHeadWorldPos);
        const nextYaw = rig.rotation.y + angle;
        alignRigToHeadPose(nextYaw, currentHeadWorldPos);
        return true;
    }

    function handleSessionEnded() {
        state.currentSession = null;
        state.sessionActive = false;
        state.lastUpdateTime = 0;
        state.pendingCalibration = false;
        state.floorSnapSuppressed = false;
        clearAutoStartListeners();
        setVrUiActive(false);

        restoreDesktopCameraParent();

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

        captureDesktopCameraPose();

        const rig = ensureXrRig();
        state.desktopCameraParent = camera.parent || scene;
        rig.position.set(0, 0, 0);
        rig.quaternion.identity();
        rig.scale.set(1, 1, 1);
        rig.updateMatrixWorld(true);
        rig.attach(camera);
        camera.updateMatrixWorld(true);

        let session = null;
        try {
            const sessionInit = {
                optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
            };
            if (doc?.body) {
                sessionInit.optionalFeatures.push('dom-overlay');
                sessionInit.domOverlay = { root: doc.body };
            }

            session = await xr.requestSession('immersive-vr', sessionInit);

            if (renderer.xr?.setReferenceSpaceType) {
                renderer.xr.setReferenceSpaceType('local-floor');
            }

            await renderer.xr.setSession(session);
            setVrUiActive(true);
        } catch (error) {
            if (session) {
                try {
                    await session.end();
                } catch (_) {}
            }
            setVrUiActive(false);
            restoreDesktopCameraParent();
            throw error;
        }

        state.currentSession = session;
        state.sessionActive = true;
        state.lastUpdateTime = 0;
        state.pendingCalibration = true;
        state.floorSnapSuppressed = false;
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
            const overlayType = String(session?.domOverlayState?.type || '');
            if (overlayType) {
                setStatusMessage(`VR: сессия запущена. UI overlay: ${overlayType}.`);
            } else {
                setStatusMessage('VR: сессия запущена.');
            }
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
        void enterVR({ source: 'button' }).catch(() => {
            setStatusMessage('VR: не удалось запустить сессию.');
        });
    }

    function update() {
        if (!state.sessionActive) return false;
        const session = state.currentSession || renderer?.xr?.getSession?.();
        if (!session) return false;

        syncXrCameraPose();
        rebuildCollidersIfNeeded();

        let changed = false;
        if (state.pendingCalibration) {
            changed = calibrateRigFromCurrentView() || changed;
        }

        const now = nowMs();
        const dtRaw = state.lastUpdateTime ? (now - state.lastUpdateTime) / 1000 : 0;
        state.lastUpdateTime = now;
        const dt = Math.max(0, Math.min(0.1, dtRaw));

        if (dt > 0) {
            const axes = readInputAxes(session);
            const speedScale = 1 + (Math.max(0, Math.min(1, axes.boost || 0)) * (BOOST_MULTIPLIER - 1));

            if (axes.turnX) {
                changed = applySmoothTurn(axes.turnX, dt) || changed;
            }

            if (axes.moveX || axes.moveY) {
                setFlatForwardFromCamera(forward);
                if (forward.lengthSq() > 1e-8) {
                    right.crossVectors(forward, upAxis).normalize();
                    moveDelta.set(0, 0, 0);
                    moveDelta.addScaledVector(forward, -axes.moveY * MOVE_SPEED_MPS * speedScale * dt);
                    moveDelta.addScaledVector(right, axes.moveX * MOVE_SPEED_MPS * speedScale * dt);
                    moveDelta.y = 0;
                    changed = applyMovement(moveDelta) || changed;
                }
            }

            if (axes.verticalY) {
                changed = applyVerticalMovement(axes.verticalY, dt, speedScale) || changed;
            } else {
                changed = applyGroundSnap() || changed;
            }
        }

        if (changed) requestRender();
        return changed;
    }

    function dispose() {
        clearAutoStartListeners();
        setVrUiActive(false);
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
