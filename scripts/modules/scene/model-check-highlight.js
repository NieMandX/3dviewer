import { locateUVWitnesses } from './model-check-locator.js';

export function createModelCheckHighlight({ THREE, scene, camera, controls, getModels, requestRender, isSceneReady = () => true, document: doc = document }) {
    let generation = 0, disposed = false, active = null, toolbar = null;
    const overlays = [], colors = [0x28e0d1, 0xffbf55];
    function clear() {
        generation++; active = null; toolbar?.remove(); toolbar = null;
        for (const o of overlays.splice(0)) { o.removeFromParent(); o.geometry.dispose(); o.material.dispose(); }
        requestRender();
    }
    function alive() {
        if (!active) return true;
        if (!isSceneReady() || !getModels().includes(active.record) || !active.record.obj.parent) return false;
        return active.sites.flat().every(s => {
            const [g, uv, pos, idx, u, p, n] = s.snapshot;
            if (s.mesh.geometry !== g || g.getAttribute('uv') !== uv || g.getAttribute('position') !== pos || g.index !== idx || uv.version !== u || pos.version !== p || idx?.version !== n) return false;
            for (let node = s.mesh; node; node = node.parent) if (!node.visible) return false;
            return true;
        });
    }
    function focus(side) {
        if (!active || !alive()) { clear(); return; }
        const s = active.sites[side][0]; s.mesh.updateWorldMatrix(true, false);
        const center = s.point.clone().applyMatrix4(s.mesh.matrixWorld);
        const edge = s.edge.map(p => p.clone().applyMatrix4(s.mesh.matrixWorld));
        const normal = s.vertices[1].clone().sub(s.vertices[0]).cross(s.vertices[2].clone().sub(s.vertices[0]));
        normal.applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(s.mesh.matrixWorld)).normalize();
        if (normal.lengthSq() < 0.5) normal.copy(camera.position).sub(center).normalize();
        let distance = THREE.MathUtils.clamp(edge[0].distanceTo(edge[1]) * 1.5, 0.5, 30);
        // Stop before a nearby ceiling/wall instead of placing the camera inside it.
        // Use temporary raycast proxies so source materials and their sides are untouched.
        const ray = new THREE.Raycaster(center.clone().addScaledVector(normal, 0.002), normal, 0.002, distance);
        const probeMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
        try {
            active.record.obj.traverse(mesh => {
                if (!mesh.isMesh || !mesh.visible || mesh.userData?.isCollision || !mesh.geometry) return;
                const proxy = new THREE.Mesh(mesh.geometry, probeMaterial); proxy.matrixWorld.copy(mesh.matrixWorld);
                const hits = ray.intersectObject(proxy, false);
                if (hits.length) distance = Math.min(distance, Math.max(0.02, hits[0].distance * 0.65));
            });
        } finally { probeMaterial.dispose(); }
        camera.position.copy(center).addScaledVector(normal, distance);
        controls.target.copy(center); camera.near = Math.min(camera.near, distance / 1000);
        camera.far = Math.max(camera.far, distance * 1000); camera.updateProjectionMatrix(); controls.update();
        requestRender();
        if (toolbar) toolbar.querySelector('[role=status]').textContent = `Участок ${side ? 'B' : 'A'} · выделены ребро и прилегающие треугольники`;
    }
    function add(vertices, mesh, color, line = false) {
        const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
        const material = line ? new THREE.LineBasicMaterial({ color, depthTest: true, depthWrite: false })
            : new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.48, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const o = line ? new THREE.Line(geometry, material) : new THREE.Mesh(geometry, material);
        o.name = 'Model check witness'; o.userData.excludeFromExport = o.userData.excludeFromBounds = true;
        o.matrixAutoUpdate = o.matrixWorldAutoUpdate = false; o.matrixWorld.copy(mesh.matrixWorld);
        o.onBeforeRender = () => o.matrixWorld.copy(mesh.matrixWorld);
        o.frustumCulled = false; o.renderOrder = 999; o.raycast = () => {};
        scene.add(o); overlays.push(o);
    }
    return { clear, alive, focus, async show(view, callbacks) {
        clear(); const mark = generation;
        const requireReady = () => { if (!isSceneReady()) throw new Error('Дождитесь завершения загрузки модели и повторите переход в 3D.'); };
        requireReady();
        const result = await locateUVWitnesses(view, getModels(), THREE, { isCurrent: () => !disposed && mark === generation });
        if (disposed || mark !== generation) throw new DOMException('Stale model', 'AbortError');
        requireReady();
        active = result;
        try {
            result.sites.forEach((sites, i) => {
                for (const s of sites) add(s.vertices, s.mesh, colors[i]);
                add(sites[0].edge, sites[0].mesh, colors[i], true);
            });
            toolbar = doc.createElement('div'); toolbar.className = 'model-check-scene-toolbar'; toolbar.id = 'modelCheckSceneToolbar';
            const status = doc.createElement('p'); status.setAttribute('role', 'status'); toolbar.append(status);
            const row = doc.createElement('div'); row.className = 'model-check-actions'; toolbar.append(row);
            for (const [label, action] of [['Участок A', () => focus(0)], ['Участок B', () => focus(1)], ['К текстуре', callbacks.returnToTexture], ['Убрать подсветку', callbacks.close]]) {
                const b = doc.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = label; b.onclick = action; row.append(b);
            }
            const xray = doc.createElement('button'); xray.type = 'button'; xray.className = 'btn'; xray.textContent = 'Сквозь поверхности'; xray.setAttribute('aria-pressed', 'false');
            xray.onclick = () => { const on = xray.getAttribute('aria-pressed') !== 'true'; xray.setAttribute('aria-pressed', String(on)); for (const o of overlays) { o.material.depthTest = !on; o.material.needsUpdate = true; } requestRender(); };
            row.append(xray);
            toolbar.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') callbacks.close(); });
            doc.body.append(toolbar); focus(0);
        } catch (error) { clear(); throw error; }
    }, dispose() { disposed = true; clear(); } };
}
