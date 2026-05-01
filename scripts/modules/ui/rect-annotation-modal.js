export function createRectAnnotationModalController(options = {}) {
    const modalEl = options.modalEl || null;
    const titleEl = options.titleEl || null;
    const closeBtn = options.closeBtn || null;
    const okBtn = options.okBtn || null;
    const cancelBtn = options.cancelBtn || null;
    const colorEl = options.colorEl || null;
    const fillRowEl = options.fillRowEl || null;
    const fillEl = options.fillEl || null;
    const infoRowEl = options.infoRowEl || null;
    const infoEl = options.infoEl || null;
    const areaEl = options.areaEl || null;
    const textEl = options.textEl || null;
    const textRowEl = options.textRowEl || null;

    let resolver = null;
    let currentArea = null;
    let disposed = false;
    let openToken = 0;
    const listeners = [];

    function addListener(target, type, handler, options) {
        if (!target?.addEventListener || typeof handler !== 'function') return;
        target.addEventListener(type, handler, options);
        listeners.push({ target, type, handler, options });
    }

    function isOpen() {
        return !disposed && !!modalEl?.classList?.contains?.('show');
    }

    function formatArea(area) {
        const value = Number(area);
        if (!Number.isFinite(value)) return '—';
        let fixed = value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
        fixed = fixed.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
        return fixed;
    }

    function syncInfoVisibility(forceMode = null) {
        if (!infoEl) return;
        const mode = forceMode || String(infoEl.value || 'none');
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
        openToken += 1;
        modalEl?.classList?.remove?.('show');
        const resolve = resolver;
        resolver = null;
        resolve?.(value);
    }

    function open({
        title = 'Прямоугольник',
        color = '#ffcc00',
        fill = 'hatch',
        info = 'area',
        area = null,
        text = '',
        mode = 'rect',
    } = {}) {
        if (disposed || !modalEl || !colorEl || !fillEl || !infoEl) return Promise.resolve(null);
        if (resolver) close(null);
        const token = ++openToken;

        if (titleEl) titleEl.textContent = title;
        colorEl.value = String(color || '#ffcc00');
        fillEl.value = String(fill || 'solid');
        infoEl.value = String(info || 'none');
        if (textEl) textEl.value = text != null ? String(text) : '';
        currentArea = area;

        const isPin = String(mode || '').toLowerCase() === 'pin';
        if (isPin) {
            if (fillRowEl) fillRowEl.hidden = true;
            if (infoRowEl) infoRowEl.hidden = true;
            fillEl.value = 'none';
            infoEl.value = 'text';
            syncInfoVisibility('text');
        } else {
            if (fillRowEl) fillRowEl.hidden = false;
            if (infoRowEl) infoRowEl.hidden = false;
            syncInfoVisibility();
        }
        modalEl.classList.add('show');

        queueMicrotask(() => {
            if (disposed || token !== openToken || !isOpen()) return;
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

    addListener(okBtn, 'click', confirm);
    addListener(cancelBtn, 'click', cancel);
    addListener(closeBtn, 'click', cancel);
    addListener(infoEl, 'change', syncInfoVisibility);

    addListener(modalEl, 'click', (e) => {
        if (e.target === modalEl) cancel();
    });

    addListener(modalEl, 'keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            confirm();
        }
    });

    function dispose() {
        if (disposed) return;
        disposed = true;
        close(null);
        while (listeners.length) {
            const { target, type, handler, options } = listeners.pop();
            try { target.removeEventListener(type, handler, options); } catch (_) {}
        }
        currentArea = null;
    }

    return Object.freeze({
        open,
        close,
        isOpen,
        dispose,
    });
}
