export function createTextureLabelResolver(options = {}) {
    const getEntries = typeof options.getEntries === 'function' ? options.getEntries : () => [];

    function findTexEntryByURL(url) {
        return (getEntries() || []).find(e => e && e.url === url) || null;
    }

    function labelFromURL(url) {
        const e = findTexEntryByURL(url);
        // отдаём настоящее имя файла (full или short), иначе хоть basename(url)
        const s = e?.full || e?.short || '';
        if (s) return s.split(/[\\/]/).pop();
        // blob: ссылки имён не содержат — вернём хоть последний сегмент
        try {
            const u = new URL(url);
            return u.pathname.split('/').pop() || '(texture)';
        } catch {
            return '(texture)';
        }
    }

    return {
        findTexEntryByURL,
        labelFromURL,
    };
}

