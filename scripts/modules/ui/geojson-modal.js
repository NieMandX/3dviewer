export function createGeoJsonModalController(options = {}) {
    const documentRef =
        options.document || (typeof document !== 'undefined' ? document : null);

    function ensureModal() {
        if (!documentRef) return null;
        let geoModal = documentRef.getElementById('geoModal');
        if (!geoModal) {
            geoModal = documentRef.createElement('div');
            geoModal.id = 'geoModal';
            geoModal.className = 'modal';
            geoModal.innerHTML = `
            <div class="sheet sheet-geo">
                <div class="head">
                    <div class="row head-line">
                        <b id="geoTitle"></b>
                        <span class="muted" id="geoInfo"></span>
                    </div>
                    <button id="geoClose" class="btn" title="Закрыть">×</button>
                </div>
                <div class="sheet-body">
                    <pre id="geoPre"></pre>
                    <div class="row geo-actions">
                        <a id="geoDl" class="btn" download>Скачать GeoJSON</a>
                    </div>
                </div>
            </div>
            `;
            documentRef.body.appendChild(geoModal);

            geoModal
                .querySelector('#geoClose')
                .addEventListener('click', () => geoModal.classList.remove('show'));
            geoModal.addEventListener('click', (e) => {
                if (e.target === geoModal) geoModal.classList.remove('show');
            });
        }
        return geoModal;
    }

    function open(meta, title = 'GeoJSON') {
        const geoModal = ensureModal();
        if (!geoModal) return;

        const pre = geoModal.querySelector('#geoPre');
        const header = geoModal.querySelector('#geoTitle');
        const info = geoModal.querySelector('#geoInfo');
        const dl = geoModal.querySelector('#geoDl');

        if (header) header.textContent = title;

        const entryName = meta?.entryName || '';
        const featureCount = meta?.featureCount;
        const featuresSuffix = Number.isFinite(featureCount) ? ` · features: ${featureCount}` : '';
        if (info) {
            info.textContent = entryName ? ` · ${entryName}${featuresSuffix}` : '';
        }

        if (dl) {
            dl.href = meta?.url || '#';
            if (entryName) dl.download = entryName;
        }

        const pretty = meta?.parsed ? JSON.stringify(meta.parsed, null, 2) : (meta?.text || '');
        if (pre) pre.textContent = pretty;

        geoModal.classList.add('show');
    }

    return {
        open,
    };
}

