export function createExportModalController(options = {}) {
    const modalEl = options.modalEl || null;
    const titleEl = options.titleEl || null;
    const formatEl = options.formatEl || null;
    const coordsEl = options.coordsEl || null;
    const okBtn = options.okBtn || null;
    const cancelBtn = options.cancelBtn || null;
    const closeBtn = options.closeBtn || null;

    let resolver = null;
    let disposed = false;
    let openToken = 0;
    const listeners = [];

    function addListener(target, type, handler, options) {
        if (!target?.addEventListener || typeof handler !== 'function') return;
        target.addEventListener(type, handler, options);
        listeners.push({ target, type, handler, options });
    }

    function close(value = null) {
        openToken += 1;
        modalEl?.classList?.remove?.('show');
        const resolve = resolver;
        resolver = null;
        resolve?.(value);
    }

    function cancel() {
        close(null);
    }

    function confirm() {
        if (!formatEl || !coordsEl) return close(null);
        const format = String(formatEl.value || 'glb').trim().toLowerCase();
        const coords = String(coordsEl.value || 'rebased').trim().toLowerCase();
        if (format !== 'glb' && format !== 'gltf') return close(null);
        if (coords !== 'rebased' && coords !== 'msk') return close(null);
        close({ format, coords });
    }

    function open({ title = 'Экспорт', format = 'glb', coords = 'rebased' } = {}) {
        if (disposed || !modalEl || !formatEl || !coordsEl) return Promise.resolve(null);
        if (resolver) close(null);
        const token = ++openToken;

        if (titleEl) titleEl.textContent = String(title || 'Экспорт');
        formatEl.value = format === 'gltf' ? 'gltf' : 'glb';
        coordsEl.value = coords === 'msk' ? 'msk' : 'rebased';

        modalEl.classList.add('show');

        queueMicrotask(() => {
            if (disposed || token !== openToken || !modalEl.classList.contains('show')) return;
            try {
                formatEl.focus();
            } catch (_) {}
        });

        return new Promise((resolve) => {
            resolver = resolve;
        });
    }

    addListener(okBtn, 'click', confirm);
    addListener(cancelBtn, 'click', cancel);
    addListener(closeBtn, 'click', cancel);

    addListener(modalEl, 'click', (e) => {
        if (e.target === modalEl) cancel();
    });

    const onKey = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            confirm();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    };

    addListener(formatEl, 'keydown', onKey);
    addListener(coordsEl, 'keydown', onKey);
    addListener(modalEl, 'keydown', onKey);

    function dispose() {
        if (disposed) return;
        disposed = true;
        close(null);
        while (listeners.length) {
            const { target, type, handler, options } = listeners.pop();
            try { target.removeEventListener(type, handler, options); } catch (_) {}
        }
    }

    return Object.freeze({
        open,
        close,
        dispose,
    });
}
