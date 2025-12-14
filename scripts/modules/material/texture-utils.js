export function copyTextureSettings(src, dst) {
    if (!src || !dst || src === dst) return;
    if (src.wrapS != null) dst.wrapS = src.wrapS;
    if (src.wrapT != null) dst.wrapT = src.wrapT;
    if ('wrapR' in src && 'wrapR' in dst && src.wrapR != null) dst.wrapR = src.wrapR;
    if (src.offset?.isVector2 && dst.offset?.copy) dst.offset.copy(src.offset);
    if (src.repeat?.isVector2 && dst.repeat?.copy) dst.repeat.copy(src.repeat);
    if (src.center?.isVector2 && dst.center?.copy) dst.center.copy(src.center);
    if (typeof src.rotation === 'number') dst.rotation = src.rotation;
    if (typeof src.matrixAutoUpdate === 'boolean') {
        dst.matrixAutoUpdate = src.matrixAutoUpdate;
        if (!dst.matrixAutoUpdate && src.matrix && dst.matrix?.copy) {
            dst.matrix.copy(src.matrix);
        }
    }
    if (typeof src.flipY === 'boolean') dst.flipY = src.flipY;
    if (typeof src.anisotropy === 'number') dst.anisotropy = src.anisotropy;
    if (typeof src.generateMipmaps === 'boolean') dst.generateMipmaps = src.generateMipmaps;
    if (dst.image && (dst.image.width || dst.image.height || dst.image.data)) {
        dst.needsUpdate = true;
    }
}

