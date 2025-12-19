import { createEnvironmentManager } from './environment-manager.js';

export function createEnvironmentWiring(options = {}) {
    const environmentManager = createEnvironmentManager(options);

    function setEnvironmentRotation(deg) {
        environmentManager.setRotation(deg);
    }

    function requestEnvironmentRebuild({ immediate = false } = {}) {
        environmentManager.requestRebuild({ immediate });
    }

    async function loadHDRBase() {
        return environmentManager.loadHDRBase();
    }

    function syncEnvAdjustmentsState() {
        return environmentManager.syncAdjustmentsState();
    }

    async function buildAndApplyEnvFromRotation(deg) {
        await environmentManager.buildAndApplyFromRotation(deg);
    }

    async function setEnvironmentEnabled(on) {
        await environmentManager.setEnabled(on);
    }

    function applyEnvToMaterials(env, intensity) {
        environmentManager.applyEnvToMaterials(env, intensity);
    }

    function getCurrentEnv() {
        return environmentManager.getCurrentEnv();
    }

    function getCurrentBg() {
        return environmentManager.getCurrentBg();
    }

    function selectPresetIndex(idx) {
        return environmentManager.selectPresetIndex(idx);
    }

    return Object.freeze({
        environmentManager,
        setEnvironmentRotation,
        requestEnvironmentRebuild,
        loadHDRBase,
        syncEnvAdjustmentsState,
        buildAndApplyEnvFromRotation,
        setEnvironmentEnabled,
        applyEnvToMaterials,
        getCurrentEnv,
        getCurrentBg,
        selectPresetIndex,
    });
}

