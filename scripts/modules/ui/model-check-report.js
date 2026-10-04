// Presentation only: keep the vendor result, source names and rule references intact.
export const CHECK_STATES = { failed: 'С ошибками', warning: 'С рекомендациями', not_checked: 'Не проверено', passed: 'Пройдено' };
export function checkerName(report) {
    return report?.checker_product?.id === 'agr_vision_model_check'
        ? `AGR Vision Model Check ${String(report.checker_product.version || '').slice(0, 32)}`
        : `AGR Checker ${report?.checker_version || '1.6.1'}`;
}
const TITLES = {
    'Glass opacity 50%': 'Непрозрачность стекла — 50%',
    'Glass без текстур': 'Стекло без текстур',
    'Glass разделен по ОКС': 'Стекло разделено по объектам капитального строительства',
    'Main и Glass вместе': 'Основная геометрия (Main) и стекло (Glass) вместе',
    'Вес текстур <= 3мб': 'Размер файлов текстур — до 3 МБ',
    'Color attributes': 'Цветовые атрибуты вершин',
    'Неразвернутые полигоны': 'Полигоны без UV-развёртки',
    'Количество UV-разверток': 'Количество UV-развёрток',
    'Дубликаты и изолированные': 'Дублирующиеся и изолированные элементы',
    'Не длинее 254': 'Длина имени — не более 254 символов',
    'Adress по буклету': 'Адрес соответствует буклету АГР',
    'Вариаты через запятую': 'Варианты значений разделены запятыми',
    'Наименованиия FBX, GEOJSON и ZIP-архивов': 'Имена FBX, GeoJSON и ZIP-архивов',
    'Наменования объектов': 'Имена объектов',
    'Glass единый объект': 'Стекло объединено в один объект',
    'Pivot в центре по XY': 'Точка отсчёта в центре по XY',
    'Pivot в проектном нуле по Z': 'Точка отсчёта в проектном нуле по Z',
    'Pivot всех объектов FBX в одной точке': 'Общая точка отсчёта объектов FBX',
    'Normal API DirectX': 'Карта нормалей в формате DirectX',
};
export function checkTitle(item) {
    const profile = { NPM: 'НПМ', VPM: 'ВПМ', SM: 'ВПМ' }[item.profile] || item.profile || '';
    const name = String(item.name || 'Пункт требований').trim();
    return [profile, item.requirement_ref || '—', TITLES[name] || name].filter(Boolean).join(' · ');
}
export function checkDetailsText(item) {
    return [item.errors_text, item.recommendations_text].filter(Boolean).join('\n');
}
export function checkIdentifiers(item) {
    const names = new Set();
    // Extract only explicit identifiers from known message formats. These are
    // copy aids, not inferred links to the normalized/rendered scene.
    for (const line of checkDetailsText(item).split(/\r?\n/)) {
        const text = line.trimStart();
        const match = text.match(/^-->(.+?), должно быть(?:\s|$)/)
            || text.match(/^((?:T_|M_|SM_|UCX_).+?)(?::\s| - )/);
        if (match && match[1].length <= 1024) names.add(match[1]);
        if (names.size >= 50) break;
    }
    return [...names];
}
export function reportText(job) {
    const report = job.report || {};
    const lines = ['Проверка исходного ZIP', String(job.source_name || ''),
        `${checkerName(report)} · требования от 18.08.2026`,
        `Дата проверки: ${job.finished_at || '—'}`,
        'Завершение проверки не подтверждает приёмку проекта. Непроверенные пункты требуют отдельной проверки.'];
    if (job.source_current === false) lines.push('ВНИМАНИЕ: исходный архив изменён. Это отчёт предыдущей версии.');
    if (job.local_report) lines.push('Открыт сохранённый отчёт. Его актуальность для модели в комнате не проверялась.');
    if (job.engine_current === false) lines.push('ВНИМАНИЕ: обработчик изменён или отключён. Для актуального результата нужна новая проверка.');
    lines.push('', ...Object.entries(CHECK_STATES).map(([state, label]) => `${label}: ${Number(report.summary?.[state]) || 0}`));
    for (const [state, label] of Object.entries(CHECK_STATES)) {
        const checks = (report.checks || []).filter(item => item.status === state);
        if (!checks.length) continue;
        lines.push('', label.toUpperCase());
        for (const item of checks) lines.push('', checkTitle(item), checkDetailsText(item) || label);
    }
    const supplement = report.geojson_supplement;
    if (supplement && supplement.status !== 'not_applicable') {
        lines.push('', 'Дополнительные проверки GeoJSON', `Состояние: ${supplement.status === 'completed' ? 'завершены' : 'не завершены'}`);
        for (const file of supplement.files || []) {
            lines.push('', String(file.archive_entry || ''));
            for (const issue of file.issues || []) lines.push(`${issue.severity}: ${issue.path}\n${issue.message}\n${issue.source?.clause || ''}`);
            lines.push(...(file.limitations || []));
        }
    }
    lines.push('', 'Исходный файл и версия проверки', `SHA-256: ${job.source_sha256 || report.source_sha256 || '—'}`,
        `Обработчик: ${job.engine_revision || '—'}`, `Blender: ${report.blender_version || '—'}`,
        'Проверены исходные файлы. Настройки отображения во Viewer на отчёт не влияют.');
    return lines.join('\n');
}
