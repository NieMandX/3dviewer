import { addCheck, mapSeverityToCheckStatus } from './utils.js';

function getThresholdSeverity(value, warnThreshold, errorThreshold) {
    if (value >= errorThreshold) return 'error';
    if (value >= warnThreshold) return 'warn';
    return 'pass';
}

function addThresholdCheck(checks, value, title, unitLabel, warnThreshold, errorThreshold) {
    const severity = getThresholdSeverity(value, warnThreshold, errorThreshold);
    addCheck(
        checks,
        mapSeverityToCheckStatus(severity),
        title,
        `${value.toLocaleString('ru-RU')} ${unitLabel}`,
        [
            `Порог warn: ${warnThreshold.toLocaleString('ru-RU')}`,
            `Порог fail: ${errorThreshold.toLocaleString('ru-RU')}`,
        ]
    );
}

export function buildDefaultModelChecks({ analysis, limits }) {
    const checks = [];
    const totals = analysis?.totals || {};
    const models = Array.isArray(analysis?.models) ? analysis.models : [];

    addThresholdCheck(
        checks,
        totals.triangles || 0,
        'Треугольники сцены',
        'трис.',
        limits.trianglesWarn,
        limits.trianglesError
    );
    addThresholdCheck(
        checks,
        totals.drawCalls || 0,
        'Оценка draw calls',
        'вызовов',
        limits.drawCallsWarn,
        limits.drawCallsError
    );
    addThresholdCheck(
        checks,
        totals.meshes || 0,
        'Количество мешей',
        'мешей',
        limits.meshesWarn,
        limits.meshesError
    );
    addThresholdCheck(
        checks,
        totals.materials || 0,
        'Уникальные материалы',
        'материалов',
        limits.materialsWarn,
        limits.materialsError
    );
    addThresholdCheck(
        checks,
        totals.textures || 0,
        'Уникальные текстуры',
        'текстур',
        limits.texturesWarn,
        limits.texturesError
    );

    const maxTextureEdge = totals.maxTextureEdge || 0;
    if (maxTextureEdge > 0) {
        const textureSeverity = getThresholdSeverity(
            maxTextureEdge,
            limits.textureSizeWarn,
            limits.textureSizeError
        );
        addCheck(
            checks,
            mapSeverityToCheckStatus(textureSeverity),
            'Максимальный размер текстуры',
            `${maxTextureEdge}px`,
            [
                `Файл: ${totals.maxTextureName || '—'}`,
                `Модель: ${totals.maxTextureOwner || '—'}`,
                `Порог warn: ${limits.textureSizeWarn}px`,
                `Порог fail: ${limits.textureSizeError}px`,
            ]
        );
    }

    if ((totals.uvMissing || 0) > 0) {
        addCheck(
            checks,
            'warn',
            'UV-координаты',
            `${totals.uvMissing.toLocaleString('ru-RU')} мешей с текстурами без UV`,
            ['Проверьте развертку UV перед экспортом.']
        );
    } else {
        addCheck(checks, 'pass', 'UV-координаты', 'Проблем не найдено');
    }

    if ((totals.badTransforms || 0) > 0) {
        addCheck(
            checks,
            'fail',
            'Transform валидность',
            `${totals.badTransforms.toLocaleString('ru-RU')} мешей с NaN/Inf`,
            ['Нужно очистить transform перед экспортом.']
        );
    } else {
        addCheck(checks, 'pass', 'Transform валидность', 'Проблем не найдено');
    }

    const severeModels = models
        .filter((model) => model.status !== 'pass')
        .map((model) => `${model.name}: ${model.status === 'error' ? 'fail' : 'warn'}`);
    if (severeModels.length) {
        const hasFail = severeModels.some((value) => value.includes('fail'));
        addCheck(
            checks,
            hasFail ? 'fail' : 'warn',
            'Проблемные модели',
            `${severeModels.length.toLocaleString('ru-RU')} шт.`,
            severeModels.slice(0, 10)
        );
    } else {
        addCheck(checks, 'pass', 'Проблемные модели', 'Критичных проблем не найдено');
    }

    return checks;
}
