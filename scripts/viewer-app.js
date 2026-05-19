try {
    globalThis.__LPMVIEW_BOOT_MARK_ENTRY?.();
} catch (_) {}

let viewerApp = null;

try {
    const module = await import('./modules/app/viewer-app-main.js');
    viewerApp = module.default;
} catch (err) {
    try {
        globalThis.__LPMVIEW_BOOT_MARK_FAILED?.(err);
    } catch (_) {}
    throw err;
}

export default viewerApp;
