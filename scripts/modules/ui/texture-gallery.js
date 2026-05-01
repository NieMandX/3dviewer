export function createTextureGalleryController(options = {}) {
    const galleryEl = options.galleryEl || null;
    const texCountEl = options.texCountEl || null;
    const basename = typeof options.basename === 'function' ? options.basename : (p) => (p || '').split(/[\\/]/).pop();
    const guessKindFromName = typeof options.guessKindFromName === 'function' ? options.guessKindFromName : () => '';
    const onOpen = typeof options.onOpen === 'function' ? options.onOpen : () => {};

    let renderedCount = 0;
    let renderedKeys = [];
    let renderGeneration = 0;
    let spacerEl = null;
    let disposed = false;

    function entryKey(entry) {
        return [
            entry?.url || '',
            entry?.short || '',
            entry?.full || '',
            entry?.fileName || '',
            entry?.mime || '',
        ].join('\u0001');
    }

    function ensureSpacer() {
        if (!galleryEl || disposed) return null;
        if (!spacerEl || spacerEl.parentNode !== galleryEl) {
            spacerEl = document.createElement('div');
            spacerEl.className = 'gallery-spacer';
        }
        return spacerEl;
    }

    function clearGallery({ keepSpacer = true } = {}) {
        renderedCount = 0;
        renderedKeys = [];
        renderGeneration += 1;
        spacerEl = null;
        if (galleryEl) galleryEl.innerHTML = '';
        if (keepSpacer) {
            ensureSpacer();
            if (spacerEl) galleryEl.appendChild(spacerEl);
        }
        if (texCountEl) texCountEl.textContent = '0';
    }

    function reset() {
        if (disposed) return;
        clearGallery();
    }

    function render(listAll) {
        if (!galleryEl || disposed) return;
        const list = Array.isArray(listAll) ? listAll : [];
        const total = list.length;
        const nextKeys = list.map(entryKey);

        ensureSpacer();

        if (total === 0) {
            reset();
            return;
        }

        let needsFullRender = total < renderedCount;
        if (!needsFullRender) {
            for (let i = 0; i < renderedCount; i += 1) {
                if (renderedKeys[i] !== nextKeys[i]) {
                    needsFullRender = true;
                    break;
                }
            }
        }

        if (needsFullRender) {
            clearGallery();
        }

        const fragment = document.createDocumentFragment();
        const itemGeneration = renderGeneration;
        for (let i = renderedCount; i < total; i++) {
            const entry = list[i];
            const div = document.createElement('div');
            div.className = 'thumb';

            const imgWrap = document.createElement('div');
            if (entry?.url) {
                const img = document.createElement('img');
                img.loading = 'lazy';
                img.decoding = 'async';
                img.alt = entry.short || '';
                img.src = entry.url;
                img.onerror = () => {
                    if (disposed || itemGeneration !== renderGeneration) return;
                    div.classList.add('broken');
                    img.replaceWith(makePlaceholder(entry));
                };
                imgWrap.appendChild(img);
            } else {
                div.classList.add('broken');
                imgWrap.appendChild(makePlaceholder(entry));
            }

            const nm = document.createElement('div');
            nm.className = 'nm';
            nm.title = (entry.full || entry.short || '') + (entry.fileName ? ` — ${entry.fileName}` : '');
            nm.textContent = entry.short || `(entry ${i})`;

            const pill = document.createElement('span');
            pill.className = 'pill';
            pill.textContent = `${guessKindFromName(entry.short)}${entry.fileName ? ` · ${basename(entry.fileName)}` : ''}`;

            div.appendChild(imgWrap);
            div.appendChild(nm);
            div.appendChild(pill);
            div.addEventListener('click', () => {
                if (disposed || itemGeneration !== renderGeneration) return;
                onOpen(entry);
            });

            fragment.appendChild(div);
        }

        if (fragment.childNodes.length) {
            if (renderedCount === 0) {
                galleryEl.innerHTML = '';
            }
            if (spacerEl && spacerEl.parentNode !== galleryEl) {
                galleryEl.appendChild(spacerEl);
            }
            if (spacerEl) galleryEl.insertBefore(fragment, spacerEl);
            else galleryEl.appendChild(fragment);
        }

        if (spacerEl && spacerEl.parentNode !== galleryEl) {
            galleryEl.appendChild(spacerEl);
        }

        renderedCount = total;
        renderedKeys = nextKeys;
        if (texCountEl) texCountEl.textContent = String(total);

        function makePlaceholder(entry) {
            const ph = document.createElement('div');
            ph.className = 'ph';
            ph.textContent = entry?.mime ? entry.mime : 'preview error';
            return ph;
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        clearGallery({ keepSpacer: false });
    }

    return Object.freeze({
        render,
        reset,
        dispose,
        getRenderedCount: () => renderedCount,
    });
}
