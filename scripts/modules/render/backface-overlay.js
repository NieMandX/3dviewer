export function createBackfaceOverlayController(options = {}) {
    const THREE = options.THREE || null;
    const world = options.world || null;
    const useWebGPU = !!options.useWebGPU;
    const backfaceNodeSupport = options.backfaceNodeSupport || null;

    /**
     * Создаёт ShaderMaterial, повторяющий fresnel-подсветку из WebGL-варианта,
     * но без onBeforeCompile, чтобы одинаково работать и в WebGPU, и в WebGL.
     */
    function makeViewAngleShadedBasic(params = {}, { power = 2.0, min = 1.4, max = 2.0, invert = false } = {}) {
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

        if (useWebGPU && backfaceNodeSupport) {
            const {
                MeshBasicNodeMaterial,
                normalView,
                positionViewDirection,
                floatNode,
                vec3Node,
            } = backfaceNodeSupport;

            try {
                const nodeParams = {
                    side,
                    transparent,
                    depthWrite,
                    depthTest,
                    blending,
                    polygonOffset,
                    polygonOffsetFactor,
                    polygonOffsetUnits,
                    alphaTest,
                    vertexColors,
                };
                if (alphaMap && alphaMap.isTexture) nodeParams.alphaMap = alphaMap;

                const material = new MeshBasicNodeMaterial(nodeParams);
                material.name = params.name || 'ViewAngleBackface';
                material.opacity = opacity;
                material.toneMapped = false;
                material.fog = true;
                material.color.copy(baseColor);
                material.polygonOffset = polygonOffset;
                material.polygonOffsetFactor = polygonOffsetFactor;
                material.polygonOffsetUnits = polygonOffsetUnits;
                material.vertexColors = !!vertexColors;

                if (alphaMap && alphaMap.isTexture) {
                    alphaMap.colorSpace = THREE.LinearSRGBColorSpace;
                    material.alphaMap = alphaMap;
                }

                const normalNode = normalView.normalize();
                const viewDirNode = positionViewDirection;
                const ndv = normalNode.dot(viewDirNode).abs().clamp();
                const fresBase = floatNode(1.0).sub(ndv).max(floatNode(1e-5));
                const fres = fresBase.pow(floatNode(power));
                const tNode = invert ? floatNode(1.0).sub(fres) : fres;
                const fresFactor = floatNode(min).mix(floatNode(max), tNode.clamp());
                const colorNode = vec3Node(baseColor.r, baseColor.g, baseColor.b).mul(fresFactor);

                material.colorNode = colorNode;
                material.opacityNode = floatNode(opacity);
                material.needsUpdate = true;
                return material;
            } catch (err) {
                console.warn('Backface node material build failed', err);
            }
        }

        if (useWebGPU) {
            const mat = new THREE.MeshBasicMaterial({
                color: baseColor,
                side,
                transparent,
                opacity,
                alphaMap,
                alphaTest,
                depthWrite,
                depthTest,
                blending,
            });
            mat.polygonOffset = polygonOffset;
            mat.polygonOffsetFactor = polygonOffsetFactor;
            mat.polygonOffsetUnits = polygonOffsetUnits;
            mat.skinning = !!skinning;
            mat.morphTargets = !!morphTargets;
            mat.morphNormals = !!morphNormals;
            mat.morphColors = !!morphColors;
            mat.vertexColors = !!vertexColors;
            mat.needsUpdate = true;
            return mat;
        }

        const baseLib = THREE.ShaderLib?.basic;
        if (!baseLib) {
            console.warn('ShaderLib.basic отсутствует, backface fallback');
            return new THREE.MeshBasicMaterial({
                color: baseColor,
                side,
                transparent,
                opacity,
                alphaMap,
                alphaTest,
                depthWrite,
                depthTest,
                blending,
            });
        }
        const uniforms = THREE.UniformsUtils.clone(baseLib.uniforms);

        uniforms.diffuse.value.copy(baseColor);
        uniforms.opacity.value = opacity;
        uniforms.uPower = { value: power };
        uniforms.uMin = { value: min };
        uniforms.uMax = { value: max };
        uniforms.uInvert = { value: invert ? 1 : 0 };

        if (alphaMap && alphaMap.isTexture) {
            uniforms.alphaMap.value = alphaMap;
            alphaMap.colorSpace = THREE.LinearSRGBColorSpace;
            if (alphaMap.matrix) {
                uniforms.alphaMapTransform.value.copy(alphaMap.matrix);
            }
        }

        const vertexShader = baseLib.vertexShader
            .replace(
                '#include <fog_pars_vertex>',
                '#include <fog_pars_vertex>\\nvarying vec3 vViewDir;\\nvarying vec3 vPosView;'
            )
            .replace(
                '#include <project_vertex>',
                '#include <project_vertex>\\n\\tvViewDir = -mvPosition.xyz;\\n\\tvPosView = mvPosition.xyz;'
            );

        const fragmentShader = baseLib.fragmentShader
            .replace(
                'uniform float opacity;',
                'uniform float opacity;\\nuniform float uPower;\\nuniform float uMin;\\nuniform float uMax;\\nuniform int uInvert;\\nvarying vec3 vViewDir;\\nvarying vec3 vPosView;'
            )
            .replace(
                'vec4 diffuseColor = vec4( diffuse, opacity );',
                `vec4 diffuseColor = vec4( diffuse, opacity );
    vec3 viewDir = normalize( vViewDir );
    vec3 normalDir = normalize( cross( dFdx( vPosView ), dFdy( vPosView ) ) );
    normalDir *= ( gl_FrontFacing ? 1.0 : -1.0 );
    float ndv = clamp( abs( dot( normalDir, viewDir ) ), 0.0, 1.0 );
    float fres = pow( max( 1.0 - ndv, 1e-5 ), uPower );
    float t = ( uInvert == 1 ) ? ( 1.0 - fres ) : fres;
    float fresFactor = mix( uMin, uMax, clamp( t, 0.0, 1.0 ) );
    diffuseColor.rgb *= fresFactor;`
            );

        const material = new THREE.ShaderMaterial({
            uniforms,
            vertexShader,
            fragmentShader,
            side,
            transparent,
            depthWrite,
            depthTest,
            blending,
        });

        if (alphaMap && alphaMap.isTexture) {
            material.defines = {
                ...(material.defines || {}),
                USE_ALPHAMAP: '',
                USE_UV: '',
                ALPHAMAP_UV: 'vUv',
            };
        }

        material.extensions = { ...(material.extensions || {}), derivatives: true };
        material.name = params.name || 'ViewAngleBackface';
        material.alphaTest = alphaTest;
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
        material.uniformsNeedUpdate = true;
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

        // FRONT: белый + угловое затенение (рим-подсветка к краям)
        if (!mesh.userData._bfFront) {
            const front = makeViewAngleShadedBasic(
                { ...baseParams, side: THREE.FrontSide, color: 0xffffff },
                { power: 1.2, min: 0.55, max: 1.2, invert: true } // ярче на гранях
            );
            mesh.userData._bfFront = front;
        }

        // BACK: красный + тоже угловое (можно чуть сильнее)
        if (!mesh.userData._bfBack) {
            const back = makeViewAngleShadedBasic(
                { ...baseParams, side: THREE.BackSide, color: 0xff3333 },
                { power: 1.2, min: 0.55, max: 1.0, invert: false }
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

