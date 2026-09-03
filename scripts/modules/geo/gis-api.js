export function normalizeGisApiBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/$/, '');
    } catch (_) {
        return '';
    }
}

export function createGisApiUrl(baseUrl, path) {
    const base = normalizeGisApiBaseUrl(baseUrl);
    if (!base) throw new Error('Сервис 2ГИС не настроен.');
    return new URL(String(path || '').replace(/^\//, ''), `${base}/`);
}

export function getGisProxyError(response, fallback = '2ГИС: ошибка запроса.') {
    if (response?.status === 429) return '2ГИС: слишком много запросов. Повторите позже.';
    if (response?.status === 503) return '2ГИС: API-ключ не настроен администратором.';
    if (response?.status === 401 || response?.status === 403) {
        return '2ГИС: API-ключ отклонён. Проверьте лицензию для Places API и Raster Tiles API.';
    }
    return fallback;
}
