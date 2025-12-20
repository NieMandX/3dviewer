export function createConfirmModalController(options = {}) {
    const modalEl = options.modalEl || null;
    const titleEl = options.titleEl || null;
    const messageEl = options.messageEl || null;
    const okBtn = options.okBtn || null;
    const cancelBtn = options.cancelBtn || null;
    const closeBtn = options.closeBtn || null;

    let resolver = null;

    function isOpen() {
        return !!modalEl?.classList?.contains?.('show');
    }

    function close(value = false) {
        if (!modalEl) return;
        modalEl.classList.remove('show');
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
        if (!modalEl || !messageEl || !okBtn || !cancelBtn) return Promise.resolve(false);
        if (resolver) close(false);

        if (titleEl) titleEl.textContent = String(title || '');
        messageEl.textContent = String(message || '');
        okBtn.textContent = String(okText || 'OK');
        cancelBtn.textContent = String(cancelText || 'Отмена');

        modalEl.classList.add('show');

        queueMicrotask(() => {
            try {
                okBtn.focus();
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

    modalEl?.addEventListener?.('keydown', (e) => {
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

