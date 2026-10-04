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
    let observer = null;
    let queue = [];
    let decoding = false;
    let activeAbort = null;
    const jobs = new Map();
    const previewSize = 256;

    const isCurrent = (job) => !disposed && job.generation === renderGeneration;

    function loadImage(blob, signal) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(blob);
            const cleanup = () => {
                img.onload = img.onerror = null;
                signal.removeEventListener('abort', cancel);
                img.removeAttribute('src');
                URL.revokeObjectURL(url);
            };
            const cancel = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
            img.onload = () => resolve({ image: img, close: cleanup });
            img.onerror = () => { cleanup(); reject(new Error('Image decode failed')); };
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) { cancel(); return; }
            img.src = url;
        });
    }

    async function decodePreview(job, signal) {
        let decoded = null;
        try {
            const response = await fetch(job.entry.url, { signal });
            if (!response.ok) throw new Error('Image fetch failed');
            const blob = await response.blob();
            if (!isCurrent(job)) return;
            if (typeof createImageBitmap === 'function') {
                try {
                    const bitmap = await createImageBitmap(blob);
                    decoded = { image: bitmap, close: () => bitmap.close() };
                } catch (_) {
                    // SVG and some older browser decoders need an HTML image.
                }
            }
            if (!isCurrent(job)) return;
            if (!decoded) decoded = await loadImage(blob, signal);
            if (!isCurrent(job)) return;
            const { image } = decoded;
            const width = image.naturalWidth || image.width;
            const height = image.naturalHeight || image.height;
            const scale = Math.min(1, previewSize / Math.max(width, height));
            job.canvas.width = Math.max(1, Math.round(width * scale));
            job.canvas.height = Math.max(1, Math.round(height * scale));
            const ctx = job.canvas.getContext('2d');
            if (!ctx) throw new Error('Preview canvas unavailable');
            ctx.drawImage(image, 0, 0, job.canvas.width, job.canvas.height);
        } catch (_) {
            if (isCurrent(job)) {
                job.div.classList.add('broken');
                job.canvas.replaceWith(makePlaceholder(job.entry));
                job.canvas.width = job.canvas.height = 0;
            }
        } finally {
            decoded?.close();
        }
    }

    async function drainQueue() {
        if (decoding) return;
        decoding = true;
        try {
            while (queue.length) {
                const job = queue.shift();
                if (!isCurrent(job)) continue;
                activeAbort = new AbortController();
                // Only one full-size decode is alive; only its small canvas stays.
                await decodePreview(job, activeAbort.signal);
                activeAbort = null;
            }
        } finally {
            decoding = false;
        }
    }

    function schedule(job) {
        if (job.queued || !isCurrent(job)) return;
        job.queued = true;
        queue.push(job);
        void drainQueue();
    }

    function observe(job) {
        jobs.set(job.canvas, job);
        if (typeof IntersectionObserver !== 'function') { schedule(job); return; }
        if (!observer) observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const candidate = jobs.get(entry.target);
                observer?.unobserve(entry.target);
                if (candidate) schedule(candidate);
            }
        }, { root: galleryEl });
        observer.observe(job.canvas);
    }

    function makePlaceholder(entry) {
        const ph = document.createElement('div');
        ph.className = 'ph';
        ph.textContent = entry?.mime ? entry.mime : 'preview error';
        return ph;
    }

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
        observer?.disconnect();
        observer = null;
        queue = [];
        activeAbort?.abort();
        for (const { canvas } of jobs.values()) canvas.width = canvas.height = 0;
        jobs.clear();
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
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 1;
                canvas.setAttribute('role', 'img');
                canvas.setAttribute('aria-label', entry.short || 'Texture preview');
                imgWrap.appendChild(canvas);
                observe({ canvas, div, entry, generation: itemGeneration, queued: false });
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
