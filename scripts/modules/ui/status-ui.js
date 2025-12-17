export function createStatusUIController(options = {}) {
    const statusEl = options.statusEl || null;
    const appbarStatusEl = options.appbarStatusEl || statusEl;
    const emptyHintEl = options.emptyHintEl || null;

    const readyPrefix = String(options.readyPrefix ?? 'готово').trim().toLowerCase();
    const readyClearDelayMs = Number.isFinite(options.readyClearDelayMs) ? options.readyClearDelayMs : 2000;

    let statusClearTimer = null;

    function clearTimer() {
        if (!statusClearTimer) return;
        clearTimeout(statusClearTimer);
        statusClearTimer = null;
    }

    function setStatusMessage(message = '') {
        if (!statusEl) return;

        clearTimer();

        const text = String(message ?? '');
        const trimmed = text.trim();
        const hasMessage = !!trimmed;

        statusEl.textContent = hasMessage ? text : '';
        statusEl.hidden = !hasMessage;
        if (appbarStatusEl && appbarStatusEl !== statusEl) {
            appbarStatusEl.textContent = statusEl.textContent;
        }

        if (hasMessage && readyPrefix) {
            const norm = trimmed.toLowerCase();
            if (norm.startsWith(readyPrefix)) {
                statusClearTimer = setTimeout(() => {
                    statusClearTimer = null;
                    setStatusMessage('');
                }, readyClearDelayMs);
            }
        }
    }

    function setEmptyHintVisible(visible) {
        if (!emptyHintEl) return;
        emptyHintEl.hidden = !visible;
        emptyHintEl.style.opacity = visible ? '1' : '0';
    }

    function dispose() {
        clearTimer();
    }

    return {
        setStatusMessage,
        setEmptyHintVisible,
        dispose,
    };
}

