export function createBackfaceOverlayController(options = {}) {
    const THREE = options.THREE || null;
    const world = options.world || null;

    /**
     * Унифицированный материал для режима Backface (white/red).
     * Используем Lambert, чтобы вернуть мягкие полутона без кастомных шейдеров.
     */
    function makeViewAngleShadedBasic(params = {}) {
        if (!THREE) return null;
        const {
            color = 0xffffff,
            side = THREE.FrontSide,
            transparent = false,
            opacity = 1.0,
            alphaMap = null,
            alphaTest = 0.0,
            depthWrite = true,
            depthTest = true,
            blending = THREE.NormalBlending,
            polygonOffset = false,
            polygonOffsetFactor = 0,
            polygonOffsetUnits = 0,
            skinning = false,
            morphTargets = false,
            morphNormals = false,
            morphColors = false,
            vertexColors = false,
        } = params;

        const baseColor = (params.color && params.color.isColor)
            ? params.color.clone()
            : new THREE.Color(color);
        const emissiveColor = baseColor.clone().multiplyScalar(0.06);

        const material = new THREE.MeshLambertMaterial({
            color: baseColor,
            emissive: emissiveColor,
            side,
            transparent,
            opacity,
            alphaMap,
            alphaTest,
            depthWrite,
            depthTest,
            blending,
        });
        material.name = params.name || 'BackfaceBasic';
        material.toneMapped = false;
        material.fog = true;
        material.polygonOffset = polygonOffset;
        material.polygonOffsetFactor = polygonOffsetFactor;
        material.polygonOffsetUnits = polygonOffsetUnits;
        material.skinning = !!skinning;
        material.morphTargets = !!morphTargets;
        material.morphNormals = !!morphNormals;
        material.morphColors = !!morphColors;
        material.vertexColors = !!vertexColors;
        material.flatShading = false;
        if (alphaMap && alphaMap.isTexture) {
            alphaMap.colorSpace = THREE.LinearSRGBColorSpace;
        }
        material.needsUpdate = true;
        return material;
    }

    function ensureBackfaceOverlay(mesh, origMat) {
        if (!THREE) return;
        if (!mesh?.isMesh || !mesh.geometry) return;
        if (mesh.userData?._isBackfaceOverlay) return;
        if (!origMat) origMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;

        if (!mesh.userData._origMaterial) mesh.userData._origMaterial = mesh.material;

        // Общие параметры (уважаем альфу исходника)
        const baseParams = {
            transparent: !!(origMat.transparent || origMat.alphaMap),
            opacity: origMat.opacity ?? 1,
            alphaMap: origMat.alphaMap || null,
            alphaTest: (origMat.alphaMap ? (origMat.alphaTest ?? 0.5) : (origMat.alphaTest ?? 0.0)),
            depthWrite: origMat.depthWrite ?? true,
            depthTest: origMat.depthTest ?? true,
            blending: origMat.blending ?? THREE.NormalBlending,
            polygonOffset: !!origMat.polygonOffset,
            polygonOffsetFactor: origMat.polygonOffsetFactor ?? 0,
            polygonOffsetUnits: origMat.polygonOffsetUnits ?? 0,
            skinning: !!origMat.skinning,
            morphTargets: !!origMat.morphTargets,
            morphNormals: !!origMat.morphNormals,
            morphColors: !!origMat.morphColors,
            vertexColors: !!origMat.vertexColors,
        };

        // FRONT: белый
        if (!mesh.userData._bfFront) {
            const front = makeViewAngleShadedBasic(
                { ...baseParams, side: THREE.FrontSide, color: 0xf5f5f5 }
            );
            mesh.userData._bfFront = front;
        }

        // BACK: красный
        if (!mesh.userData._bfBack) {
            const back = makeViewAngleShadedBasic(
                { ...baseParams, side: THREE.BackSide, color: 0xff3333 }
            );
            mesh.userData._bfBack = back;
        }

        // применяем
        mesh.material = mesh.userData._bfFront;

        if (!mesh.userData._bfChild) {
            const child = new THREE.Mesh(mesh.geometry, mesh.userData._bfBack);
            child.renderOrder = (mesh.renderOrder || 0);
            child.userData.excludeFromBounds = true;
            child.userData._isBackfaceOverlay = true;
            mesh.add(child);
            mesh.userData._bfChild = child;
        } else {
            mesh.userData._bfChild.visible = true;
        }
    }

    function removeBackfaceOverlay(mesh) {
        if (!mesh?.isMesh) return;
        if (mesh.userData?._isBackfaceOverlay) return; // служебный — пропускаем
        // вернуть оригинальный материал
        if (mesh.userData?._origMaterial) {
            mesh.material = mesh.userData._origMaterial;
        }
        // убрать/спрятать ребёнка
        if (mesh.userData?._bfChild) {
            if (mesh.userData._bfChild.parent) mesh.userData._bfChild.parent.remove(mesh.userData._bfChild);
            mesh.userData._bfChild = null;
        }
        // кэшированные материалы оставим (переиспользуем при повторном включении)
    }

    function setBackfaceMode(on) {
        // Сначала собираем список целевых мешей (не служебных), чтобы
        // не модифицировать дерево прямо во время обхода
        const targets = [];
        world?.traverse?.(o => {
            if (!o.isMesh) return;
            if (o.userData?._isBackfaceOverlay) return;
            targets.push(o);
        });

        if (on) {
            targets.forEach(m => {
                if (m.userData?.isCollision) return;
                ensureBackfaceOverlay(m, Array.isArray(m.material) ? m.material[0] : m.material);
            });
        } else {
            targets.forEach(removeBackfaceOverlay);
        }
    }

    return {
        setBackfaceMode,
        ensureBackfaceOverlay,
        removeBackfaceOverlay,
    };
}
