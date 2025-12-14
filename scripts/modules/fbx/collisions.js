import * as THREE from 'three';

const COLLISION_MAT_BASE = new THREE.MeshBasicMaterial({
    color: 0xff3333,
    transparent: true,
    opacity: 0.25,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
});

function isUCXName(s) {
    return /^ucx/i.test(String(s || ''));
}

function getNearestUCXName(obj) {
    for (let p = obj; p; p = p.parent) {
        if (isUCXName(p.name)) return p.name;
        if (p.geometry && isUCXName(p.geometry.name)) return p.geometry.name;
    }
    return null;
}

/**
 * Помечает UCX-меши, задаёт им красный прозрачный материал (с именем UCX-объекта)
 * и отключает тени у коллизий.
 */
export function markCollisionMeshes(root) {
    if (!root) return 0;
    let affected = 0;
    root.traverse((o) => {
        if (!o.isMesh) return;
        const ucxBase = getNearestUCXName(o);
        if (!ucxBase) return;

        o.userData.isCollision = true;
        o.castShadow = false;
        o.receiveShadow = false;

        const nm = ucxBase || o.name || o.geometry?.name || '__COLLISION__';
        const m = COLLISION_MAT_BASE.clone();
        m.name = nm;

        if (Array.isArray(o.material)) {
            o.material = o.material.map(() => m);
        } else {
            o.material = m;
        }

        o.renderOrder = Math.max(o.renderOrder || 0, 999);
        o.visible = false;
        o.userData._origMaterial = o.material;
        affected++;
    });
    return affected;
}

export function createCollisionVisibilityHelpers(deps) {
    const loadedModels = deps?.loadedModels;
    const schedulePanelRefresh = typeof deps?.schedulePanelRefresh === 'function' ? deps.schedulePanelRefresh : null;
    const updateEyeButtonsForTarget = typeof deps?.updateEyeButtonsForTarget === 'function' ? deps.updateEyeButtonsForTarget : null;
    const setMeshAndMaterialsVisibility =
        typeof deps?.setMeshAndMaterialsVisibility === 'function' ? deps.setMeshAndMaterialsVisibility : null;
    const syncCollisionButtons = typeof deps?.syncCollisionButtons === 'function' ? deps.syncCollisionButtons : null;

    const safeSchedule = schedulePanelRefresh || ((cb) => cb?.());
    const safeUpdateEye = updateEyeButtonsForTarget || (() => {});
    const safeSetMeshVisibility = setMeshAndMaterialsVisibility || ((obj, visible) => (obj.visible = visible));
    const safeSync = syncCollisionButtons || (() => {});

    function ensureZipCollisionsHidden(groupName) {
        if (!groupName || !Array.isArray(loadedModels)) return;
        const models = loadedModels.filter((m) => m.group === groupName);
        if (!models.length) return;

        let anyCollision = false;
        models.forEach((model) => {
            if (!model?.obj) return;
            model.obj.traverse((o) => {
                if (!o.isMesh || !o.userData?.isCollision) return;
                anyCollision = true;
                if (o.visible !== false) {
                    safeSetMeshVisibility(o, false);
                }
            });
        });

        if (!anyCollision) return;

        safeSchedule(() => {
            safeUpdateEye(`zipcoll|${groupName}`, false);
            models.forEach((model) => {
                if (model?.obj?.uuid) safeUpdateEye(`colgrp|${model.obj.uuid}`, false);
            });
            safeSync();
        });
    }

    function hideCollisions(root, refresh = true) {
        let changed = false;
        root?.traverse?.((o) => {
            if (o.userData?.isCollision) {
                if (o.visible !== false) {
                    safeSetMeshVisibility(o, false);
                    changed = true;
                }
            }
        });
        if (changed && refresh) safeSchedule(() => safeSync());
        return changed;
    }

    function hideSMCollisions(syncUI = true) {
        if (!Array.isArray(loadedModels)) return false;
        let changed = false;
        loadedModels.forEach((model) => {
            if ((model.zipKind || '').toUpperCase() !== 'SM') return;
            if (!model?.obj) return;
            if (hideCollisions(model.obj, false)) changed = true;
        });
        if (changed && syncUI) safeSync();
        return changed;
    }

    return Object.freeze({
        ensureZipCollisionsHidden,
        hideCollisions,
        hideSMCollisions,
    });
}

