export function createTextureGalleryController(options = {}) {
    const galleryEl = options.galleryEl || null;
    const texCountEl = options.texCountEl || null;
    const basename = typeof options.basename === 'function' ? options.basename : (p) => (p || '').split(/[\\/]/).pop();
    const guessKindFromName = typeof options.guessKindFromName === 'function' ? options.guessKindFromName : () => '';
    const onOpen = typeof options.onOpen === 'function' ? options.onOpen : () => {};

    let renderedCount = 0;
    let spacerEl = null;

    function ensureSpacer() {
        if (!galleryEl) return null;
        if (!spacerEl || spacerEl.parentNode !== galleryEl) {
            spacerEl = document.createElement('div');
            spacerEl.className = 'gallery-spacer';
        }
        return spacerEl;
    }

    function reset() {
        renderedCount = 0;
        if (!galleryEl) return;
        galleryEl.innerHTML = '';
        spacerEl = null;
        ensureSpacer();
        if (spacerEl) galleryEl.appendChild(spacerEl);
        if (texCountEl) texCountEl.textContent = '0';
    }

    function render(listAll) {
        if (!galleryEl) return;
        const total = Array.isArray(listAll) ? listAll.length : 0;

        ensureSpacer();

        if (total === 0) {
            reset();
            return;
        }

        if (total < renderedCount) {
            galleryEl.innerHTML = '';
            renderedCount = 0;
            ensureSpacer();
        }

        const fragment = document.createDocumentFragment();
        for (let i = renderedCount; i < total; i++) {
            const entry = listAll[i];
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
            div.addEventListener('click', () => onOpen(entry));

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
        if (texCountEl) texCountEl.textContent = String(total);

        function makePlaceholder(entry) {
            const ph = document.createElement('div');
            ph.className = 'ph';
            ph.textContent = entry?.mime ? entry.mime : 'preview error';
            return ph;
        }
    }

    return Object.freeze({
        render,
        reset,
        getRenderedCount: () => renderedCount,
    });
}

