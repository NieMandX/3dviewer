export function isRoomModelIdLinked(roomModelIds, modelId) {
    const id = String(modelId || '').trim();
    if (!id || !roomModelIds?.has) return false;
    try {
        return roomModelIds.has(id);
    } catch (_) {
        return false;
    }
}

export function createRoomModelLinkTracker() {
    const linkedIds = new Set();
    const deletedIds = new Set();

    function normalizeId(modelId) {
        return String(modelId || '').trim();
    }

    function remember(modelId, options = {}) {
        const id = normalizeId(modelId);
        if (!id) return false;
        if (options.clearTombstone === true) {
            deletedIds.delete(id);
        } else if (deletedIds.has(id)) {
            return false;
        }
        const existed = linkedIds.has(id);
        linkedIds.add(id);
        return !existed;
    }

    function forget(modelId, options = {}) {
        const id = normalizeId(modelId);
        if (!id) return false;
        if (options.tombstone === true) {
            deletedIds.add(id);
        }
        return linkedIds.delete(id);
    }

    function replace(modelIds = []) {
        linkedIds.clear();
        const nextIds = new Set();
        modelIds.forEach((modelId) => {
            const id = normalizeId(modelId);
            if (!id) return;
            linkedIds.add(id);
            nextIds.add(id);
        });
        nextIds.forEach((id) => deletedIds.delete(id));
        return linkedIds.size;
    }

    function clear() {
        linkedIds.clear();
        deletedIds.clear();
    }

    function has(modelId) {
        const id = normalizeId(modelId);
        return !!id && !deletedIds.has(id) && linkedIds.has(id);
    }

    return Object.freeze({
        remember,
        forget,
        replace,
        clear,
        has,
        size: () => linkedIds.size,
        values: () => Array.from(linkedIds),
        isTombstoned: (modelId) => deletedIds.has(normalizeId(modelId)),
    });
}

export function pruneLoadedRoomModelIds(options = {}) {
    const loadedRoomModelIds = options.loadedRoomModelIds || null;
    const records = Array.isArray(options.records) ? options.records : [];
    const explicitModelId = String(options.modelId || '').trim();
    const currentActiveModelId = String(options.activeRoomModelId || '').trim();
    const removedIds = new Set();

    if (explicitModelId) removedIds.add(explicitModelId);
    records.forEach((record) => {
        const scopedModelId = String(record?.scope?.modelId || record?.obj?.userData?.importScope?.modelId || '').trim();
        if (scopedModelId) removedIds.add(scopedModelId);
    });

    removedIds.forEach((modelId) => {
        try {
            loadedRoomModelIds?.delete?.(modelId);
        } catch (_) {}
    });

    return {
        removedIds: Array.from(removedIds),
        activeRoomModelId: removedIds.has(currentActiveModelId) ? '' : currentActiveModelId,
    };
}

export function promoteLocalImportScopeToRoom(options = {}) {
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];
    const allEmbedded = Array.isArray(options.allEmbedded) ? options.allEmbedded : [];
    const fileKey = String(options.fileKey || '').trim();
    const roomId = String(options.roomId || '').trim();
    const modelId = String(options.modelId || '').trim();
    if (!fileKey || !roomId || !modelId) {
        return { modelCount: 0, embeddedCount: 0 };
    }

    const nextScope = {
        kind: 'room',
        roomId,
        modelId,
    };
    let modelCount = 0;
    let embeddedCount = 0;

    loadedModels.forEach((record) => {
        const scope = record?.scope || null;
        if (scope?.kind !== 'local' || String(scope.fileKey || '') !== fileKey) return;
        record.scope = { ...nextScope };
        if (record.obj?.userData) {
            record.obj.userData.importScope = { ...nextScope };
        }
        modelCount += 1;
    });

    allEmbedded.forEach((entry) => {
        const scope = entry?.scope || null;
        if (scope?.kind !== 'local' || String(scope.fileKey || '') !== fileKey) return;
        entry.scope = { ...nextScope };
        embeddedCount += 1;
    });

    return { modelCount, embeddedCount };
}
