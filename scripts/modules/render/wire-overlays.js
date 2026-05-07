import * as THREE from 'three';
import { asMaterialArray } from '../material/texture-utils.js';

export const BEAUTY_WIRE_ANGLE_DEG = 25;
export const BEAUTY_WIRE_COLOR = 0x111111;
export const BEAUTY_WIRE_OPACITY = 0.9;

export const WIREFRAME_COLOR = 0x666666;
export const WIREFRAME_OPACITY = 0.3;

function hasVisibleSourceMaterial(mesh) {
    const materials = asMaterialArray(mesh?.userData?._origMaterial || mesh?.material);
    return materials.some((material) => material ? material.visible !== false : false);
}

export function ensureWireframeOverlay(mesh) {
    if (!mesh.isMesh || !mesh.geometry) return null;

    if (!mesh.userData._origMaterial) mesh.userData._origMaterial = mesh.material;

    if (!mesh.userData._wireBase) {
        const base = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: 0.0,
            colorWrite: false,
            depthWrite: true,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
        });
        mesh.userData._wireBase = base;
    }

    let line = mesh.userData._wireOverlay;
    if (!line) {
        const geo = new THREE.WireframeGeometry(mesh.geometry);
        const mat = new THREE.LineBasicMaterial({
            color: WIREFRAME_COLOR,
            transparent: true,
            opacity: WIREFRAME_OPACITY,
        });
        mat.depthWrite = false;
        line = new THREE.LineSegments(geo, mat);
        line.name = (mesh.name || mesh.type) + ' (wireframe)';
        line.renderOrder = (mesh.renderOrder || 0) + 1;
        line.userData.excludeFromBounds = true;
        line.userData._geoId = mesh.geometry.id;
        mesh.add(line);
        mesh.userData._wireOverlay = line;
    } else if (line.userData._geoId !== mesh.geometry.id) {
        line.geometry?.dispose?.();
        line.geometry = new THREE.WireframeGeometry(mesh.geometry);
        line.userData._geoId = mesh.geometry.id;
    }

    const sourceVisible = hasVisibleSourceMaterial(mesh);
    mesh.userData._wireBase.visible = sourceVisible;
    mesh.material = mesh.userData._wireBase;
    line.visible = sourceVisible;
    return line;
}

export function clearWireframeOverlay(mesh) {
    if (!mesh.isMesh) return;
    if (mesh.userData._origMaterial) {
        mesh.material = mesh.userData._origMaterial;
    }
    if (mesh.userData._wireOverlay) {
        mesh.userData._wireOverlay.visible = false;
    }
}

export function ensureBeautyWire(mesh, angleDeg = BEAUTY_WIRE_ANGLE_DEG) {
    if (!mesh.isMesh || !mesh.geometry) return null;

    if (!mesh.userData._origMaterial) mesh.userData._origMaterial = mesh.material;

    if (!mesh.userData._beautyBase) {
        const base = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.15,
            metalness: 0.0,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
        });
        mesh.userData._beautyBase = base;
    }

    let line = mesh.userData._beautyWire;
    if (!line) {
        const edges = new THREE.EdgesGeometry(mesh.geometry, angleDeg);
        const mat = new THREE.LineBasicMaterial({
            color: BEAUTY_WIRE_COLOR,
            transparent: true,
            opacity: BEAUTY_WIRE_OPACITY,
        });
        line = new THREE.LineSegments(edges, mat);
        line.name = (mesh.name || mesh.type) + ' (beautywire)';
        line.renderOrder = (mesh.renderOrder || 0) + 1;
        line.userData.excludeFromBounds = true;
        mesh.add(line);
        mesh.userData._beautyWire = line;
        line.userData._angle = angleDeg;
        line.userData._geoId = mesh.geometry.id;
    } else if (line.userData._angle !== angleDeg || line.userData._geoId !== mesh.geometry.id) {
        line.geometry?.dispose?.();
        line.geometry = new THREE.EdgesGeometry(mesh.geometry, angleDeg);
        line.userData._angle = angleDeg;
        line.userData._geoId = mesh.geometry.id;
    }

    const sourceVisible = hasVisibleSourceMaterial(mesh);
    mesh.userData._beautyBase.visible = sourceVisible;
    mesh.material = mesh.userData._beautyBase;
    line.visible = sourceVisible;
    return line;
}

export function clearBeautyWire(mesh) {
    if (!mesh.isMesh) return;
    if (mesh.userData._origMaterial) {
        mesh.material = mesh.userData._origMaterial;
    }
    if (mesh.userData._beautyWire) {
        mesh.userData._beautyWire.visible = false;
    }
}
