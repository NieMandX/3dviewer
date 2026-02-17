export const DEFAULT_MODEL_CHECK_LIMITS = Object.freeze({
    trianglesWarn: 2_000_000,
    trianglesError: 5_000_000,
    drawCallsWarn: 2_000,
    drawCallsError: 4_000,
    meshesWarn: 1_500,
    meshesError: 3_000,
    materialsWarn: 300,
    materialsError: 700,
    texturesWarn: 250,
    texturesError: 500,
    modelTrianglesWarn: 900_000,
    modelTrianglesError: 1_800_000,
    boundsWarn: 8_000,
    boundsError: 20_000,
    textureSizeWarn: 4096,
    textureSizeError: 8192,
});

export function buildModelCheckLimits(overrides = null) {
    return Object.freeze({
        ...DEFAULT_MODEL_CHECK_LIMITS,
        ...(overrides || {}),
    });
}
