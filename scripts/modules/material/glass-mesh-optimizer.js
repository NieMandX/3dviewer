export function createGlassMeshOptimizer(options = {}) {
    const THREE = options.THREE || null;
    const logBind = typeof options.logBind === 'function' ? options.logBind : null;

    const findGeomSuffix = typeof options.findGeomSuffix === 'function' ? options.findGeomSuffix : () => '';
    const isGlassByName = typeof options.isGlassByName === 'function' ? options.isGlassByName : () => false;
    const isGlassGeomSuffix = typeof options.isGlassGeomSuffix === 'function' ? options.isGlassGeomSuffix : () => false;

    return function optimizeGlassMeshes(root) {
        if (!root || !THREE) return;

        const isGlassMesh = (mesh) => {
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            if (mats.length < 2) return false;
            const nameStr = `${mesh.name || ''} ${mats.map(m => m?.name || '').join(' ')}`;
            const geomSuffix = findGeomSuffix(nameStr);
            return isGlassByName(nameStr) || isGlassGeomSuffix(geomSuffix);
        };

        const rebuildGeometryByMaterial = (geometry) => {
            if (!geometry || !geometry.attributes?.position) return null;
            if (!geometry.groups || geometry.groups.length === 0) return null;
            if (Object.keys(geometry.morphAttributes || {}).length) return null; // не трогаем morph target'ы

            const makeSource = () => {
                if (geometry.index) return geometry.toNonIndexed();
                const clone = geometry.clone();
                return clone;
            };

            const source = makeSource();
            const groups = source.groups || [];
            if (!groups.length) {
                if (source !== geometry) source.dispose?.();
                return null;
            }

            const attrEntries = Object.entries(source.attributes);
            if (!attrEntries.length) {
                if (source !== geometry) source.dispose?.();
                return null;
            }

            // Не поддерживаем interleaved атрибуты
            if (attrEntries.some(([, attr]) => attr?.isInterleavedBufferAttribute)) {
                if (source !== geometry) source.dispose?.();
                return null;
            }

            const matOrder = [];
            const perMaterial = new Map(); // matIndex -> { attrBuffers: { name: [] }, vertexCount }

            const ensureMatData = (matIndex) => {
                let data = perMaterial.get(matIndex);
                if (!data) {
                    data = { attrBuffers: {}, vertexCount: 0 };
                    perMaterial.set(matIndex, data);
                    matOrder.push(matIndex);
                }
                return data;
            };

            const positionAttr = source.attributes.position;
            const vertexCount = positionAttr?.count ?? 0;

            for (const group of groups) {
                const matIndex = group?.materialIndex ?? 0;
                const start = Math.max(0, group?.start ?? 0);
                const count = Math.max(0, group?.count ?? 0);
                if (count === 0) continue;
                const end = Math.min(vertexCount, start + count);
                if (end <= start) continue;

                const matData = ensureMatData(matIndex);

                for (let i = start; i < end; i++) {
                    for (const [name, attr] of attrEntries) {
                        const itemSize = attr.itemSize || 1;
                        const srcArray = attr.array;
                        const base = i * itemSize;
                        const dest = matData.attrBuffers[name] || (matData.attrBuffers[name] = []);
                        for (let k = 0; k < itemSize; k++) {
                            dest.push(srcArray[base + k]);
                        }
                    }
                    matData.vertexCount += 1;
                }
            }

            if (source !== geometry) source.dispose?.();

            if (!matOrder.length) return null;

            const newGeom = new THREE.BufferGeometry();
            newGeom.name = geometry.name || '';
            newGeom.userData = { ...(geometry.userData || {}) };

            for (const [name, attr] of attrEntries) {
                const ctor = attr.array.constructor;
                const itemSize = attr.itemSize || 1;
                const normalized = attr.normalized || false;

                const totalLength = matOrder.reduce((sum, idx) => {
                    const data = perMaterial.get(idx);
                    return sum + (data?.attrBuffers[name]?.length ?? 0);
                }, 0);

                if (totalLength === 0) continue;

                const typed = new ctor(totalLength);
                let offset = 0;
                for (const idx of matOrder) {
                    const data = perMaterial.get(idx);
                    const chunk = data?.attrBuffers[name];
                    if (!chunk || !chunk.length) continue;
                    typed.set(chunk, offset);
                    offset += chunk.length;
                }

                const bufferAttr = new THREE.BufferAttribute(typed, itemSize, normalized);
                bufferAttr.name = attr.name;
                if (attr.usage) bufferAttr.setUsage(attr.usage);
                newGeom.setAttribute(name, bufferAttr);
            }

            newGeom.clearGroups();
            let cursor = 0;
            for (const idx of matOrder) {
                const data = perMaterial.get(idx);
                const count = data?.vertexCount || 0;
                if (!count) continue;
                newGeom.addGroup(cursor, count, idx);
                cursor += count;
            }

            if (geometry.boundingBox) newGeom.boundingBox = geometry.boundingBox.clone();
            else newGeom.computeBoundingBox();

            if (geometry.boundingSphere) newGeom.boundingSphere = geometry.boundingSphere.clone();
            else newGeom.computeBoundingSphere();

            return newGeom;
        };

        let optimized = 0;
        root.traverse(mesh => {
            if (!mesh?.isMesh || mesh.userData?.isCollision) return;
            if (!mesh.geometry || !mesh.material) return;
            if (!isGlassMesh(mesh)) return;

            const matArray = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            if (matArray.length < 2) return;
            const geom = mesh.geometry;
            const groups = geom.groups || [];
            if (groups.length <= matArray.length) return;

            const rebuilt = rebuildGeometryByMaterial(geom);
            if (!rebuilt) return;

            mesh.geometry.dispose?.();
            mesh.geometry = rebuilt;
            if (rebuilt.attributes?.position) {
                rebuilt.attributes.position.needsUpdate = true;
            }
            optimized += 1;
        });

        if (optimized && logBind) {
            logBind(`Glass optimization: пересобрано мешей — ${optimized}`, 'info');
        }
    };
}

