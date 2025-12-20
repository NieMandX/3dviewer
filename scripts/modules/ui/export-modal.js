export function createExportModalController(options = {}) {
    const modalEl = options.modalEl || null;
    const titleEl = options.titleEl || null;
    const formatEl = options.formatEl || null;
    const coordsEl = options.coordsEl || null;
    const okBtn = options.okBtn || null;
    const cancelBtn = options.cancelBtn || null;
    const closeBtn = options.closeBtn || null;

    let resolver = null;

    function close(value = null) {
        if (!modalEl) return;
        modalEl.classList.remove('show');
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
        if (!modalEl || !formatEl || !coordsEl) return Promise.resolve(null);
        if (resolver) close(null);

        if (titleEl) titleEl.textContent = String(title || 'Экспорт');
        formatEl.value = format === 'gltf' ? 'gltf' : 'glb';
        coordsEl.value = coords === 'msk' ? 'msk' : 'rebased';

        modalEl.classList.add('show');

        queueMicrotask(() => {
            try {
                formatEl.focus();
            } catch (_) {}
        });

        return new Promise((resolve) => {
            resolver = resolve;
        });
    }

    okBtn?.addEventListener?.('click', confirm);
    cancelBtn?.addEventListener?.('click', cancel);
    closeBtn?.addEventListener?.('click', cancel);

    modalEl?.addEventListener?.('click', (e) => {
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

    formatEl?.addEventListener?.('keydown', onKey);
    coordsEl?.addEventListener?.('keydown', onKey);
    modalEl?.addEventListener?.('keydown', onKey);

    return Object.freeze({
        open,
        close,
    });
}

