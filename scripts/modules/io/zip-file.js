import { revokeGeoJsonMetaUrl } from '../geo/geojson-meta.js';

export function createZIPFileHandler(options = {}) {
    const basename = typeof options.basename === 'function' ? options.basename : (p) => (p || '').split(/[\\/]/).pop();

    const unpackZIPInWorker = typeof options.unpackZIPInWorker === 'function' ? options.unpackZIPInWorker : null;
    const makeGeoJsonMeta = typeof options.makeGeoJsonMeta === 'function' ? options.makeGeoJsonMeta : null;
    const handleFBXFile = typeof options.handleFBXFile === 'function' ? options.handleFBXFile : null;

    const logSessionHeader = typeof options.logSessionHeader === 'function' ? options.logSessionHeader : () => {};
    const logBind = typeof options.logBind === 'function' ? options.logBind : () => {};
    const hideSidePanel = typeof options.hideSidePanel === 'function' ? options.hideSidePanel : () => {};
    const setStatusMessage = typeof options.setStatusMessage === 'function' ? options.setStatusMessage : () => {};
    const schedulePanelRefresh = typeof options.schedulePanelRefresh === 'function' ? options.schedulePanelRefresh : () => {};
    const ensureZipCollisionsHidden = typeof options.ensureZipCollisionsHidden === 'function' ? options.ensureZipCollisionsHidden : () => {};
    const cleanupImportedRange = typeof options.cleanupImportedRange === 'function' ? options.cleanupImportedRange : () => {};

    const setEmptyHintVisible = typeof options.setEmptyHintVisible === 'function' ? options.setEmptyHintVisible : () => {};

    const allEmbedded = Array.isArray(options.allEmbedded) ? options.allEmbedded : [];
    const markGalleryNeedsRefresh = typeof options.markGalleryNeedsRefresh === 'function' ? options.markGalleryNeedsRefresh : () => {};
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];

    const JSZip = options.JSZip || (typeof globalThis !== 'undefined' ? globalThis.JSZip : null);

    function isAbortError(error) {
        return error?.name === 'AbortError';
    }

    function makeAbortError(message = 'ZIP import aborted') {
        try {
            return new DOMException(message, 'AbortError');
        } catch (_) {
            const err = new Error(message);
            err.name = 'AbortError';
            return err;
        }
    }

    function revokeBlobUrl(url) {
        const value = String(url || '');
        if (!value.startsWith('blob:')) return;
        try {
            URL.revokeObjectURL(value);
        } catch (_) {}
    }

    function cleanupPartialImport({ modelStart = 0, embeddedStart = 0, geoMeta = null } = {}) {
        revokeGeoJsonMetaUrl(geoMeta);
        cleanupImportedRange({ modelStart, embeddedStart });
    }

    return async function handleZIPFile(file, callOptions = null) {
        const signal = callOptions?.signal || null;
        const throwIfAborted = () => {
            if (!signal?.aborted) return;
            throw makeAbortError();
        };

        throwIfAborted();
        logSessionHeader(`ZIP: ${file.name}`);
        setStatusMessage(`Чтение ZIP: ${file.name}…`);
        hideSidePanel();

        const zipKind = /^\d/.test(file.name) ? 'NPM' : /^SM/i.test(file.name) ? 'SM' : null;
        let zipGeoMeta = null;
        let lastNormalizeOrientationType = null;
        const importModelStart = loadedModels.length;
        const importEmbeddedStart = allEmbedded.length;

        const workerRun = unpackZIPInWorker?.(file, {
            onMeta: (msg) => {
                throwIfAborted();
                if (zipKind === 'SM') {
                    const hasGeo = (msg?.counts?.geojson || 0) > 0;
                    if (!hasGeo) {
                        logBind(`GeoJSON: в «${file.name}» не найден (ВПМ без меты)`, 'info');
                    }
                }
            },
            onProgress: (msg) => {
                throwIfAborted();
                const phaseLabel = msg.phase === 'fbx' ? 'FBX' : msg.phase === 'image' ? 'IMG' : msg.phase;
                const name = basename(msg.name || '');
                setStatusMessage(`ZIP ${phaseLabel}: ${msg.index}/${msg.total} · ${name}`);
            },
            onGeoJSON: async (msg) => {
                throwIfAborted();
                if (zipKind !== 'SM') return;
                if (!makeGeoJsonMeta) return;
                try {
                    zipGeoMeta = makeGeoJsonMeta(file.name, msg.name, msg.text);
                    logBind(`GeoJSON: найден в «${file.name}» → ${msg.name}`, 'ok');
                } catch (err) {
                    logBind(`GeoJSON: не удалось обработать (${msg.name}) → ${err?.message || err}`, 'warn');
                    zipGeoMeta = null;
                }
            },
            onFBX: async (msg) => {
                throwIfAborted();
                const blob = msg.blob;
                if (!blob) return;
                if (!handleFBXFile) return;
                const fileName = msg.fileName || basename(msg.name) || '';
                const isLightFBX = /_Light\.fbx$/i.test(fileName);
                const beforeCount = loadedModels.length;
                const nextCallOptions = isLightFBX && lastNormalizeOrientationType != null
                    ? { ...(callOptions || {}), inheritOrientationType: lastNormalizeOrientationType }
                    : callOptions;
                const fbxFile = new File([blob], fileName, { type: blob.type || 'model/fbx' });
                await handleFBXFile(fbxFile, file.name, zipKind, zipGeoMeta, nextCallOptions);
                const newModel = loadedModels[beforeCount];
                if (newModel && !isLightFBX) {
                    lastNormalizeOrientationType = newModel.normalizedOrientationType ?? newModel.orientationType ?? null;
                }
                setEmptyHintVisible(false);
            },
            onImage: async (msg) => {
                throwIfAborted();
                const blob = msg.blob;
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                try {
                    throwIfAborted();
                } catch (err) {
                    revokeBlobUrl(url);
                    throw err;
                }
                const short = basename(msg.name).toLowerCase();
                allEmbedded.push({ short, url, full: msg.name, mime: msg.mime || blob.type || "image/png", source: "zip" });
                markGalleryNeedsRefresh();
            },
        }, { signal });

        if (workerRun) {
            try {
                await workerRun;
                throwIfAborted();

                // 4) если в ZIP был geojson — прикрепим его ко ВСЕМ FBX из этого ZIP
                if (zipGeoMeta) {
                    let attached = 0;
                    loadedModels
                        .filter(m => m.group === file.name)
                        .forEach(m => {
                            m.geojson = zipGeoMeta;
                            (m.obj.userData ||= {}).geojson = zipGeoMeta;
                            attached++;
                        });

                    if (attached) {
                        logBind(`GeoJSON: прикреплён к ${attached} FBX из «${file.name}» (${zipGeoMeta.entryName}${zipGeoMeta.featureCount != null ? `, features: ${zipGeoMeta.featureCount}` : ''})`, 'ok');
                        schedulePanelRefresh();
                    } else {
                        logBind(`GeoJSON: файл найден в «${file.name}», но FBX из этого ZIP не обнаружены`, 'warn');
                        revokeGeoJsonMetaUrl(zipGeoMeta);
                    }
                }

                ensureZipCollisionsHidden(file.name);
                setStatusMessage(`Готово: ${file.name}`);
                return;
            } catch (err) {
                cleanupPartialImport({
                    modelStart: importModelStart,
                    embeddedStart: importEmbeddedStart,
                    geoMeta: zipGeoMeta,
                });
                zipGeoMeta = null;
                lastNormalizeOrientationType = null;
                if (isAbortError(err)) throw err;
                logBind(`ZIP worker: не удалось обработать «${file.name}» → fallback на main thread (${err?.message || err})`, 'warn');
            }
        }

        try {
            throwIfAborted();
            if (!JSZip) {
                throw new Error('JSZip not available for main-thread ZIP fallback');
            }

            const zip = await JSZip.loadAsync(file);
            throwIfAborted();
            const entries = Object.values(zip.files);

            // ↓↓↓ ТОЛЬКО ДЛЯ ВПМ
            if (zipKind === 'SM') {
                const geoEntries = entries.filter(e => !e.dir && /\.geojson$/i.test(e.name));
                if (geoEntries.length && makeGeoJsonMeta) {
                    const bytes = await geoEntries[0].async('uint8array');
                    throwIfAborted();
                    let geoText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                    // снять BOM, если есть
                    geoText = geoText.replace(/^\uFEFF/, '');

                    zipGeoMeta = makeGeoJsonMeta(file.name, geoEntries[0].name, geoText);
                    logBind(`GeoJSON: найден в «${file.name}» → ${geoEntries[0].name}`, 'ok');
                } else {
                    logBind(`GeoJSON: в «${file.name}» не найден (ВПМ без меты)`, 'info');
                }
            }

            // Сначала FBX — каждому передаём zipGeoMeta (для SM) или null (для NPM/прочих)
            // Если в архиве есть *_Light.fbx — грузим их ПОСЛЕДНИМИ (для наследования ориентации).
            const isLightFBX = (entry) => /_Light\.fbx$/i.test(basename(entry?.name || ''));
            const fbxEntries = entries.filter((e) => e && !e.dir && /\.fbx$/i.test(e.name));
            const orderedFBXEntries = [...fbxEntries.filter((e) => !isLightFBX(e)), ...fbxEntries.filter((e) => isLightFBX(e))];
            for (const entry of orderedFBXEntries) {
                throwIfAborted();
                const ab = await entry.async('arraybuffer');
                throwIfAborted();
                const fbxFile = new File([ab], basename(entry.name), { type: 'model/fbx' });
                const fileName = basename(entry.name) || '';
                const isLight = /_Light\.fbx$/i.test(fileName);
                const beforeCount = loadedModels.length;
                const nextCallOptions = isLight && lastNormalizeOrientationType != null
                    ? { ...(callOptions || {}), inheritOrientationType: lastNormalizeOrientationType }
                    : callOptions;
                await handleFBXFile?.(fbxFile, file.name, zipKind, zipGeoMeta, nextCallOptions);
                const newModel = loadedModels[beforeCount];
                if (newModel && !isLight) {
                    lastNormalizeOrientationType = newModel.normalizedOrientationType ?? newModel.orientationType ?? null;
                }
                setEmptyHintVisible(false);
            }

            // Затем картинки как было
            for (const entry of entries) {
                throwIfAborted();
                if (entry.dir) continue;
                if (/\.(png|jpe?g|webp)$/i.test(entry.name)) {
                    const blob = await entry.async('blob');
                    throwIfAborted();
                    const url = URL.createObjectURL(blob);
                    try {
                        throwIfAborted();
                    } catch (err) {
                        revokeBlobUrl(url);
                        throw err;
                    }
                    const short = basename(entry.name).toLowerCase();
                    allEmbedded.push({ short, url, full: entry.name, mime: blob.type || 'image/png', source: 'zip' });
                    markGalleryNeedsRefresh();
                }
            }

            // 4) если в ZIP был geojson — прикрепим его ко ВСЕМ FBX из этого ZIP
            if (zipGeoMeta) {
                let attached = 0;
                loadedModels
                    .filter(m => m.group === file.name)      // модели, загруженные из этого же архива
                    .forEach(m => {
                        m.geojson = zipGeoMeta;              // для рендера в панели
                        (m.obj.userData ||= {}).geojson = zipGeoMeta; // на сам объект — если удобно обращаться из дерева
                        attached++;
                    });

                if (attached) {
                    logBind(`GeoJSON: прикреплён к ${attached} FBX из «${file.name}» (${zipGeoMeta.entryName}${zipGeoMeta.featureCount != null ? `, features: ${zipGeoMeta.featureCount}` : ''})`, 'ok');
                    schedulePanelRefresh(); // перерисуем, чтобы появилась 📄
                } else {
                    logBind(`GeoJSON: файл найден в «${file.name}», но FBX из этого ZIP не обнаружены`, 'warn');
                    revokeGeoJsonMetaUrl(zipGeoMeta);
                }
            }

            ensureZipCollisionsHidden(file.name);

            setStatusMessage(`Готово: ${file.name}`);
        } catch (err) {
            cleanupPartialImport({
                modelStart: importModelStart,
                embeddedStart: importEmbeddedStart,
                geoMeta: zipGeoMeta,
            });
            zipGeoMeta = null;
            lastNormalizeOrientationType = null;
            throw err;
        }
    };
}
