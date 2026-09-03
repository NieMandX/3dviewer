export function bindMapBuildingsUI({ controller, toggle, status, progress, gisAttribution, osmAttribution }) {
    function update(state) {
        toggle.checked = state.enabled;
        status.textContent = state.message;
        progress.hidden = !state.loading;
        const hidden = !state.enabled || state.loading;
        gisAttribution.hidden = hidden;
        osmAttribution.hidden = hidden;
    }
    function change() {
        if (toggle.checked) {
            void controller.enable();
        } else controller.disable();
    }
    toggle.addEventListener('change', change);
    update(controller.getState());
    return { update, dispose() {
        toggle.removeEventListener('change', change);
        gisAttribution.hidden = true;
        osmAttribution.hidden = true;
    } };
}
