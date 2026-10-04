// UI entitlement is separate from room material playback and server/RLS access.
export function createMaterialAccess({ getContext, loadedModels }) {
    function belongsToRoom(value) {
        const context = getContext();
        const scope = value?.scope || value?.obj?.userData?.importScope;
        return !!(context.roomId && !context.suspended && scope?.kind === 'room'
            && scope.roomId === context.roomId && scope.modelId);
    }
    function canUse(value) {
        const context = getContext();
        return !!(context.authenticated && context.registered && belongsToRoom(value));
    }
    return {
        // Guests still need these models to apply saved room settings.
        getModels: () => loadedModels.filter(belongsToRoom),
        canUseModel: canUse,
        canUseTexture: (entry) => canUse(entry) && loadedModels.some((model) => (
            canUse(model) && model.scope?.modelId === entry.scope?.modelId
        )),
        canUseObject: (object) => loadedModels.some((model) => {
            if (!canUse(model)) return false;
            for (let node = object; node; node = node.parent) if (node === model.obj) return true;
            return false;
        }),
    };
}
