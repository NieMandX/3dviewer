export function createBindLogController(options = {}) {
    const bindLogEl = options.bindLogEl || null;
    const placeholderText = options.placeholderText ?? '— пока пусто —';

    function logBind(message, level = 'info') {
        if (!bindLogEl) return;
        const prefix = level === 'warn' ? '⚠️ ' : level === 'ok' ? '✅ ' : '';
        if (bindLogEl.textContent.trim() === placeholderText) bindLogEl.textContent = '';
        bindLogEl.textContent += prefix + message + '\n';
    }

    function logSessionHeader(title) {
        if (!bindLogEl) return;
        const ts = new Date().toLocaleTimeString();
        if (bindLogEl.textContent.trim() !== placeholderText) bindLogEl.textContent += '\n';
        bindLogEl.textContent += `——— ${title} @ ${ts} ———\n`;
    }

    return {
        logBind,
        logSessionHeader,
    };
}

