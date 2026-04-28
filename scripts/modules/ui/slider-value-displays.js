export function createSliderValueDisplayController(options = {}) {
    const root = options.root || (typeof document !== 'undefined' ? document : null);
    const entries = new Map();
    const listeners = [];

    function addListener(target, type, handler, options) {
        if (!target?.addEventListener || typeof handler !== 'function') return;
        target.addEventListener(type, handler, options);
        listeners.push({ target, type, handler, options });
    }

    function sliderStepDecimals(input) {
        if (!input) return 2;
        const stepAttr = input.getAttribute?.('step');
        if (!stepAttr || stepAttr === 'any') return 2;
        if (stepAttr.includes('.')) {
            const decimals = stepAttr.split('.')[1]?.length || 0;
            return Math.min(Math.max(decimals, 0), 4);
        }
        return 0;
    }

    function clampValueToSlider(slider, value) {
        let next = value;
        const minAttr = slider.getAttribute('min');
        const maxAttr = slider.getAttribute('max');
        const min = minAttr !== null && minAttr !== '' ? parseFloat(minAttr) : null;
        const max = maxAttr !== null && maxAttr !== '' ? parseFloat(maxAttr) : null;
        if (Number.isFinite(min)) next = Math.max(next, min);
        if (Number.isFinite(max)) next = Math.min(next, max);
        return next;
    }

    function snapValueToStep(slider, value) {
        const stepAttr = slider.getAttribute('step');
        if (!stepAttr || stepAttr === 'any') return value;
        const step = parseFloat(stepAttr);
        if (!Number.isFinite(step) || step <= 0) return value;
        const minAttr = slider.getAttribute('min');
        const origin = minAttr !== null && minAttr !== '' ? parseFloat(minAttr) : 0;
        const steps = Math.round((value - origin) / step);
        return origin + steps * step;
    }

    function applyEntry(entry) {
        if (!entry) return;
        const { slider, display } = entry;
        if (!slider || !display) return;
        const numeric = parseFloat(slider.value);
        if (!Number.isFinite(numeric)) {
            display.value = slider.value || '';
            return;
        }
        display.value = numeric.toFixed(sliderStepDecimals(slider));
    }

    function update(id) {
        applyEntry(entries.get(id));
    }

    function updateAll() {
        entries.forEach(applyEntry);
    }

    function register(id, slider) {
        if (!id || !slider || !root) return;
        const display = root.querySelector?.(`[data-light-value-for="${id}"]`);
        if (!display || !(display instanceof HTMLInputElement)) return;
        entries.set(id, { slider, display });
        addListener(slider, 'input', () => update(id));
    }

    function commitInput(id) {
        const entry = entries.get(id);
        if (!entry) return;
        const { slider, display } = entry;
        if (!slider || !(display instanceof HTMLInputElement)) return;

        const raw = (display.value || '').replace(',', '.').trim();
        const parsed = parseFloat(raw);
        if (!Number.isFinite(parsed)) {
            update(id);
            return;
        }

        let next = clampValueToSlider(slider, parsed);
        next = snapValueToStep(slider, next);
        next = clampValueToSlider(slider, next);

        const decimals = sliderStepDecimals(slider);
        const formatted = Number.isFinite(decimals) ? next.toFixed(decimals) : String(next);

        slider.value = formatted;
        display.value = formatted;
        update(id);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function attachInputs() {
        entries.forEach(({ display }, id) => {
            if (!(display instanceof HTMLInputElement)) return;
            const commit = () => commitInput(id);
            addListener(display, 'change', commit);
            addListener(display, 'blur', commit);
            addListener(display, 'keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commit();
                    display.blur();
                } else if (event.key === 'Escape') {
                    update(id);
                    display.blur();
                }
            });
        });
    }

    function dispose() {
        while (listeners.length) {
            const { target, type, handler, options } = listeners.pop();
            try { target.removeEventListener(type, handler, options); } catch (_) {}
        }
        entries.clear();
    }

    return {
        register,
        update,
        updateAll,
        attachInputs,
        dispose,
    };
}
