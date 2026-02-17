import { analyzeLoadedModels } from './model-checks-core/analyze-models.js';
import { buildDefaultModelChecks } from './model-checks-core/check-rules.js';
import { buildModelCheckLimits } from './model-checks-core/limits.js';
import { isValidCheck } from './model-checks-core/utils.js';

function normalizeRuleList(extraRules) {
    if (!Array.isArray(extraRules)) return [];
    return extraRules.filter((rule) => typeof rule === 'function');
}

function runExtraRules(extraRules, context, checks) {
    extraRules.forEach((rule) => {
        try {
            const result = rule(context);
            if (Array.isArray(result)) {
                result.forEach((item) => {
                    if (isValidCheck(item)) checks.push(item);
                });
                return;
            }
            if (isValidCheck(result)) {
                checks.push(result);
            }
        } catch (err) {
            console.warn('Model check rule failed', err);
        }
    });
}

export function createModelChecksRunner(options = {}) {
    const THREE = options.THREE || null;
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];
    const limits = buildModelCheckLimits(options.limits);
    const extraRules = normalizeRuleList(options.extraRules);

    function run() {
        const analysis = analyzeLoadedModels({ THREE, loadedModels, limits });
        const checks = buildDefaultModelChecks({ analysis, limits });

        if (extraRules.length) {
            runExtraRules(
                extraRules,
                Object.freeze({
                    THREE,
                    loadedModels,
                    limits,
                    analysis,
                }),
                checks
            );
        }

        const errors = checks.filter((item) => item.status === 'fail').length;
        const warnings = checks.filter((item) => item.status === 'warn').length;
        const passes = checks.filter((item) => item.status === 'pass').length;

        return {
            generatedAt: new Date().toISOString(),
            summary: {
                models: analysis.models.length,
                triangles: analysis.totals.triangles,
                meshes: analysis.totals.meshes,
                drawCalls: analysis.totals.drawCalls,
                materials: analysis.totals.materials,
                textures: analysis.totals.textures,
                warnings,
                errors,
                passes,
            },
            checks,
            models: analysis.models,
            issues: analysis.issues,
            limits,
        };
    }

    return Object.freeze({
        run,
        limits,
    });
}
