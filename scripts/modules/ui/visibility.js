export function createVisibilityController(options = {}) {
    const world = options.world || null;
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];
    const outEl = options.outEl || null;
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const markSceneStatsDirty = typeof options.markSceneStatsDirty === 'function' ? options.markSceneStatsDirty : () => {};

    function handleEyeToggle(el) {
        const uuid = el?.dataset?.uuid;
        const matIndexAttr = el?.dataset?.matIndex;
        const matIndex = matIndexAttr !== undefined ? Number(matIndexAttr) : null;
        if (uuid) {
            toggleObjectVisibility(uuid, Number.isNaN(matIndex) ? null : matIndex);
            return;
        }
        const id = el?.dataset?.target;
        if (!id) return;
        toggleVisibilityById(id, el);
    }

    function setEyeIcon(el, visible) {
        if (!el) return;
        const iconOn = el.dataset.iconOn || '👁';
        const iconOff = el.dataset.iconOff || '🚫';
        el.textContent = visible ? iconOn : iconOff;
    }

    function updateEyeButtonsForTarget(target, visible) {
        if (!outEl) return;
        outEl.querySelectorAll(`.eye[data-target="${target}"]`).forEach(btn => setEyeIcon(btn, visible));
    }

    function setMeshAndMaterialsVisibility(target, visible) {
        if (!target) return;
        const materials = Array.isArray(target.material) ? target.material : [target.material];
        let changed = false;
        materials.forEach(mat => {
            if (!mat) return;
            if (mat.visible !== visible) {
                mat.visible = visible;
                changed = true;
            }
        });
        if (target.visible !== visible) {
            target.visible = visible;
            changed = true;
        }
        if (changed) markSceneStatsDirty();
        requestRender();
    }

    function updateMeshVisibilityFromMaterials(target) {
        if (!target) return;
        const materials = Array.isArray(target.material) ? target.material : [target.material];
        const anyVisible = materials.some(mat => mat ? mat.visible !== false : false);
        if (target.visible !== anyVisible) {
            target.visible = anyVisible;
            markSceneStatsDirty();
        }
    }

    function toggleObjectVisibility(uuid, matIndex = null) {
        if (!world) return;
        const target = world.getObjectByProperty('uuid', uuid);
        if (!target) return;

        if (matIndex !== null && Array.isArray(target.material)) {
            const materials = target.material;
            const mat = materials[matIndex];
            if (!mat) return;
            const nextVisible = !(mat.visible !== false);
            if (mat.visible !== nextVisible) {
                mat.visible = nextVisible;
                markSceneStatsDirty();
            }
            if ('needsUpdate' in mat) mat.needsUpdate = true;
            updateMeshVisibilityFromMaterials(target);
            requestRender();
            syncEyeIconsForObject(uuid, nextVisible, matIndex);
            return;
        }

        const nextVisible = !target.visible;
        setMeshAndMaterialsVisibility(target, nextVisible);
        syncEyeIconsForObject(uuid, nextVisible);
    }

    function syncEyeIconsForObject(uuid, visible, matIndex = null) {
        if (!outEl) return;
        const baseSelector = `.eye[data-uuid="${uuid}"]`;
        if (matIndex !== null) {
            outEl.querySelectorAll(`${baseSelector}[data-mat-index="${matIndex}"]`).forEach(icon => {
                setEyeIcon(icon, visible);
            });
            const mesh = world?.getObjectByProperty?.('uuid', uuid);
            if (mesh) {
                const meshVisible = mesh.visible !== false;
                outEl.querySelectorAll(`${baseSelector}:not([data-mat-index])`).forEach(icon => {
                    setEyeIcon(icon, meshVisible);
                });
            }
            return;
        }
        outEl.querySelectorAll(baseSelector).forEach(icon => {
            setEyeIcon(icon, visible);
        });
    }

    function toggleVisibilityById(id, el) {
        if (!world) return;

        // Группа: id формата "group|<zipName>"
        if (id.startsWith('group|')) {
            const groupName = id.slice(6);
            const items = loadedModels.filter(m => m.group === groupName);
            if (!items.length) return;

            // если в группе есть что-то видимое — скрываем всё; иначе показываем всё
            const anyVisible = items.some(m => m.obj.visible !== false);
            const newVisible = !anyVisible;
            items.forEach(m => {
                if (!m?.obj) return;
                setMeshAndMaterialsVisibility(m.obj, newVisible);
                syncEyeIconsForObject(m.obj.uuid, newVisible);
            });
            updateEyeButtonsForTarget(id, newVisible);
            return;
        }

        if (id.startsWith('zipcoll|')) {
            const groupName = id.slice(8);
            const items = loadedModels.filter(m => m.group === groupName);
            if (!items.length) { updateEyeButtonsForTarget(id, true); return; }

            const allColl = [];
            const perFileIds = new Map();
            items.forEach(m => {
                if (!m?.obj) return;
                const perId = `colgrp|${m.obj.uuid}`;
                const list = [];
                m.obj.traverse(o => {
                    if (o.isMesh && o.userData?.isCollision) {
                        allColl.push(o);
                        list.push(o);
                    }
                });
                if (list.length) perFileIds.set(perId, list);
            });

            if (!allColl.length) { updateEyeButtonsForTarget(id, true); return; }

            const anyVisible = allColl.some(o => o.visible !== false);
            const newVis = !anyVisible;
            allColl.forEach(o => {
                setMeshAndMaterialsVisibility(o, newVis);
                syncEyeIconsForObject(o.uuid, newVis);
            });
            perFileIds.forEach((_, perId) => updateEyeButtonsForTarget(perId, newVis));
            updateEyeButtonsForTarget(id, newVis);
            return;
        }

        // Группа коллизий внутри конкретного FBX
        if (id.startsWith('colgrp|')) {
            const fileUuid = id.slice(7);
            let root = null;
            world.traverse(o => { if (!root && o.uuid === fileUuid) root = o; });
            if (!root) return;
            const coll = [];
            root.traverse(o => { if (o.isMesh && o.userData?.isCollision) coll.push(o); });
            const anyVisible = coll.some(o => o.visible !== false);
            const newVis = !anyVisible;
            coll.forEach(o => {
                setMeshAndMaterialsVisibility(o, newVis);
                syncEyeIconsForObject(o.uuid, newVis);
            });
            updateEyeButtonsForTarget(id, newVis);

            const hostModel = loadedModels.find(m => m.obj?.uuid === fileUuid);
            if (hostModel?.group) {
                const groupName = hostModel.group;
                let groupHasAny = false;
                let groupHasVisible = false;
                loadedModels.forEach(m => {
                    if (m.group !== groupName || !m.obj) return;
                    m.obj.traverse(o => {
                        if (!o.isMesh || !o.userData?.isCollision) return;
                        groupHasAny = true;
                        if (o.visible !== false) groupHasVisible = true;
                    });
                });
                if (groupHasAny) updateEyeButtonsForTarget(`zipcoll|${groupName}`, groupHasVisible);
            }
            return;
        }

        // Обычный объект: ищем по userData._panelId
        let target = null;
        world.traverse(o => { if ((o.userData?._panelId) === id) target = o; });
        if (!target) return;

        if (target.userData?._panelKind === 'file-root') {
            const renderables = [];
            target.traverse(o => {
                if (o === target) return;
                if (o.userData?.isCollision) return;
                if (o.isMesh || o.isLine || o.isPoints) renderables.push(o);
            });
            if (!renderables.length) {
                setEyeIcon(el, true);
                return;
            }
            const anyVisible = renderables.some(o => o.visible !== false);
            const newVisible = !anyVisible;
            renderables.forEach(o => {
                setMeshAndMaterialsVisibility(o, newVisible);
                syncEyeIconsForObject(o.uuid, newVisible);
            });
            setEyeIcon(el, newVisible);
            return;
        }

        const nextVisible = !target.visible;
        setMeshAndMaterialsVisibility(target, nextVisible);
        syncEyeIconsForObject(target.uuid, nextVisible);
        setEyeIcon(el, nextVisible);
    }

    return Object.freeze({
        handleEyeToggle,
        setEyeIcon,
        updateEyeButtonsForTarget,
        setMeshAndMaterialsVisibility,
        toggleObjectVisibility,
        syncEyeIconsForObject,
        toggleVisibilityById,
    });
}

