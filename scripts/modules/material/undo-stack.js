function addObjectTree(root, targetSet) {
    if (!root || targetSet.has(root)) return;
    targetSet.add(root);
    if (typeof root.traverse === 'function') {
        root.traverse((node) => {
            if (node) targetSet.add(node);
        });
    }
}

export function pruneMaterialUndoStackForRoots(undoStack, roots = []) {
    if (!Array.isArray(undoStack) || !undoStack.length) return 0;

    const removedObjects = new Set();
    (Array.isArray(roots) ? roots : [roots]).forEach((root) => addObjectTree(root, removedObjects));
    if (!removedObjects.size) return 0;

    let removedBindings = 0;
    for (let i = undoStack.length - 1; i >= 0; i -= 1) {
        const entry = undoStack[i];
        const bindings = Array.isArray(entry?.bindings) ? entry.bindings : [];
        if (!bindings.length) continue;

        const keptBindings = bindings.filter((binding) => !removedObjects.has(binding?.obj));
        removedBindings += bindings.length - keptBindings.length;

        if (!keptBindings.length) {
            undoStack.splice(i, 1);
        } else if (keptBindings.length !== bindings.length) {
            entry.bindings = keptBindings;
        }
    }

    return removedBindings;
}
