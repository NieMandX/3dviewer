export function createTransitionModalController(options = {}) {
    const modalEl = options.modalEl || null;
    const titleEl = options.titleEl || null;
    const secondsEl = options.secondsEl || null;
    const typeEl = options.typeEl || null;
    const trajectoryEl = options.trajectoryEl || null;
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
        if (!secondsEl) return close(null);
        const seconds = Number.parseFloat(String(secondsEl.value || '0').replace(',', '.'));
        if (!Number.isFinite(seconds) || seconds < 0) return close(null);
        const type = String(typeEl?.value || 'ease-in-out') || 'ease-in-out';
        const trajectory = String(trajectoryEl?.value || 'linear') || 'linear';
        close({ seconds, type, trajectory });
    }

    function open({ title = 'Переход камеры', seconds = 0, type = 'ease-in-out', trajectory = 'linear' } = {}) {
        if (disposed || !modalEl || !secondsEl || !typeEl || !trajectoryEl) return Promise.resolve(null);
        if (resolver) close(null);
        const token = ++openToken;

        if (titleEl) titleEl.textContent = title;
        secondsEl.value = String(Number.isFinite(seconds) ? Math.max(0, seconds) : 0);
        typeEl.value = type || 'ease-in-out';
        trajectoryEl.value = trajectory || 'linear';

        modalEl.classList.add('show');

        queueMicrotask(() => {
            if (disposed || token !== openToken || !modalEl.classList.contains('show')) return;
            try {
                secondsEl.focus();
                secondsEl.select?.();
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
    addListener(secondsEl, 'keydown', onKey);
    addListener(typeEl, 'keydown', onKey);
    addListener(trajectoryEl, 'keydown', onKey);

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
