export function createRoomLoadAbortRegistry(options = {}) {
    const makeAbortError = typeof options.makeAbortError === 'function'
        ? options.makeAbortError
        : (message = 'Room model load superseded') => {
            try {
                return new DOMException(message, 'AbortError');
            } catch (_) {
                const err = new Error(message);
                err.name = 'AbortError';
                return err;
            }
        };

    const importControllers = new Set();
    const importRequestGenerations = new WeakMap();
    const syncControllers = new Set();

    function abortController(controller, reason) {
        if (!controller || controller.signal?.aborted) return false;
        try {
            controller.abort(reason);
            return true;
        } catch (_) {
            return false;
        }
    }

    function addImportController(controller, options = {}) {
        if (!controller) return false;
        importControllers.add(controller);
        const activeRequestGeneration = Number(options.activeRequestGeneration || 0);
        if (activeRequestGeneration > 0) {
            importRequestGenerations.set(controller, activeRequestGeneration);
        }
        return true;
    }

    function deleteImportController(controller) {
        if (!controller) return false;
        importRequestGenerations.delete(controller);
        return importControllers.delete(controller);
    }

    function addSyncController(controller) {
        if (!controller) return false;
        syncControllers.add(controller);
        return true;
    }

    function deleteSyncController(controller) {
        if (!controller) return false;
        return syncControllers.delete(controller);
    }

    function abortImportControllers(predicate = null, reason = makeAbortError()) {
        const shouldAbort = typeof predicate === 'function' ? predicate : () => true;
        let aborted = 0;
        Array.from(importControllers).forEach((controller) => {
            if (!shouldAbort(controller)) return;
            if (abortController(controller, reason)) aborted += 1;
            deleteImportController(controller);
        });
        return aborted;
    }

    function abortSyncControllers(reason = makeAbortError()) {
        let aborted = 0;
        Array.from(syncControllers).forEach((controller) => {
            if (abortController(controller, reason)) aborted += 1;
            syncControllers.delete(controller);
        });
        return aborted;
    }

    function abort(options = {}) {
        const reason = makeAbortError();
        return {
            imports: abortImportControllers(options.importPredicate || null, reason),
            syncs: options.includeSyncControllers === false ? 0 : abortSyncControllers(reason),
        };
    }

    function abortSupersededImports(activeRequestGeneration) {
        const expectedGeneration = Number(activeRequestGeneration || 0);
        return abortImportControllers((controller) => {
            const generation = Number(importRequestGenerations.get(controller) || 0);
            return generation > 0 && generation !== expectedGeneration;
        });
    }

    return Object.freeze({
        addImportController,
        deleteImportController,
        addSyncController,
        deleteSyncController,
        abortImportControllers,
        abortSyncControllers,
        abort,
        abortSupersededImports,
        getImportCount: () => importControllers.size,
        getSyncCount: () => syncControllers.size,
    });
}
