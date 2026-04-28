export function createPromptModalController(options = {}) {
    const modalEl = options.modalEl || null;
    const titleEl = options.titleEl || null;
    const inputEl = options.inputEl || null;
    const okBtn = options.okBtn || null;
    const cancelBtn = options.cancelBtn || null;
    const closeBtn = options.closeBtn || null;

    let resolver = null;
    const listeners = [];

    function addListener(target, type, handler, options) {
        if (!target?.addEventListener || typeof handler !== 'function') return;
        target.addEventListener(type, handler, options);
        listeners.push({ target, type, handler, options });
    }

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

    function open({ title = 'Имя камеры', value = '', placeholder = '', type = 'text', step = null, min = null, max = null } = {}) {
        if (!modalEl || !inputEl) return Promise.resolve(null);
        if (resolver) close(null);

        if (titleEl) titleEl.textContent = title;
        try {
            inputEl.type = type || 'text';
        } catch (_) {
            inputEl.type = 'text';
        }
        inputEl.value = value != null ? String(value) : '';
        if (placeholder != null) inputEl.placeholder = String(placeholder);
        if (step != null) inputEl.step = String(step);
        else inputEl.removeAttribute('step');
        if (min != null) inputEl.min = String(min);
        else inputEl.removeAttribute('min');
        if (max != null) inputEl.max = String(max);
        else inputEl.removeAttribute('max');

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

    addListener(okBtn, 'click', confirm);
    addListener(cancelBtn, 'click', cancel);
    addListener(closeBtn, 'click', cancel);

    addListener(modalEl, 'click', (e) => {
        if (e.target === modalEl) cancel();
    });

    addListener(inputEl, 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            confirm();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    });

    function dispose() {
        close(null);
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
