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

    const g = g0.index ? g0.toNonIndexed() : g0.clone();
    const pos = g.getAttribute('position').array;
    const uv = g.getAttribute('uv').array;
    const nrmAttr = g.getAttribute('normal');

    const buckets = new Map(); // udim -> {pos:[], uv:[], nrm:[], tu, tv}
    const ensure = (ud) => {
        let bucket = buckets.get(ud);
        if (!bucket) {
            const { tu, tv } = udimTile(ud);
            bucket = { pos: [], uv: [], nrm: [], tu, tv };
            buckets.set(ud, bucket);
        }
        return bucket;
    };

    const triCount = pos.length / 9;
    for (let t = 0; t < triCount; t++) {
        const pBase = t * 9;
        const uBase = t * 6;
        const ud = triUDIM(
            uv[uBase],
            uv[uBase + 1],
            uv[uBase + 2],
            uv[uBase + 3],
            uv[uBase + 4],
            uv[uBase + 5],
        );
        const b = ensure(ud);

        for (let k = 0; k < 9; k++) b.pos.push(pos[pBase + k]);

        b.uv.push(
            uv[uBase] - b.tu,
            uv[uBase + 1] - b.tv,
            uv[uBase + 2] - b.tu,
            uv[uBase + 3] - b.tv,
            uv[uBase + 4] - b.tu,
            uv[uBase + 5] - b.tv,
        );

        if (nrmAttr) {
            const nrm = nrmAttr.array;
            for (let k = 0; k < 9; k++) b.nrm.push(nrm[pBase + k]);
        }
    }

    if (buckets.size <= 1) return false;

    const holder = new THREE.Group();
    holder.name = 'UDIM';
    holder.userData.udimHolder = true;

    holder.position.copy(mesh.position);
    holder.quaternion.copy(mesh.quaternion);
    holder.scale.copy(mesh.scale);

    for (const [ud, b] of buckets) {
        const gg = new THREE.BufferGeometry();
        gg.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
        gg.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
        if (b.nrm.length) gg.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
        else gg.computeVertexNormals();

        const tileGroup = new THREE.Group();
        tileGroup.name = `UDIM ${ud}`;
        tileGroup.userData.udim = ud;

        let childMat;
        const srcMat = mesh.material;
        if (Array.isArray(srcMat)) {
            childMat = srcMat.map((m, i) => {
                const c = m.clone();
                c.name = (m.name || mesh.name || 'Material') + ` · UDIM ${ud}` + (srcMat.length > 1 ? `_${i + 1}` : '');
                return c;
            });
        } else {
            childMat = srcMat.clone();
            childMat.name = (srcMat.name || mesh.name || 'Material') + ` · UDIM ${ud}`;
        }

        const child = new THREE.Mesh(gg, childMat);
        child.name = `${mesh.name || mesh.type} · UDIM ${ud}`;
        child.castShadow = mesh.castShadow;
        child.receiveShadow = mesh.receiveShadow;
        child.userData.udim = ud;

        tileGroup.add(child);
        holder.add(tileGroup);
    }

    const parent = mesh.parent;
    const i = parent.children.indexOf(mesh);
    parent.remove(mesh);
    parent.children.splice(i, 0, holder);
    holder.parent = parent;

    g0.dispose?.();

    return true;
}

export function splitAllMeshesByUDIM_SM(root) {
    const list = [];
    root.traverse((o) => {
        if (o.isMesh && o.geometry?.getAttribute?.('uv')) list.push(o);
    });
    list.forEach((m) => splitMeshByUDIM(m));
}

