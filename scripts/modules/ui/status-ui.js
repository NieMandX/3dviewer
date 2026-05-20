export function createStatusUIController(options = {}) {
    const statusEl = options.statusEl || null;
    const appbarStatusEl = options.appbarStatusEl || statusEl;
    const emptyHintEl = options.emptyHintEl || null;

    const readyPrefix = String(options.readyPrefix ?? 'готово').trim().toLowerCase();
    const readyClearDelayMs = Number.isFinite(options.readyClearDelayMs) ? options.readyClearDelayMs : 2000;

    let statusClearTimer = null;
    let statusTextEl = null;
    let progressTrackEl = null;
    let progressBarEl = null;
    let disposed = false;

    function clearTimer() {
        if (!statusClearTimer) return;
        clearTimeout(statusClearTimer);
        statusClearTimer = null;
    }

    function ensureStatusTextEl() {
        if (!statusEl) return null;
        if (statusTextEl && statusEl.contains(statusTextEl)) return statusTextEl;
        const existingText = statusEl.textContent || '';
        statusEl.textContent = '';
        statusTextEl = document.createElement('span');
        statusTextEl.className = 'status-overlay-text';
        statusEl.appendChild(statusTextEl);
        if (progressTrackEl) statusEl.appendChild(progressTrackEl);
        if (existingText && existingText !== '—') statusTextEl.textContent = existingText;
        return statusTextEl;
    }

    function ensureProgressEls() {
        if (!statusEl) return null;
        ensureStatusTextEl();
        if (progressTrackEl && progressBarEl && statusEl.contains(progressTrackEl)) return progressTrackEl;
        progressTrackEl = document.createElement('div');
        progressTrackEl.className = 'status-progress-track';
        progressTrackEl.hidden = true;
        progressTrackEl.setAttribute('role', 'progressbar');
        progressTrackEl.setAttribute('aria-label', 'Загрузка модели');
        progressBarEl = document.createElement('div');
        progressBarEl.className = 'status-progress-bar';
        progressTrackEl.appendChild(progressBarEl);
        statusEl.appendChild(progressTrackEl);
        return progressTrackEl;
    }

    function setStatusProgress(options = {}) {
        if (disposed) return false;
        if (!statusEl) return false;
        const config = typeof options === 'boolean' ? { visible: options } : (options || {});
        const visible = !!config.visible;
        const track = ensureProgressEls();
        if (!track || !progressBarEl) return false;

        statusEl.classList.toggle('has-progress', visible);
        track.hidden = !visible;
        if (!visible) {
            track.classList.remove('is-indeterminate');
            progressBarEl.style.width = '0%';
            track.removeAttribute('aria-valuenow');
            return true;
        }

        const rawValue = Number(config.value);
        const hasValue = Number.isFinite(rawValue);
        const indeterminate = config.indeterminate !== false && !hasValue;
        track.classList.toggle('is-indeterminate', indeterminate);
        if (indeterminate) {
            progressBarEl.style.width = '';
            track.removeAttribute('aria-valuenow');
        } else {
            const next = Math.max(0, Math.min(100, rawValue));
            progressBarEl.style.width = `${next}%`;
            track.setAttribute('aria-valuenow', String(Math.round(next)));
        }
        return true;
    }

    function setStatusMessage(message = '') {
        if (disposed) return;
        if (!statusEl) return;

        clearTimer();

        const text = String(message ?? '');
        const trimmed = text.trim();
        const hasMessage = !!trimmed;

        const textEl = ensureStatusTextEl();
        if (textEl) textEl.textContent = hasMessage ? text : '';
        statusEl.hidden = !hasMessage;
        if (!hasMessage) setStatusProgress(false);
        if (appbarStatusEl && appbarStatusEl !== statusEl) {
            appbarStatusEl.textContent = hasMessage ? text : '';
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
        if (disposed) return;
        if (!emptyHintEl) return;
        emptyHintEl.hidden = !visible;
        emptyHintEl.style.opacity = visible ? '1' : '0';
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        clearTimer();
        if (statusEl) {
            statusEl.hidden = true;
            statusEl.classList.remove('has-progress');
        }
        if (statusTextEl) statusTextEl.textContent = '';
        if (progressTrackEl) {
            progressTrackEl.hidden = true;
            progressTrackEl.classList.remove('is-indeterminate');
            progressTrackEl.removeAttribute('aria-valuenow');
        }
        if (progressBarEl) progressBarEl.style.width = '0%';
        if (appbarStatusEl && appbarStatusEl !== statusEl) {
            appbarStatusEl.textContent = '';
        }
        if (emptyHintEl) {
            emptyHintEl.hidden = true;
            emptyHintEl.style.opacity = '0';
        }
    }

    return {
        setStatusMessage,
        setStatusProgress,
        setEmptyHintVisible,
        dispose,
    };
}
