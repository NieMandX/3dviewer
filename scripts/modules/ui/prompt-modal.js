export function createPromptModalController(options = {}) {
    const modalEl = options.modalEl || null;
    const titleEl = options.titleEl || null;
    const inputEl = options.inputEl || null;
    const okBtn = options.okBtn || null;
    const cancelBtn = options.cancelBtn || null;
    const closeBtn = options.closeBtn || null;

    let resolver = null;

    function isOpen() {
        return !!modalEl?.classList?.contains?.('show');
    }

    function close(value = null) {
        if (!modalEl) return;
        modalEl.classList.remove('show');
        const resolve = resolver;
        resolver = null;
        resolve?.(value);
    }

    function open({ title = 'Имя камеры', value = '', placeholder = '' } = {}) {
        if (!modalEl || !inputEl) return Promise.resolve(null);
        if (resolver) close(null);

        if (titleEl) titleEl.textContent = title;
        inputEl.value = value != null ? String(value) : '';
        if (placeholder != null) inputEl.placeholder = String(placeholder);

        modalEl.classList.add('show');

        queueMicrotask(() => {
            try {
                inputEl.focus();
                inputEl.select?.();
            } catch (_) {}
        });

        return new Promise((resolve) => {
            resolver = resolve;
        });
    }

    function confirm() {
        if (!inputEl) return close(null);
        close(String(inputEl.value || ''));
    }

    function cancel() {
        close(null);
    }

    okBtn?.addEventListener?.('click', confirm);
    cancelBtn?.addEventListener?.('click', cancel);
    closeBtn?.addEventListener?.('click', cancel);

    modalEl?.addEventListener?.('click', (e) => {
        if (e.target === modalEl) cancel();
    });

    inputEl?.addEventListener?.('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            confirm();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    });

    return Object.freeze({
        open,
        close,
        isOpen,
    });
}

