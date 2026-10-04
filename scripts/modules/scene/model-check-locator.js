// A source FBX hash + Model ID + unambiguous UV boundary edge locate a witness.
// Blender polygon indices and display names deliberately play no role here.
const EPS = 2e-6;
const pair = p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && n >= 0 && n <= 1);
export function validSceneAnchor(view) {
    const a = view?.sample?.scene_anchor;
    return a?.schema === 'agr-uv-edge-v1' && /^[a-f0-9]{64}$/.test(a.fbx_sha256)
        && a.coordinate_space === 'fbx_geometry_identity'
        && Array.isArray(view.sample.points_uv) && view.sample.points_uv.length === 2 && view.sample.points_uv.every(pair)
        && Array.isArray(a.edges) && a.edges.length === 2 && a.edges.every((e, i) => {
            if (!/^[1-9][0-9]{0,15}$/.test(e?.model_id) || !Number.isSafeInteger(Number(e.model_id))
                || !Array.isArray(e.edge_uv) || e.edge_uv.length !== 2 || !e.edge_uv.every(pair)
                || !Array.isArray(e.edge_xyz) || e.edge_xyz.length !== 2 || !e.edge_xyz.every(p => Array.isArray(p) && p.length === 3 && p.every(n => Number.isFinite(n) && Math.abs(n) <= 1e9))) return false;
            const [p, q] = e.edge_uv, point = view.sample.points_uv[i];
            if (!view.sample.island_segments_uv?.[i]?.some(s =>
                (Math.hypot(s[0][0]-p[0], s[0][1]-p[1]) <= EPS && Math.hypot(s[1][0]-q[0], s[1][1]-q[1]) <= EPS)
                || (Math.hypot(s[1][0]-p[0], s[1][1]-p[1]) <= EPS && Math.hypot(s[0][0]-q[0], s[0][1]-q[1]) <= EPS))) return false;
            const dx = q[0] - p[0], dy = q[1] - p[1], den = dx * dx + dy * dy;
            if (den < 1e-16) return false;
            const t = ((point[0] - p[0]) * dx + (point[1] - p[1]) * dy) / den;
            return t >= -EPS && t <= 1 + EPS && Math.hypot(point[0] - p[0] - t * dx, point[1] - p[1] - t * dy) <= EPS;
        });
}

export async function locateUVWitnesses(view, records, THREE, { isCurrent = () => true, maxTriangles = 2000000, maxMs = 4000 } = {}) {
    const fail = message => { throw new Error(message); };
    if (!validSceneAnchor(view)) fail('В этом отчёте нет надёжной привязки к 3D. Нужна новая проверка исходного ZIP.');
    const anchor = view.sample.scene_anchor;
    const matches = records.filter(r => r.sourceContainer === 'zip' && ['NPM', 'SM', 'VPM'].includes(r.zipKind)
        && r.sourceFBXSha256 === anchor.fbx_sha256 && r.name === view.sourceFbx && r.obj?.parent);
    if (matches.length !== 1) fail(matches.length ? 'Одинаковый FBX загружен несколько раз. Оставьте одну копию для перехода.' : 'Загрузите исходный ZIP из этого отчёта. Загруженный FBX должен совпадать побайтно.');
    const record = matches[0], root = record.obj, candidates = [[], []];
    if (root.animations?.length) fail('Переход для анимированной модели пока не поддерживается.');
    root.updateWorldMatrix(true, true);
    const meshes = []; root.traverse(o => { if (o.isMesh && !o.userData?.excludeFromExport && !o.userData?.isCollision) meshes.push(o); });
    const start = performance.now(); let count = 0;
    const close = (a, b) => Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) <= EPS;
    for (const mesh of meshes) {
        const wanted = anchor.edges.map((e, i) => e.model_id === mesh.userData?.sourceFBXModelId ? i : -1).filter(i => i >= 0);
        if (!wanted.length) continue;
        if (mesh.isSkinnedMesh || mesh.morphTargetInfluences?.length) fail('Деформируемая поверхность пока не поддерживается.');
        const g = mesh.geometry, uv = g?.getAttribute('uv'), pos = g?.getAttribute('position'), idx = g?.index;
        if (!uv || !pos || uv.count !== pos.count) continue;
        const snapshot = [g, uv, pos, idx, uv.version, pos.version, idx?.version];
        const tile = view.texture.tile - 1001, tu = tile % 10, tv = Math.floor(tile / 10);
        const split = mesh.userData?.udim;
        if (split && split !== view.texture.tile) continue;
        const n = idx?.count ?? pos.count;
        for (let base = 0; base + 2 < n; base += 3) {
            if (++count > maxTriangles || performance.now() - start > maxMs) fail('Достигнут предел поиска поверхности; 3D-подсветка не построена.');
            if (count % 4096 === 0) {
                await new Promise(resolve => setTimeout(resolve, 0));
                if (!isCurrent()) throw new DOMException('Stale model', 'AbortError');
            }
            const ids = [0, 1, 2].map(k => idx ? idx.getX(base + k) : base + k);
            const coords = ids.map(i => [uv.getX(i) - (split ? 0 : tu), uv.getY(i) - (split ? 0 : tv)]);
            for (const side of wanted) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
                const edge = anchor.edges[side].edge_uv;
                if (!(close(coords[a], edge[0]) && close(coords[b], edge[1])) && !(close(coords[b], edge[0]) && close(coords[a], edge[1]))) continue;
                const p = view.sample.points_uv[side], x = coords[a], y = coords[b];
                const dx = y[0] - x[0], dy = y[1] - x[1], den = dx * dx + dy * dy;
                if (den < 1e-16) continue;
                const t = Math.max(0, Math.min(1, ((p[0] - x[0]) * dx + (p[1] - x[1]) * dy) / den));
                const vertices = ids.map(i => new THREE.Vector3().fromBufferAttribute(pos, i));
                if (vertices.some(v => ![v.x, v.y, v.z].every(Number.isFinite))) continue;
                const xyz = anchor.edges[side].edge_xyz;
                const equal = (v, p) => v.x === p[0] && v.y === p[1] && v.z === p[2];
                const forward = close(coords[a], edge[0]) && close(coords[b], edge[1]);
                if (!equal(vertices[a], xyz[forward ? 0 : 1]) || !equal(vertices[b], xyz[forward ? 1 : 0])) continue;
                const point = vertices[a].clone().lerp(vertices[b], t);
                candidates[side].push({ mesh, vertices, edge: [vertices[a], vertices[b]], point, worldPoint: point.clone().applyMatrix4(mesh.matrixWorld), snapshot });
                if (candidates[side].length > 16) fail('UV-ребро повторяется слишком много раз: однозначный переход невозможен.');
            }
        }
    }
    if (!isCurrent() || !root.parent) throw new DOMException('Stale model', 'AbortError');
    for (const sites of candidates) {
        if (!sites.length) fail('Ребро не найдено в загруженной геометрии. Подсветка по приблизительному имени не выполняется.');
        if (sites.some(s => s.mesh !== sites[0].mesh || s.worldPoint.distanceTo(sites[0].worldPoint) > 1e-5)) fail('Эти UV используются на нескольких поверхностях. Однозначный переход невозможен.');
        for (const s of sites) {
            const [g, uv, pos, idx, u, p, n] = s.snapshot;
            if (s.mesh.geometry !== g || g.getAttribute('uv') !== uv || g.getAttribute('position') !== pos || g.index !== idx || uv.version !== u || pos.version !== p || idx?.version !== n) fail('Геометрия изменилась во время поиска. Повторите переход.');
            for (let node = s.mesh; node; node = node.parent) if (!node.visible) fail('Нужная поверхность скрыта. Включите её отображение и повторите переход.');
        }
    }
    return { record, sites: candidates };
}
