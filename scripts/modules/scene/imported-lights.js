export function createImportedLightsController(options = {}) {
    const THREE = options.THREE || null;
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const logBind = typeof options.logBind === 'function' ? options.logBind : null;
    const onLightsUpdated = typeof options.onLightsUpdated === 'function' ? options.onLightsUpdated : () => {};

    const LIGHT_HELPER_COLOR = options.lightHelperColor ?? 0xffc107;

    let showLightHelpers = !!options.showLightHelpers;
    let importedLightsEnabled = !!options.importedLightsEnabled;

    const lightDirTmp = THREE ? new THREE.Vector3() : null;
    const lightWorldPos = THREE ? new THREE.Vector3() : null;
    const lightWorldQuat = THREE ? new THREE.Quaternion() : null;
    const targetWorldPos = THREE ? new THREE.Vector3() : null;
    const tempBox = THREE ? new THREE.Box3() : null;
    const tempSize = THREE ? new THREE.Vector3() : null;

    function disableShadowsOnImportedLights(root) {
        if (!root) return;
        let shadowsOff = 0;
        let intensityOff = 0;
        let hidden = 0;

        root.traverse(o => {
            if (!o?.isLight) return;
            if (!o.userData) o.userData = {};

            if ('castShadow' in o && o.castShadow) {
                o.castShadow = false;
                shadowsOff++;
            }

            if ('intensity' in o && o.intensity !== 0) {
                if (o.userData._origIntensity === undefined) {
                    o.userData._origIntensity = o.intensity;
                }
                o.intensity = 0;
                intensityOff++;
            }

            if ('power' in o && o.power !== 0) {
                if (o.userData._origPower === undefined) {
                    o.userData._origPower = o.power;
                }
                o.power = 0;
            }

            if (o.visible) {
                if (o.userData._origVisible === undefined) {
                    o.userData._origVisible = true;
                }
                o.visible = false;
                hidden++;
            }
        });

        if ((shadowsOff || intensityOff || hidden) && logBind) {
            const parts = [];
            if (shadowsOff) parts.push(`тени → ${shadowsOff}`);
            if (intensityOff) parts.push(`intensity=0 → ${intensityOff}`);
            if (hidden) parts.push(`hidden → ${hidden}`);
            logBind(`Lights: ${parts.join(', ')}`, 'info');
        }
    }

    function restoreLightTargetsFromOrientation(root) {
        if (!root || !tempBox || !tempSize || !lightWorldPos || !lightWorldQuat || !lightDirTmp || !targetWorldPos) return;

        root.updateMatrixWorld(true);

        tempBox.setFromObject(root);
        const sceneDiag = tempBox.getSize(tempSize).length();
        const defaultDistance = Number.isFinite(sceneDiag) && sceneDiag > 0.0001
            ? THREE.MathUtils.clamp(sceneDiag * 0.25, 5, 500)
            : 25;

        root.traverse(light => {
            if (!light?.isLight) return;
            const isDirectional = !!light.isDirectionalLight;
            const isSpot = !!light.isSpotLight;
            if (!isDirectional && !isSpot) return;

            const target = light.target || (light.target = new THREE.Object3D());
            const host = target.parent || root;
            if (target.parent !== host) host.add(target);
            host.updateMatrixWorld(true);

            light.getWorldPosition(lightWorldPos);
            light.getWorldQuaternion(lightWorldQuat);

            lightDirTmp.set(0, -1, 0).applyQuaternion(lightWorldQuat).normalize();

            let length = isDirectional ? defaultDistance : light.distance;
            if (!Number.isFinite(length) || length <= 0.01) length = defaultDistance;

            targetWorldPos.copy(lightWorldPos).addScaledVector(lightDirTmp, length);

            host.worldToLocal(targetWorldPos);
            target.position.copy(targetWorldPos);
            target.updateMatrixWorld(true);

            if (light.isSpotLight) {
                light.translateY(-1);
                light.updateMatrix();
                light.updateMatrixWorld(true);
            }
        });
    }

    function ensureLightHelpers(root) {
        if (!root || !THREE) return;

        const box = new THREE.Box3();
        const sizeVec = new THREE.Vector3();
        box.setFromObject(root);
        const diag = box.getSize(sizeVec).length() || 1;
        const baseSize = THREE.MathUtils.clamp(diag * 0.02, 0.25, 10);

        root.updateMatrixWorld(true);

        root.traverse(o => {
            if (!o?.isLight) return;

            let helper = o.userData?._lightHelper || null;
            if (!helper || !helper.parent) {
                helper = null;
                if (o.isDirectionalLight) {
                    helper = new THREE.DirectionalLightHelper(o, baseSize, LIGHT_HELPER_COLOR);
                } else if (o.isPointLight) {
                    helper = new THREE.PointLightHelper(o, baseSize * 0.35, LIGHT_HELPER_COLOR);
                } else if (o.isSpotLight) {
                    helper = new THREE.SpotLightHelper(o, LIGHT_HELPER_COLOR);
                } else if (o.isHemisphereLight) {
                    helper = new THREE.HemisphereLightHelper(o, baseSize * 0.5, LIGHT_HELPER_COLOR);
                } else if (o.isRectAreaLight && typeof THREE.RectAreaLightHelper === 'function') {
                    helper = new THREE.RectAreaLightHelper(o, LIGHT_HELPER_COLOR);
                }

                if (!helper) return;

                helper.userData.excludeFromBounds = true;
                helper.userData.lightHelper = true;
                helper.name = helper.name || `${o.name || o.type}-helper`;

                const host = o.parent || root;
                host.add(helper);
                helper.update?.();

                o.userData ||= {};
                o.userData._lightHelper = helper;
            } else {
                helper.update?.();
            }

            if (o.isSpotLight) {
                const dist = (Number.isFinite(o.distance) && o.distance > 0.01) ? o.distance : 20;
                o.distance = dist;
                helper.cone.scale.set(20, 20, 20);
            }

            helper.visible = showLightHelpers;
        });
    }

    function setLightHelpersVisible(visible) {
        showLightHelpers = !!visible;
        loadedModels.forEach(model => {
            model.obj?.traverse(o => {
                if (o?.userData?._lightHelper) {
                    o.userData._lightHelper.visible = showLightHelpers;
                    o.userData._lightHelper.update?.();
                }
            });
        });
        requestRender();
    }

    function setImportedLightsEnabled(enabled, targetRoot = null, options = {}) {
        const { silent = false } = options || {};
        const roots = targetRoot
            ? (Array.isArray(targetRoot) ? targetRoot : [targetRoot])
            : loadedModels.map(m => m.obj).filter(Boolean);

        let affected = 0;

        roots.forEach(root => {
            if (!root) return;
            root.traverse(o => {
                if (!o?.isLight) return;
                o.userData ||= {};

                if (enabled) {
                    if ('intensity' in o && o.userData._origIntensity !== undefined) {
                        // o.intensity = o.userData._origIntensity;
                        o.intensity = 1000;
                    }
                    if ('power' in o && o.userData._origPower !== undefined) {
                        // o.power = o.userData._origPower;
                        o.power = 1000;
                    }
                    const restoreVisible = o.userData._origVisible;
                    o.visible = restoreVisible !== undefined ? restoreVisible : true;
                } else {
                    if ('intensity' in o) {
                        if (o.userData._origIntensity === undefined) o.userData._origIntensity = o.intensity;
                        o.intensity = 0;
                    }
                    if ('power' in o) {
                        if (o.userData._origPower === undefined) o.userData._origPower = o.power;
                        o.power = 0;
                    }
                    if (o.userData._origVisible === undefined) o.userData._origVisible = o.visible;
                    o.visible = false;
                }

                o.userData._lightEnabled = !!enabled;
                affected++;
            });
        });

        importedLightsEnabled = !!enabled;

        if (!silent && logBind) {
            logBind(`Lights: ${enabled ? 'включены' : 'выключены'} (${affected})`, 'info');
        }
        onLightsUpdated();
        requestRender();
    }

    function getImportedLightsEnabled() {
        return importedLightsEnabled;
    }

    function getLightHelpersVisible() {
        return showLightHelpers;
    }

    function bindUI(options = {}) {
        const lightHelpersBtn = options.lightHelpersBtn || null;
        const lightEmittersBtn = options.lightEmittersBtn || null;

        if (lightHelpersBtn) {
            lightHelpersBtn.addEventListener('click', () => {
                const next = !showLightHelpers;
                setLightHelpersVisible(next);
                lightHelpersBtn.classList.toggle('active', next);
            });
            lightHelpersBtn.classList.toggle('active', showLightHelpers);
        }

        if (lightEmittersBtn) {
            lightEmittersBtn.addEventListener('click', () => {
                const next = !importedLightsEnabled;
                setImportedLightsEnabled(next);
                lightEmittersBtn.classList.toggle('active', next);
            });
            lightEmittersBtn.classList.toggle('active', importedLightsEnabled);
        }
    }

    return {
        disableShadowsOnImportedLights,
        restoreLightTargetsFromOrientation,
        ensureLightHelpers,
        setLightHelpersVisible,
        getLightHelpersVisible,
        setImportedLightsEnabled,
        getImportedLightsEnabled,
        bindUI,
    };
}
