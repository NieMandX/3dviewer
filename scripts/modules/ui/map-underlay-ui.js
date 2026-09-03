export function bindMapUnderlayUI({ controller, toggle, opacity, value, status, progress, attribution,
    additionalVisible = () => false }) {
    const listeners = [];
    function listen(element, event, callback) {
        element.addEventListener(event, callback);
        listeners.push(() => element.removeEventListener(event, callback));
    }
    function update(state) {
        toggle.checked = state.enabled;
        status.textContent = state.loading && state.total
            ? `Загрузка карты: ${state.loaded} / ${state.total}` : state.message;
        progress.hidden = !state.loading;
        if (state.total) { progress.max = state.total; progress.value = state.loaded; }
        else progress.removeAttribute('value');
        attribution.hidden = !(state.enabled && !state.loading) && !additionalVisible();
    }
    listen(toggle, 'change', () => {
        if (toggle.checked) {
            void controller.enable();
        } else controller.disable();
    });
    listen(opacity, 'input', () => {
        value.textContent = `${opacity.value}%`;
        controller.setOpacity(Number(opacity.value) / 100);
    });
    update(controller.getState());
    return { update, dispose() {
        listeners.forEach((remove) => remove());
        attribution.hidden = true;
    } };
}
