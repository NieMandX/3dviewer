// Preserve the loader's actual FBX Model ID across worker JSON and UDIM splitting.
// Names and Blender polygon indices are not cross-loader identities.
export function tagFBXModelIds(root) {
    root.traverse(node => {
        if (node.isMesh && Number.isSafeInteger(node.ID) && node.ID > 0) {
            (node.userData ||= {}).sourceFBXModelId = String(node.ID);
        }
    });
}

export async function sourceFBXHash(buffer) {
    if (!globalThis.crypto?.subtle) return null;
    try {
        const hash = await crypto.subtle.digest('SHA-256', buffer);
        return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
    } catch { return null; } // Display remains available when source identity is unavailable.
}
