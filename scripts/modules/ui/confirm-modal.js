export function createConfirmModalController(options = {}) {
    const modalEl = options.modalEl || null;
    const titleEl = options.titleEl || null;
    const messageEl = options.messageEl || null;
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

    function isOpen() {
        return !disposed && !!modalEl?.classList?.contains?.('show');
    }

    function close(value = false) {
        openToken += 1;
        modalEl?.classList?.remove?.('show');
        const resolve = resolver;
        resolver = null;
        resolve?.(!!value);
    }

    function cancel() {
        close(false);
    }

    function confirm() {
        close(true);
    }

    function open({
        title = 'Подтверждение',
        message = 'Вы уверены?',
        okText = 'OK',
        cancelText = 'Отмена',
    } = {}) {
        if (disposed || !modalEl || !messageEl || !okBtn || !cancelBtn) return Promise.resolve(false);
        if (resolver) close(false);
        const token = ++openToken;

        if (titleEl) titleEl.textContent = String(title || '');
        messageEl.textContent = String(message || '');
        okBtn.textContent = String(okText || 'OK');
        cancelBtn.textContent = String(cancelText || 'Отмена');

        modalEl.classList.add('show');

        queueMicrotask(() => {
            if (disposed || token !== openToken || !isOpen()) return;
            try {
                okBtn.focus();
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

    addListener(modalEl, 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            confirm();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    });

    function dispose() {
        if (disposed) return;
        disposed = true;
        close(false);
        while (listeners.length) {
            const { target, type, handler, options } = listeners.pop();
            try { target.removeEventListener(type, handler, options); } catch (_) {}
        }
    }

    return Object.freeze({
        open,
        close,
        isOpen,
        dispose,
    });
}
