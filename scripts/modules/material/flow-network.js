import * as THREE from 'three';

export function validateFlowNetwork(value) {
    if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length > 256 || value.edges.length > 512) return null;
    const ids = new Set();
    for (const node of value.nodes) {
        if (typeof node.id !== 'string' || ids.has(node.id) || !Array.isArray(node.position) || node.position.length !== 3 || !node.position.every(Number.isFinite)) return null;
        ids.add(node.id);
    }
    if (value.edges.some((e) => !Array.isArray(e) || e.length !== 2 || e[0] === e[1] || !ids.has(e[0]) || !ids.has(e[1]))) return null;
    return structuredClone(value);
}

export function sampleFlowNetwork(network) {
    const nodes = new Map(network.nodes.map((n) => [n.id, new THREE.Vector3(...n.position)]));
    return network.edges.map(([a, b]) => {
        const start = nodes.get(a), end = nodes.get(b);
        const before = network.edges.find(([x, y]) => y === a && x !== b);
        const after = network.edges.find(([x, y]) => x === b && y !== a);
        const p0 = before ? nodes.get(before[0]) : start.clone().multiplyScalar(2).sub(end);
        const p3 = after ? nodes.get(after[1]) : end.clone().multiplyScalar(2).sub(start);
        const curve = new THREE.CatmullRomCurve3([p0, start, end, p3], false, 'catmullrom', 0.25);
        // Middle third interpolates the two real anchors; other points supply tangents.
        return Array.from({ length: 17 }, (_, i) => curve.getPoint((1 + i / 16) / 3));
    });
}

export function createFlowField(network, bounds, size = 128) {
    const paths = sampleFlowNetwork(network);
    const segments = paths.flatMap((points) => points.slice(1).map((b, i) => ({ a: points[i], b })));
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(size, size);
    const [ox, oz, width, depth] = bounds;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const px = ox + (x + 0.5) / size * width, pz = oz + (y + 0.5) / size * depth;
        let best = Infinity, dx = 1, dz = 0;
        for (const { a, b } of segments) {
            const vx = b.x - a.x, vz = b.z - a.z, length2 = vx * vx + vz * vz;
            if (length2 < 1e-12) continue;
            const t = Math.max(0, Math.min(1, ((px - a.x) * vx + (pz - a.z) * vz) / length2));
            const distance = (px - a.x - t * vx) ** 2 + (pz - a.z - t * vz) ** 2;
            if (distance < best) { best = distance; const length = Math.sqrt(length2); dx = vx / length; dz = vz / length; }
        }
        const index = (y * size + x) * 4;
        pixels.data[index] = Math.round((dx + 1) * 127.5);
        pixels.data[index + 1] = Math.round((dz + 1) * 127.5);
        pixels.data[index + 2] = 255;
        pixels.data[index + 3] = 255; // Continuous phase: no artificial seams at branch junctions.
    }
    ctx.putImageData(pixels, 0, 0);
    return canvas;
}

export function createFlowNetworkEditor({ scene, world, camera, controls, canvas, requestRender, onChange, onActive = () => {} }) {
    const overlay = new THREE.Group();
    overlay.name = 'Направление течения';
    overlay.userData.excludeFromExport = overlay.userData.excludeFromBounds = true;
    overlay.renderOrder = 10000;
    const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
    let network = { nodes: [], edges: [] }, entry = null, active = false, selected = null, drag = null, previousEnabled = true;
    const clean = () => {
        overlay.traverse((o) => { o.geometry?.dispose(); if (o.material) o.material.dispose(); });
        overlay.clear();
    };
    function draw() {
        clean(); overlay.position.copy(world.position);
        const radius = Math.max(0.08, camera.position.distanceTo(controls.target) * 0.004);
        for (const node of network.nodes) {
            const dot = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 8), new THREE.MeshBasicMaterial({ color: node.id === selected ? 0xffbe4d : 0x15a8dd, depthTest: false }));
            dot.position.fromArray(node.position); dot.renderOrder = 10001; overlay.add(dot);
        }
        for (const path of sampleFlowNetwork(network)) {
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(path), new THREE.LineBasicMaterial({ color: 0x119fda, depthTest: false }));
            line.renderOrder = 10000; overlay.add(line);
            const middle = path[8], direction = path[9].clone().sub(path[7]).normalize();
            const arrow = new THREE.ArrowHelper(direction, middle, radius * 6, 0x119fda, radius * 3, radius * 2);
            arrow.traverse((o) => { if (o.material) { o.material.depthTest = false; o.renderOrder = 10002; } }); overlay.add(arrow);
        }
        requestRender();
    }
    function surface(event) {
        const rect = canvas.getBoundingClientRect();
        mouse.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
        ray.setFromCamera(mouse, camera);
        const objects = [...new Set(entry.uses.map((u) => u.object))];
        world.updateMatrixWorld(true);
        return ray.intersectObjects(objects, false).find((hit) => {
            const use = entry.uses.find((u) => u.object === hit.object && (hit.face?.materialIndex ?? 0) === u.index);
            return !!use && hit.object.visible;
        })?.point.clone().sub(world.position);
    }
    function nodeAt(event) {
        const rect = canvas.getBoundingClientRect();
        return network.nodes.find((node) => {
            const p = new THREE.Vector3(...node.position).add(world.position).project(camera);
            return p.z < 1 && Math.hypot((p.x + 1) * rect.width / 2 + rect.left - event.clientX, (1 - p.y) * rect.height / 2 + rect.top - event.clientY) < 15;
        });
    }
    function down(event) {
        if (!active || event.button !== 0) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const node = nodeAt(event);
        if (node) { drag = { id: node.id, x: event.clientX, y: event.clientY, moved: false }; canvas.setPointerCapture(event.pointerId); return; }
        const point = surface(event); if (!point || network.nodes.length >= 256) return;
        const id = crypto.randomUUID(); network.nodes.push({ id, position: point.toArray() });
        if (selected) network.edges.push([selected, id]); selected = id; draw(); onChange(network, false);
    }
    function move(event) {
        if (!active || !drag) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4 && !drag.moved) return;
        const point = surface(event); if (!point) return;
        network.nodes.find((n) => n.id === drag.id).position = point.toArray(); drag.moved = true; draw();
    }
    function up(event) {
        if (!active || !drag) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (!drag.moved && selected && selected !== drag.id && !network.edges.some(([a, b]) => a === selected && b === drag.id) && network.edges.length < 512) network.edges.push([selected, drag.id]);
        selected = drag.id; drag = null; if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        draw(); onChange(network, false);
    }
    function key(event) {
        if (!active || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removePoint(); }
    }
    function removePoint() {
        if (!selected) return;
        network.nodes = network.nodes.filter((n) => n.id !== selected); network.edges = network.edges.filter((e) => !e.includes(selected)); selected = null; draw(); onChange(network, false);
    }
    function stop() { if (!active) return; active = false; onActive(false); document.removeEventListener('keydown', key); drag = null; entry = null; controls.enabled = previousEnabled; overlay.removeFromParent(); clean(); canvas.style.cursor = ''; requestRender(); }
    canvas.addEventListener('pointerdown', down, true); canvas.addEventListener('pointermove', move, true); canvas.addEventListener('pointerup', up, true); 
    return {
        start(value, data) { if (active) stop(); entry = value; network = validateFlowNetwork(data) || { nodes: [], edges: [] }; selected = null; active = true; onActive(true); document.addEventListener('keydown', key); previousEnabled = controls.enabled; controls.enabled = false; scene.add(overlay); canvas.style.cursor = 'crosshair'; draw(); },
        stop, removePoint,
        newBranch() { selected = null; draw(); },
        reverse() { network.edges = network.edges.map(([a, b]) => [b, a]); draw(); onChange(network, false); },
        get value() { return structuredClone(network); },
        get active() { return active; },
        dispose() { if (active) stop(); clean(); canvas.removeEventListener('pointerdown', down, true); canvas.removeEventListener('pointermove', move, true); canvas.removeEventListener('pointerup', up, true); document.removeEventListener('keydown', key); },
    };
}
