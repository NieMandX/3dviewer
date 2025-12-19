export function createWASDFlightController(options = {}) {
    const THREE = options.THREE || null;
    const camera = options.camera || null;
    const controls = options.controls || null;
    const win =
        options.window ||
        (typeof globalThis !== 'undefined' ? globalThis.window : null) ||
        null;
    const doc =
        options.document ||
        (typeof globalThis !== 'undefined' ? globalThis.document : null) ||
        null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};

    const speedFactor = Number.isFinite(options.speedFactor) ? options.speedFactor : 0.6;
    const minSpeed = Number.isFinite(options.minSpeed) ? options.minSpeed : 0.25;
    const maxSpeed = Number.isFinite(options.maxSpeed) ? options.maxSpeed : 250;
    const boostMultiplier = Number.isFinite(options.boostMultiplier) ? options.boostMultiplier : 3.0;
    const slowMultiplier = Number.isFinite(options.slowMultiplier) ? options.slowMultiplier : 0.25;

    let enabled = options.enabled !== false;

    const keys = Object.seal({
        forward: false,
        back: false,
        left: false,
        right: false,
        up: false,
        down: false,
        boost: false,
        slow: false,
    });

    const codeToKey = Object.freeze({
        KeyW: 'forward',
        KeyS: 'back',
        KeyA: 'left',
        KeyD: 'right',
        KeyE: 'up',
        KeyQ: 'down',
        ShiftLeft: 'boost',
        ShiftRight: 'boost',
        AltLeft: 'slow',
        AltRight: 'slow',
    });

    const dir = THREE ? new THREE.Vector3() : null;
    const right = THREE ? new THREE.Vector3() : null;
    const upDir = THREE ? new THREE.Vector3() : null;
    const move = THREE ? new THREE.Vector3() : null;

    function timeNow() {
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
            return performance.now();
        }
        return Date.now();
    }

    let lastNow = 0;

    function isEditableElement(el) {
        if (!el) return false;
        const tag = String(el.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        if (el.isContentEditable) return true;
        return false;
    }

    function shouldIgnoreKeyDown(event) {
        if (!event) return true;
        if (event.metaKey || event.ctrlKey) return true;
        if (isEditableElement(event.target)) return true;
        return false;
    }

    function resetKeys() {
        keys.forward = false;
        keys.back = false;
        keys.left = false;
        keys.right = false;
        keys.up = false;
        keys.down = false;
        keys.boost = false;
        keys.slow = false;
    }

    function onKeyDown(event) {
        if (shouldIgnoreKeyDown(event)) return;
        const key = codeToKey[event.code];
        if (!key) return;
        keys[key] = true;
    }

    function onKeyUp(event) {
        if (!event) return;
        const key = codeToKey[event.code];
        if (!key) return;
        keys[key] = false;
    }

    function setEnabled(nextEnabled) {
        enabled = !!nextEnabled;
        if (!enabled) resetKeys();
    }

    function update() {
        const now = timeNow();
        const dt = lastNow ? (now - lastNow) / 1000 : 0;
        lastNow = now;

        if (!enabled) return false;
        if (!THREE || !camera || !controls || !dir || !right || !upDir || !move) return false;

        // Не двигаем камеру, если пользователь вводит текст/крутит UI.
        if (doc && isEditableElement(doc.activeElement)) return false;

        const f = (keys.forward ? 1 : 0) + (keys.back ? -1 : 0);
        const s = (keys.right ? 1 : 0) + (keys.left ? -1 : 0);
        const u = (keys.up ? 1 : 0) + (keys.down ? -1 : 0);
        if (!f && !s && !u) return false;

        // Защита от «скачка» после вкладки в фоне.
        const clampedDt = Math.max(0, Math.min(0.1, dt || 0));
        if (!clampedDt) return false;

        const distance = camera.position.distanceTo(controls.target);
        let speed = distance * speedFactor;
        if (!Number.isFinite(speed) || speed <= 0) speed = minSpeed;
        speed = Math.max(minSpeed, Math.min(maxSpeed, speed));
        if (keys.boost) speed *= boostMultiplier;
        if (keys.slow) speed *= slowMultiplier;

        camera.getWorldDirection(dir);
        dir.normalize();
        right.crossVectors(dir, camera.up).normalize();
        upDir.copy(camera.up).normalize();

        move.set(0, 0, 0);
        move.addScaledVector(dir, f);
        move.addScaledVector(right, s);
        move.addScaledVector(upDir, u);

        if (move.lengthSq() < 1e-12) return false;
        move.normalize().multiplyScalar(speed * clampedDt);

        camera.position.add(move);
        controls.target.add(move);

        requestRender();
        return true;
    }

    function dispose() {
        resetKeys();
        if (win?.removeEventListener) {
            win.removeEventListener('keydown', onKeyDown);
            win.removeEventListener('keyup', onKeyUp);
            win.removeEventListener('blur', resetKeys);
        }
    }

    if (win?.addEventListener) {
        win.addEventListener('keydown', onKeyDown);
        win.addEventListener('keyup', onKeyUp);
        win.addEventListener('blur', resetKeys);
    }

    return Object.freeze({
        update,
        dispose,
        setEnabled,
        isEnabled: () => enabled,
        resetKeys,
    });
}
