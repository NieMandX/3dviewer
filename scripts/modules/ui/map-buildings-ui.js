export function bindMapBuildingsUI({ controller, toggle, key, status, progress, attribution, updateShared = () => {} }) {
    function update(state) {
        toggle.checked = state.enabled;
        status.textContent = state.message;
        progress.hidden = !state.loading;
        attribution.hidden = !state.enabled || state.loading;
        updateShared();
    }
    function change() {
        if (toggle.checked) {
            void controller.enable(key.value);
            if (!key.value.trim()) key.focus();
        } else controller.disable();
    }
    toggle.addEventListener('change', change);
    update(controller.getState());
    return { update, dispose() { toggle.removeEventListener('change', change); attribution.hidden = true; } };
}
