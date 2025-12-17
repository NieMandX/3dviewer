export function createGridVisibilityController(options = {}) {
    const app = options.app || null;
    const grid = options.grid || null;
    const gridToggleBtn = options.gridToggleBtn || null;
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};

    let visible = typeof options.initialVisible === 'boolean' ? options.initialVisible : true;

    function applyButtonUI() {
        if (!gridToggleBtn) return;
        gridToggleBtn.classList.toggle('active', visible);
        gridToggleBtn.textContent = visible ? 'Grid off' : 'Grid on';
        gridToggleBtn.setAttribute('aria-pressed', visible ? 'true' : 'false');
    }

    function setVisible(nextVisible) {
        visible = !!nextVisible;

        if (grid) {
            grid.visible = visible;
        }

        if (app) {
            app.gridVisible = visible;
        }

        applyButtonUI();
        requestRender();
    }

    function isVisible() {
        return visible;
    }

    function toggle() {
        setVisible(!visible);
    }

    setVisible(visible);

    return Object.freeze({
        setVisible,
        isVisible,
        toggle,
    });
}

