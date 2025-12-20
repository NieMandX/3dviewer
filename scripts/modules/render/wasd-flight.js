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

    const lookSpeedRad = Number.isFinite(options.lookSpeedRad) ? options.lookSpeedRad : 1.2;
    const lookBoostMultiplier = Number.isFinite(options.lookBoostMultiplier) ? options.lookBoostMultiplier : 2.0;

    let enabled = options.enabled !== false;

    const keys = Object.seal({
        forward: false,
        back: false,
        left: false,
        right: false,
        up: false,
        down: false,
        lookUp: false,
        lookDown: false,
        lookLeft: false,
        lookRight: false,
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
        ArrowUp: 'lookUp',
        ArrowDown: 'lookDown',
        ArrowLeft: 'lookLeft',
        ArrowRight: 'lookRight',
        ShiftLeft: 'boost',
        ShiftRight: 'boost',
        AltLeft: 'slow',
        AltRight: 'slow',
    });

    const dir = THREE ? new THREE.Vector3() : null;
    const right = THREE ? new THREE.Vector3() : null;
    const upDir = THREE ? new THREE.Vector3() : null;
    const move = THREE ? new THREE.Vector3() : null;
    const lookDir = THREE ? new THREE.Vector3() : null;
    const lookAxis = THREE ? new THREE.Vector3() : null;
    const lookQuat = THREE ? new THREE.Quaternion() : null;

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
        keys.lookUp = false;
        keys.lookDown = false;
        keys.lookLeft = false;
        keys.lookRight = false;
        keys.boost = false;
        keys.slow = false;
    }

    function onKeyDown(event) {
        if (shouldIgnoreKeyDown(event)) return;
        const key = codeToKey[event.code];
        if (!key) return;
        keys[key] = true;
        event.preventDefault?.();
    }

    function onKeyUp(event) {
        if (!event) return;
        const key = codeToKey[event.code];
        if (!key) return;
        keys[key] = false;
        event.preventDefault?.();
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
        if (!THREE || !camera || !controls || !dir || !right || !upDir || !move || !lookDir || !lookAxis || !lookQuat) return false;

        // Не двигаем камеру, если пользователь вводит текст/крутит UI.
        if (doc && isEditableElement(doc.activeElement)) return false;

        const f = (keys.forward ? 1 : 0) + (keys.back ? -1 : 0);
        const s = (keys.right ? 1 : 0) + (keys.left ? -1 : 0);
        const u = (keys.up ? 1 : 0) + (keys.down ? -1 : 0);
        const yawIn = (keys.lookLeft ? 1 : 0) + (keys.lookRight ? -1 : 0);
        const pitchIn = (keys.lookUp ? 1 : 0) + (keys.lookDown ? -1 : 0);
        if (!f && !s && !u && !yawIn && !pitchIn) return false;

        // Защита от «скачка» после вкладки в фоне.
        const clampedDt = Math.max(0, Math.min(0.1, dt || 0));
        if (!clampedDt) return false;

        let changed = false;

        if (f || s || u) {
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

            if (move.lengthSq() >= 1e-12) {
                move.normalize().multiplyScalar(speed * clampedDt);
                camera.position.add(move);
                controls.target.add(move);
                changed = true;
            }
        }

        if (yawIn || pitchIn) {
            lookDir.subVectors(controls.target, camera.position);
            let lookDist = lookDir.length();
            if (!Number.isFinite(lookDist) || lookDist < 1e-6) {
                camera.getWorldDirection(lookDir);
                lookDist = 1.0;
            }
            lookDir.normalize();

            let rotSpeed = lookSpeedRad;
            if (keys.boost) rotSpeed *= lookBoostMultiplier;
            if (keys.slow) rotSpeed *= slowMultiplier;

            const yawAngle = yawIn * rotSpeed * clampedDt;
            const pitchAngle = pitchIn * rotSpeed * clampedDt;

            if (yawAngle) {
                lookAxis.copy(camera.up).normalize();
                lookQuat.setFromAxisAngle(lookAxis, yawAngle);
                lookDir.applyQuaternion(lookQuat);
            }

            if (pitchAngle) {
                lookAxis.crossVectors(lookDir, camera.up).normalize();
                if (lookAxis.lengthSq() > 1e-12) {
                    lookQuat.setFromAxisAngle(lookAxis, pitchAngle);
                    lookDir.applyQuaternion(lookQuat);
                }
            }

            controls.target.copy(camera.position).addScaledVector(lookDir, lookDist);
            changed = true;
        }

        if (changed) requestRender();
        return changed;
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
