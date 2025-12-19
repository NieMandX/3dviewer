export function createTransitionModalController(options = {}) {
    const modalEl = options.modalEl || null;
    const titleEl = options.titleEl || null;
    const secondsEl = options.secondsEl || null;
    const typeEl = options.typeEl || null;
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
        if (!secondsEl) return close(null);
        const seconds = Number.parseFloat(String(secondsEl.value || '0').replace(',', '.'));
        if (!Number.isFinite(seconds) || seconds < 0) return close(null);
        const type = String(typeEl?.value || 'soft') || 'soft';
        close({ seconds, type });
    }

    function open({ title = 'Переход камеры', seconds = 0, type = 'soft' } = {}) {
        if (!modalEl || !secondsEl || !typeEl) return Promise.resolve(null);
        if (resolver) close(null);

        if (titleEl) titleEl.textContent = title;
        secondsEl.value = String(Number.isFinite(seconds) ? Math.max(0, seconds) : 0);
        typeEl.value = type || 'soft';

        modalEl.classList.add('show');

        queueMicrotask(() => {
            try {
                secondsEl.focus();
                secondsEl.select?.();
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
    secondsEl?.addEventListener?.('keydown', onKey);
    typeEl?.addEventListener?.('keydown', onKey);

    return Object.freeze({
        open,
        close,
    });
}
