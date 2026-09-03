export function bindMapUnderlayUI({ controller, toggle, key, opacity, value, status, progress, attribution }) {
    const listeners = [];
    function listen(element, event, callback) {
        element.addEventListener(event, callback);
        listeners.push(() => element.removeEventListener(event, callback));
    }
    function update(state) {
        toggle.checked = state.enabled;
        key.disabled = state.enabled;
        status.textContent = state.loading && state.total
            ? `Загрузка карты: ${state.loaded} / ${state.total}` : state.message;
        progress.hidden = !state.loading;
        if (state.total) { progress.max = state.total; progress.value = state.loaded; }
        else progress.removeAttribute('value');
        attribution.hidden = !state.enabled || state.loading;
    }
    listen(toggle, 'change', () => {
        if (toggle.checked) {
            void controller.enable(key.value);
            if (!key.value.trim()) key.focus();
        } else controller.disable();
    });
    listen(opacity, 'input', () => {
        value.textContent = `${opacity.value}%`;
        controller.setOpacity(Number(opacity.value) / 100);
    });
    update(controller.getState());
    return { update, dispose() {
        listeners.forEach((remove) => remove());
        key.value = '';
        attribution.hidden = true;
    } };
}
