import { analyzeLoadedModels } from './model-checks-core/analyze-models.js';
import { buildDefaultModelChecks } from './model-checks-core/check-rules.js';
import { buildModelCheckLimits } from './model-checks-core/limits.js';
import { runNamingStructureChecksRule } from './model-checks-core/rules-naming-structure.js';
import { isValidCheck } from './model-checks-core/utils.js';

const CHECK_SECTION_CONFIGS = Object.freeze([
    Object.freeze({
        key: 'npm',
        type: 'NPM',
        title: 'НПМ',
        emptyMessage: 'Низкополигональная модель отсутствует',
    }),
    Object.freeze({
        key: 'vpm',
        type: 'VPM',
        title: 'ВПМ',
        emptyMessage: 'Высокополигональная модель отсутствует',
    }),
]);

function normalizeRuleList(extraRules) {
    if (!Array.isArray(extraRules)) return [];
    return extraRules.filter((rule) => typeof rule === 'function');
}

function normalizeModelType(model) {
    const zipKind = String(model?.zipKind || '').trim().toUpperCase();
    if (zipKind === 'NPM') return 'NPM';
    if (zipKind === 'SM' || zipKind === 'VPM') return 'VPM';
    return 'VPM';
}

function getSectionModels(loadedModels, sectionType) {
    if (!Array.isArray(loadedModels) || !loadedModels.length) return [];
    return loadedModels.filter((model) => normalizeModelType(model) === sectionType);
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

function buildSectionReport({
    THREE,
    loadedModels,
    limits,
    allRules,
    config,
}) {
    const sectionModels = getSectionModels(loadedModels, config.type);
    const present = sectionModels.length > 0;

    if (!present) {
        return {
            key: config.key,
            type: config.type,
            title: config.title,
            present: false,
            emptyMessage: config.emptyMessage,
            summary: {
                models: 0,
                triangles: 0,
                meshes: 0,
                drawCalls: 0,
                materials: 0,
                textures: 0,
                warnings: 0,
                errors: 0,
                passes: 0,
            },
            checks: [],
            models: [],
            issues: [],
        };
    }

    const analysis = analyzeLoadedModels({ THREE, loadedModels: sectionModels, limits });
    const checks = buildDefaultModelChecks({ analysis, limits });

    if (allRules.length) {
        runExtraRules(
            allRules,
            Object.freeze({
                THREE,
                loadedModels: sectionModels,
                limits,
                analysis,
                sectionType: config.type,
            }),
            checks
        );
    }

    const errors = checks.filter((item) => item.status === 'fail').length;
    const warnings = checks.filter((item) => item.status === 'warn').length;
    const passes = checks.filter((item) => item.status === 'pass').length;

    return {
        key: config.key,
        type: config.type,
        title: config.title,
        present: true,
        emptyMessage: '',
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
    };
}

export function createModelChecksRunner(options = {}) {
    const THREE = options.THREE || null;
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];
    const limits = buildModelCheckLimits(options.limits);
    const extraRules = normalizeRuleList(options.extraRules);
    const useBuiltinRules = options.useBuiltinRules !== false;
    const builtinRules = useBuiltinRules ? [runNamingStructureChecksRule] : [];

    function run() {
        const allRules = [...builtinRules, ...extraRules];
        const sections = CHECK_SECTION_CONFIGS.map((config) => buildSectionReport({
            THREE,
            loadedModels,
            limits,
            allRules,
            config,
        }));

        const checks = sections.flatMap((section) => section.checks || []);
        const models = sections.flatMap((section) => section.models || []);
        const issues = sections.flatMap((section) => section.issues || []);
        const summary = sections.reduce((acc, section) => {
            const sectionSummary = section?.summary || {};
            acc.models += sectionSummary.models || 0;
            acc.triangles += sectionSummary.triangles || 0;
            acc.meshes += sectionSummary.meshes || 0;
            acc.drawCalls += sectionSummary.drawCalls || 0;
            acc.materials += sectionSummary.materials || 0;
            acc.textures += sectionSummary.textures || 0;
            acc.warnings += sectionSummary.warnings || 0;
            acc.errors += sectionSummary.errors || 0;
            acc.passes += sectionSummary.passes || 0;
            return acc;
        }, {
            models: 0,
            triangles: 0,
            meshes: 0,
            drawCalls: 0,
            materials: 0,
            textures: 0,
            warnings: 0,
            errors: 0,
            passes: 0,
        });

        return {
            generatedAt: new Date().toISOString(),
            summary,
            checks,
            models,
            issues,
            sections,
            limits,
        };
    }

    return Object.freeze({
        run,
        limits,
    });
}
