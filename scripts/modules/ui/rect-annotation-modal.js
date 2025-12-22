export function createRectAnnotationModalController(options = {}) {
    const modalEl = options.modalEl || null;
    const titleEl = options.titleEl || null;
    const closeBtn = options.closeBtn || null;
    const okBtn = options.okBtn || null;
    const cancelBtn = options.cancelBtn || null;
    const colorEl = options.colorEl || null;
    const fillEl = options.fillEl || null;
    const infoEl = options.infoEl || null;
    const areaEl = options.areaEl || null;
    const textEl = options.textEl || null;
    const textRowEl = options.textRowEl || null;

    let resolver = null;
    let currentArea = null;

    function isOpen() {
        return !!modalEl?.classList?.contains?.('show');
    }

    function formatArea(area) {
        const value = Number(area);
        if (!Number.isFinite(value)) return '—';
        let fixed = value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
        fixed = fixed.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
        return fixed;
    }

    function syncInfoVisibility() {
        if (!infoEl) return;
        const mode = String(infoEl.value || 'none');
        if (textRowEl) textRowEl.hidden = mode !== 'text';
        if (areaEl) {
            areaEl.hidden = mode !== 'area';
            if (mode === 'area') {
                const label = formatArea(currentArea);
                areaEl.textContent = `Площадь: ${label} м²`;
            }
        }
    }

    function close(value = null) {
        if (!modalEl) return;
        modalEl.classList.remove('show');
        const resolve = resolver;
        resolver = null;
        resolve?.(value);
    }

    function open({
        title = 'Прямоугольник',
        color = '#ffcc00',
        fill = 'solid',
        info = 'none',
        area = null,
        text = '',
    } = {}) {
        if (!modalEl || !colorEl || !fillEl || !infoEl) return Promise.resolve(null);
        if (resolver) close(null);

        if (titleEl) titleEl.textContent = title;
        colorEl.value = String(color || '#ffcc00');
        fillEl.value = String(fill || 'solid');
        infoEl.value = String(info || 'none');
        if (textEl) textEl.value = text != null ? String(text) : '';
        currentArea = area;

        syncInfoVisibility();
        modalEl.classList.add('show');

        queueMicrotask(() => {
            try {
                if (infoEl.value === 'text') {
                    textEl?.focus?.();
                } else {
                    colorEl?.focus?.();
                }
            } catch (_) {}
        });

        return new Promise((resolve) => {
            resolver = resolve;
        });
    }

    function confirm() {
        if (!colorEl || !fillEl || !infoEl) return close(null);
        const value = {
            color: String(colorEl.value || '#ffcc00'),
            fill: String(fillEl.value || 'solid'),
            info: String(infoEl.value || 'none'),
            text: textEl ? String(textEl.value || '') : '',
            area: currentArea,
        };
        close(value);
    }

    function cancel() {
        close(null);
    }

    okBtn?.addEventListener?.('click', confirm);
    cancelBtn?.addEventListener?.('click', cancel);
    closeBtn?.addEventListener?.('click', cancel);
    infoEl?.addEventListener?.('change', syncInfoVisibility);

    modalEl?.addEventListener?.('click', (e) => {
        if (e.target === modalEl) cancel();
    });

    modalEl?.addEventListener?.('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            confirm();
        }
    });

    return Object.freeze({
        open,
        close,
        isOpen,
    });
}
