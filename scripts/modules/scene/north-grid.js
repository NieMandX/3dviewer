export function createNorthGridController(options = {}) {
    const THREE = options.THREE || null;
    const scene = options.scene || null;
    const app = options.app || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const isZUp = typeof options.isZUp === 'function' ? options.isZUp : () => false;
    const getNorthDeg = typeof options.getNorthDeg === 'function' ? options.getNorthDeg : () => 0;

    const gridSize = Number.isFinite(options.gridSize) ? options.gridSize : 100;
    const gridDivisions = Number.isFinite(options.gridDivisions) ? options.gridDivisions : 100;
    const gridColor = options.gridColor ?? 0x888888;
    const pointerColor = options.pointerColor ?? 0xff3d00;

    let parcelsGroup = null;

    function setParcelsGroup(group) {
        parcelsGroup = group || null;
    }

    function createNorthPointer() {
        if (!THREE) return null;
        const group = new THREE.Group();
        group.name = 'NorthPointer';
        group.userData.excludeFromBounds = true;

        const material = new THREE.LineBasicMaterial({ color: pointerColor, transparent: true, opacity: 0.9 });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 1], 3));
        const line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        line.userData.excludeFromBounds = true;
        group.add(line);

        group.userData.line = line;
        return group;
    }

    function createPointGridHelper({ size = 100, divisions = 10, color = 0x888888 } = {}) {
        if (!THREE) return null;
        const group = new THREE.Group();
        group.name = 'PointGrid';

        const half = size * 0.5;
        const step = divisions > 0 ? size / divisions : size;

        const positions = [];
        for (let x = -half; x <= half + 1e-6; x += step) {
            for (let z = -half; z <= half + 1e-6; z += step) {
                positions.push(x, 0, z);
            }
        }

        const geometry = new THREE.BufferGeometry();
        const array = new Float32Array(positions);
        const attr = new THREE.BufferAttribute(array, 3);
        geometry.setAttribute('position', attr);
        geometry.setDrawRange(0, array.length / 3);

        const material = new THREE.PointsMaterial({
            color,
            size: 0.8,
            sizeAttenuation: false,
            transparent: true,
            opacity: 0.75,
        });

        const points = new THREE.Points(geometry, material);
        points.renderOrder = -10;
        points.userData.excludeFromBounds = true;
        points.isGridHelper = true;

        group.add(points);
        group.userData.excludeFromBounds = true;
        group.isGridHelper = true;

        group.userData.gridSize = size;
        group.userData.step = step;
        group.userData.geometry = geometry;
        group.userData.basePositions = array.slice(0);
        group.userData.lineLength = size * 0.5;

        return group;
    }

    const grid = createPointGridHelper({ size: gridSize, divisions: gridDivisions, color: gridColor });
    if (grid && scene) {
        grid.userData.excludeFromBounds = true;
        scene.add(grid);
    }
    if (app) app.grid = grid;

    const northPointer = createNorthPointer();
    if (northPointer && scene) {
        scene.add(northPointer);
    }
    if (app) app.northPointer = northPointer;

    const tmpDir = THREE ? new THREE.Vector3() : null;
    const baseVec = THREE ? new THREE.Vector3() : null;
    const upVec = THREE ? new THREE.Vector3() : null;
    const planeVec2 = THREE ? new THREE.Vector2() : null;

    function alignParcelsGroupToNorth() {
        if (!parcelsGroup) return;
        parcelsGroup.rotation.set(0, 0, 0);
        parcelsGroup.quaternion.identity();
        parcelsGroup.updateMatrixWorld(true);
        requestRender();
    }

    function updateGridNorthGap(dir, lineLength) {
        if (!grid) return;
        const geometry = grid.userData?.geometry;
        const basePositions = grid.userData?.basePositions;
        if (!geometry || !basePositions) return;

        const attr = geometry.attributes.position;
        const arr = attr.array;
        const step = grid.userData.step || 1;
        const size = grid.userData.gridSize || gridSize;

        let maxAlong = lineLength;
        if (maxAlong == null) {
            maxAlong = grid.userData.lineLength;
            if (maxAlong == null) maxAlong = size * 0.5;
        }
        const cutoff = maxAlong + step * 0.5;
        const threshold = Math.max(step * 0.5, 0.2);
        const forwardTolerance = Math.min(step * 0.25, 0.1);

        const vec2 = isZUp()
            ? planeVec2.set(dir.x, dir.y)
            : planeVec2.set(dir.x, dir.z);
        let len = vec2.length();
        if (!Number.isFinite(len) || len < 1e-6) {
            vec2.set(0, 1);
            len = 1;
        }
        vec2.divideScalar(len);

        let write = 0;
        for (let i = 0; i < basePositions.length; i += 3) {
            const x = basePositions[i];
            const y = basePositions[i + 1];
            const z = basePositions[i + 2];
            const px = x;
            const pz = z;

            const along = px * vec2.x + pz * vec2.y;
            const perp = Math.abs(px * vec2.y - pz * vec2.x);
            const masked = along >= -forwardTolerance && along <= cutoff && perp <= threshold;

            if (!masked) {
                arr[write] = x;
                arr[write + 1] = y;
                arr[write + 2] = z;
                write += 3;
            }
        }

        attr.needsUpdate = true;
        geometry.setDrawRange(0, write / 3);
        geometry.computeBoundingSphere();
    }

    function updateNorthPointer() {
        if (!northPointer || !tmpDir || !baseVec || !upVec || !planeVec2) return;
        const line = northPointer.userData?.line;
        if (!line) return;

        const northDeg = parseFloat(getNorthDeg()) || 0;
        const up = isZUp() ? upVec.set(0, 0, 1) : upVec.set(0, 1, 0);
        const base = isZUp() ? baseVec.set(0, 1, 0) : baseVec.set(0, 0, 1);

        const dir = tmpDir.copy(base).applyAxisAngle(up, THREE.MathUtils.degToRad(-northDeg)).normalize();
        dir.multiplyScalar(-1);
        const effectiveGridSize = (grid?.userData?.gridSize) ?? gridSize;
        const lineLength = effectiveGridSize * 0.5;

        const positions = line.geometry.attributes.position.array;
        positions[0] = 0; positions[1] = 0; positions[2] = 0;
        positions[3] = dir.x * lineLength;
        positions[4] = dir.y * lineLength;
        positions[5] = dir.z * lineLength;
        line.geometry.attributes.position.needsUpdate = true;

        northPointer.position.set(0, 0, 0);
        if (app) app.northDirection = dir.clone();

        updateGridNorthGap(dir, lineLength);
        alignParcelsGroupToNorth();
        requestRender();
    }

    function disposeObject(root) {
        if (!root) return;
        root.parent?.remove?.(root);
        root.traverse?.((node) => {
            node.geometry?.dispose?.();
            const material = node.material;
            if (Array.isArray(material)) {
                material.forEach((entry) => entry?.dispose?.());
            } else {
                material?.dispose?.();
            }
        });
    }

    function dispose() {
        disposeObject(northPointer);
        disposeObject(grid);
        parcelsGroup = null;
        if (app) {
            if (app.grid === grid) app.grid = null;
            if (app.northPointer === northPointer) app.northPointer = null;
            app.northDirection = null;
        }
    }

    return {
        grid,
        northPointer,
        setParcelsGroup,
        alignParcelsGroupToNorth,
        updateNorthPointer,
        dispose,
    };
}
