export function createPasswordResetModalController(options = {}) {
    const modalEl = options.modalEl || null;
    const titleEl = options.titleEl || null;
    const messageEl = options.messageEl || null;
    const passwordEl = options.passwordEl || null;
    const repeatEl = options.repeatEl || null;
    const okBtn = options.okBtn || null;
    const cancelBtn = options.cancelBtn || null;
    const closeBtn = options.closeBtn || null;

    let resolver = null;
    let baseMessage = '';

    function isOpen() {
        return !!modalEl?.classList?.contains?.('show');
    }

    function setMessage(text) {
        if (messageEl) messageEl.textContent = String(text || '');
    }

    function resetFields() {
        if (passwordEl) passwordEl.value = '';
        if (repeatEl) repeatEl.value = '';
    }

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
        const password = String(passwordEl?.value || '');
        const repeat = String(repeatEl?.value || '');
        if (!password || password.length < 6) {
            setMessage('Пароль должен быть не короче 6 символов.');
            passwordEl?.focus?.();
            return;
        }
        if (password !== repeat) {
            setMessage('Пароли не совпадают.');
            repeatEl?.focus?.();
            return;
        }
        close(password);
    }

    function open({
        title = 'Сброс пароля',
        message = 'Введите новый пароль.',
        okText = 'Сохранить',
        cancelText = 'Отмена',
    } = {}) {
        if (!modalEl || !passwordEl || !repeatEl || !okBtn || !cancelBtn) {
            return Promise.resolve(null);
        }
        if (resolver) close(null);

        if (titleEl) titleEl.textContent = String(title || '');
        baseMessage = String(message || '');
        setMessage(baseMessage);
        okBtn.textContent = String(okText || 'Сохранить');
        cancelBtn.textContent = String(cancelText || 'Отмена');

        resetFields();
        modalEl.classList.add('show');

        queueMicrotask(() => {
            try {
                passwordEl.focus();
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
        setMessage,
    });
}
