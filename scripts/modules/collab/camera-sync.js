function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function toArray(vec) {
    return vec?.toArray?.() || [0, 0, 0];
}

function normalizeVec3(value) {
    if (!Array.isArray(value) || value.length < 3) return null;
    const out = [Number(value[0]), Number(value[1]), Number(value[2])];
    return out.every((entry) => Number.isFinite(entry)) ? out : null;
}

function normalizeOptionalNumber(value) {
    if (value == null || value === '') return null;
    const next = Number(value);
    return Number.isFinite(next) ? next : null;
}

export function createCameraSyncController(options = {}) {
    const camera = options.camera || null;
    const controls = options.controls || null;
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const collab = options.collab || null;
    const localUserId = options.localUserId || null;
    const isLocalBusy = typeof options.isLocalBusy === 'function' ? options.isLocalBusy : () => false;

    const broadcastIntervalMs = Math.max(20, Number(options.broadcastIntervalMs) || 80);
    const persistIntervalMs = Math.max(200, Number(options.persistIntervalMs) || 1200);
    const idleDelayMs = Math.max(200, Number(options.idleDelayMs) || 900);

    let ownerId = null;
    let isOwner = false;
    let lastBroadcastAt = 0;
    let lastPersistAt = 0;
    let lastLocalActivityAt = -Infinity;
    let lastAppliedRemoteTs = -Infinity;
    let localActive = false;
    let applyingRemote = false;
    let disposed = false;

    function captureCameraState() {
        if (!camera || !controls) return null;
        return {
            position: toArray(camera.position),
            target: toArray(controls.target),
            up: toArray(camera.up),
            fov: camera.fov,
            zoom: camera.zoom,
            near: camera.near,
            far: camera.far,
            ts: Date.now(),
        };
    }

    function applyCameraState(state) {
        if (!camera || !controls || !state) return false;
        const pos = normalizeVec3(state.position);
        const tgt = normalizeVec3(state.target);
        const up = normalizeVec3(state.up);
        if (!pos || !tgt) return false;

        applyingRemote = true;
        try {
            camera.position.set(pos[0], pos[1], pos[2]);
            controls.target.set(tgt[0], tgt[1], tgt[2]);
            if (up && up.length >= 3) camera.up.set(up[0], up[1], up[2]);
            const fov = normalizeOptionalNumber(state.fov);
            const zoom = normalizeOptionalNumber(state.zoom);
            const near = normalizeOptionalNumber(state.near);
            const far = normalizeOptionalNumber(state.far);
            if (fov != null) camera.fov = fov;
            if (zoom != null) camera.zoom = zoom;
            if (near != null) camera.near = near;
            if (far != null) camera.far = far;
            camera.updateProjectionMatrix();
            controls.update();
            requestRender();
            return true;
        } finally {
            applyingRemote = false;
        }
    }

    function getRemoteTimestamp(payload) {
        const ts = Number(payload?.ts);
        return Number.isFinite(ts) ? ts : null;
    }

    function markLocalActivity(active) {
        localActive = !!active;
        if (localActive) {
            lastLocalActivityAt = nowMs();
        } else {
            lastLocalActivityAt = nowMs();
        }
    }

    function shouldFollowRemote() {
        if (localActive) return false;
        if (isLocalBusy()) return false;
        if (nowMs() - lastLocalActivityAt < idleDelayMs) return false;
        return true;
    }

    function handleRemoteState(payload) {
        if (disposed) return;
        if (!payload || payload.sender === localUserId) return;
        if (!shouldFollowRemote()) return;
        const remoteTs = getRemoteTimestamp(payload);
        if (remoteTs != null && remoteTs < lastAppliedRemoteTs) return;
        if (applyCameraState(payload) && remoteTs != null) {
            lastAppliedRemoteTs = Math.max(lastAppliedRemoteTs, remoteTs);
        }
    }

    function handleControlsChange() {
        if (disposed || !isOwner || applyingRemote || !collab) return;
        const now = nowMs();
        if (now - lastBroadcastAt >= broadcastIntervalMs) {
            lastBroadcastAt = now;
            const state = captureCameraState();
            if (state) {
                Promise.resolve(collab.broadcastCameraState(state)).catch((err) => {
                    if (!disposed) console.warn('Camera broadcast failed', err);
                });
            }
        }
        if (now - lastPersistAt >= persistIntervalMs) {
            lastPersistAt = now;
            const state = captureCameraState();
            if (state) {
                Promise.resolve(collab.persistCameraState(state)).catch((err) => {
                    if (!disposed) console.warn('Camera persist failed', err);
                });
            }
        }
    }

    function setOwner(nextOwnerId) {
        if (disposed) return;
        ownerId = nextOwnerId || null;
        isOwner = !!(ownerId && localUserId && ownerId === localUserId);
    }

    let onControlsStart = null;
    let onControlsEnd = null;
    let onControlsChange = null;

    function attachControlsListeners() {
        if (!controls?.addEventListener) return;
        onControlsStart = () => markLocalActivity(true);
        onControlsEnd = () => markLocalActivity(false);
        onControlsChange = () => handleControlsChange();
        controls.addEventListener('start', onControlsStart);
        controls.addEventListener('end', onControlsEnd);
        controls.addEventListener('change', onControlsChange);
    }

    function detachControlsListeners() {
        if (!controls?.removeEventListener) return;
        if (onControlsStart) controls.removeEventListener('start', onControlsStart);
        if (onControlsEnd) controls.removeEventListener('end', onControlsEnd);
        if (onControlsChange) controls.removeEventListener('change', onControlsChange);
    }

    attachControlsListeners();

    function dispose() {
        disposed = true;
        detachControlsListeners();
    }

    return Object.freeze({
        setOwner,
        isOwner: () => isOwner,
        handleRemoteState,
        markLocalActivity,
        captureCameraState,
        applyCameraState,
        dispose,
    });
}
