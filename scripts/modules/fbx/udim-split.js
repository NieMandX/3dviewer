import * as THREE from 'three';

function udimTile(ud) {
    const i = ud - 1001;
    return { tu: i % 10, tv: Math.floor(i / 10) };
}

function triUDIM(u1, v1, u2, v2, u3, v3) {
    const u = (u1 + u2 + u3) / 3;
    const v = (v1 + v2 + v3) / 3;
    const tu = Math.max(0, Math.floor(u));
    const tv = Math.max(0, Math.floor(v));
    return 1001 + tu + tv * 10;
}

export function splitMeshByUDIM(mesh) {
    const g0 = mesh.geometry;
    if (!g0 || !g0.getAttribute?.('uv')) return false;

    const nm = (mesh.name || '').toLowerCase();
    if (/^ucx/.test(nm)) return false;

    const posAttr = g0.getAttribute('position');
    const uvAttr = g0.getAttribute('uv');
    if (!posAttr || !uvAttr) return false;
    const parent = mesh.parent;
    const meshIndex = parent?.children.indexOf(mesh) ?? -1;
    if (meshIndex < 0) return false;

    const index = g0.index;
    const vertexCount = index ? index.count : posAttr.count;
    const triangleCount = Math.floor(vertexCount / 3);
    const vertexAt = (offset) => index ? index.getX(offset) : offset;
    const tileAt = (offset) => {
        const a = vertexAt(offset), b = vertexAt(offset + 1), c = vertexAt(offset + 2);
        return triUDIM(uvAttr.getX(a), uvAttr.getY(a), uvAttr.getX(b), uvAttr.getY(b), uvAttr.getX(c), uvAttr.getY(c));
    };
    // Count first: a one-tile mesh keeps its original buffers and material.
    // Multi-tile meshes allocate only their final arrays, never a full expanded
    // geometry plus growing JavaScript arrays for every output tile.
    const counts = new Map();
    for (let t = 0; t < triangleCount; t++) {
        const tile = tileAt(t * 3);
        counts.set(tile, (counts.get(tile) || 0) + 1);
    }
    if (counts.size <= 1) return false;
    const nrmAttr = g0.getAttribute('normal');
    let holder = null;
    let committed = false;
    const rollbackGeometries = new Set();
    const rollbackMaterials = new Set();

    const disposeUncommittedHolder = () => {
        const geometries = new Set();
        const materials = new Set();
        const asMaterialArray = (value) => {
            if (!value) return [];
            return Array.isArray(value) ? value.filter(Boolean) : [value];
        };
        const disposeGeometry = (geometry) => {
            if (!geometry?.dispose || geometries.has(geometry)) return;
            geometries.add(geometry);
            geometry.dispose();
        };
        const disposeMaterial = (material) => {
            if (!material || materials.has(material)) return;
            materials.add(material);
            material.dispose?.();
        };
        holder?.traverse?.((node) => {
            disposeGeometry(node?.geometry);
            asMaterialArray(node?.material).forEach(disposeMaterial);
        });
        rollbackGeometries.forEach(disposeGeometry);
        rollbackMaterials.forEach(disposeMaterial);
    };

    try {
        const buckets = new Map();
        for (const [tile, count] of counts) {
            const { tu, tv } = udimTile(tile);
            buckets.set(tile, {
                pos: new Float32Array(count * 9), uv: new Float32Array(count * 6),
                nrm: nrmAttr ? new Float32Array(count * 9) : null, tu, tv, vertices: 0,
            });
        }
        for (let t = 0; t < triangleCount; t++) {
            const offset = t * 3;
            const bucket = buckets.get(tileAt(offset));
            for (let k = 0; k < 3; k++) {
                const source = vertexAt(offset + k), dest = bucket.vertices++;
                bucket.pos[dest * 3] = posAttr.getX(source);
                bucket.pos[dest * 3 + 1] = posAttr.getY(source);
                bucket.pos[dest * 3 + 2] = posAttr.getZ(source);
                bucket.uv[dest * 2] = uvAttr.getX(source) - bucket.tu;
                bucket.uv[dest * 2 + 1] = uvAttr.getY(source) - bucket.tv;
                if (nrmAttr) {
                    bucket.nrm[dest * 3] = nrmAttr.getX(source);
                    bucket.nrm[dest * 3 + 1] = nrmAttr.getY(source);
                    bucket.nrm[dest * 3 + 2] = nrmAttr.getZ(source);
                }
            }
        }

        holder = new THREE.Group();
        holder.name = 'UDIM';
        holder.userData.udimHolder = true;
        holder.userData._removedMaterials = mesh.material || null;
        holder.userData._removedCustomDepthMaterial = mesh.customDepthMaterial || null;
        holder.userData._removedCustomDistanceMaterial = mesh.customDistanceMaterial || null;

        holder.position.copy(mesh.position);
        holder.quaternion.copy(mesh.quaternion);
        holder.scale.copy(mesh.scale);

        for (const [ud, b] of buckets) {
            const gg = new THREE.BufferGeometry();
            rollbackGeometries.add(gg);
            gg.setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
            gg.setAttribute('uv', new THREE.BufferAttribute(b.uv, 2));
            if (b.nrm) gg.setAttribute('normal', new THREE.BufferAttribute(b.nrm, 3));
            else gg.computeVertexNormals();

            const tileGroup = new THREE.Group();
            tileGroup.name = `UDIM ${ud}`;
            tileGroup.userData.udim = ud;

            let childMat;
            const srcMat = mesh.material;
            if (Array.isArray(srcMat)) {
                childMat = srcMat.map((m, i) => {
                    const c = m.clone();
                    rollbackMaterials.add(c);
                    c.name = (m.name || mesh.name || 'Material') + ` · UDIM ${ud}` + (srcMat.length > 1 ? `_${i + 1}` : '');
                    return c;
                });
            } else {
                childMat = srcMat.clone();
                rollbackMaterials.add(childMat);
                childMat.name = (srcMat.name || mesh.name || 'Material') + ` · UDIM ${ud}`;
            }

            const child = new THREE.Mesh(gg, childMat);
            child.name = `${mesh.name || mesh.type} · UDIM ${ud}`;
            child.castShadow = mesh.castShadow;
            child.receiveShadow = mesh.receiveShadow;
            child.userData.udim = ud;
            child.userData.sourceFBXModelId = mesh.userData?.sourceFBXModelId;

            tileGroup.add(child);
            holder.add(tileGroup);
        }

        parent.remove(mesh);
        parent.add(holder);
        const holderIndex = parent.children.indexOf(holder);
        if (holderIndex >= 0) parent.children.splice(holderIndex, 1);
        parent.children.splice(Math.min(meshIndex, parent.children.length), 0, holder);
        committed = true;

        try {
            g0.dispose?.();
        } catch (_) {}
        mesh.geometry = null;
        mesh.material = null;
        mesh.customDepthMaterial = undefined;
        mesh.customDistanceMaterial = undefined;

        return true;
    } finally {
        if (!committed) disposeUncommittedHolder();
    }
}

export function splitAllMeshesByUDIM_SM(root) {
    const list = [];
    root.traverse((o) => {
        if (o.isMesh && o.geometry?.getAttribute?.('uv')) list.push(o);
    });
    list.forEach((m) => splitMeshByUDIM(m));
}
