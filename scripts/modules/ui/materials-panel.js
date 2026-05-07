import { clamp01 } from '../utils/math.js';
import { createLoadedModelSceneIndex } from '../scene/loaded-model-scene-index.js';
import { asMaterialArray, isGeneratedDisplayMaterial } from '../material/texture-utils.js';

const PANEL_TEX_KEYS = [
    'map',
    'alphaMap',
    'normalMap',
    'bumpMap',
    'aoMap',
    'emissiveMap',
    'specularMap',
    'roughnessMap',
    'metalnessMap',
];

export function createMaterialsPanelController(options = {}) {
    const world = options.world || null;
    const loadedModels = Array.isArray(options.loadedModels) ? options.loadedModels : [];
    const sceneIndex = options.sceneIndex || createLoadedModelSceneIndex({ loadedModels });

    const outEl = options.outEl || null;
    const matSelect = options.matSelect || null;

    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};

    const handleEyeToggle = typeof options.handleEyeToggle === 'function' ? options.handleEyeToggle : () => {};
    const updateEyeButtonsForTarget = typeof options.updateEyeButtonsForTarget === 'function' ? options.updateEyeButtonsForTarget : () => {};
    const openGeoModal = typeof options.openGeoModal === 'function' ? options.openGeoModal : () => {};

    const handleGlassSliderInput = typeof options.handleGlassSliderInput === 'function' ? options.handleGlassSliderInput : () => {};
    const handleGlassColorInput = typeof options.handleGlassColorInput === 'function' ? options.handleGlassColorInput : () => {};

    const texInfo = typeof options.texInfo === 'function' ? options.texInfo : () => '';
    const formatColorForDisplay = typeof options.formatColorForDisplay === 'function' ? options.formatColorForDisplay : () => '—';

    const notify = typeof options.alert === 'function'
        ? options.alert
        : (typeof globalThis !== 'undefined' && typeof globalThis.alert === 'function' ? globalThis.alert.bind(globalThis) : () => {});

    const panelState = {
        rootDetails: null,
        ungroupedMarker: null,
        groups: new Map(),
        renderedModels: new Set(),
    };

    let refreshPending = false;
    const refreshCallbacks = [];
    let needsFullRefresh = false;
    let disposed = false;

    function markNeedsFullRefresh() {
        if (disposed) return;
        needsFullRefresh = true;
    }

    function clearMaterialsDropdown() {
        if (!matSelect) return;
        matSelect.innerHTML = '<option value="">— выберите материал —</option>';
        delete matSelect.dataset._map;
    }

    function resetState(options = {}) {
        if (disposed && !options?.force) return;
        panelState.groups.forEach(entry => entry?.wrapper?.remove?.());
        panelState.groups.clear();
        panelState.renderedModels.clear();
        if (panelState.rootDetails) {
            panelState.rootDetails.remove();
            panelState.rootDetails = null;
        }
        panelState.ungroupedMarker = null;
        needsFullRefresh = false;
        if (options?.rebuildDropdown === false) {
            clearMaterialsDropdown();
        } else {
            rebuildMaterialsDropdown();
        }
    }

    function scheduleRefresh(afterRender) {
        if (disposed) return;
        if (typeof afterRender === 'function') refreshCallbacks.push(afterRender);
        if (refreshPending) return;
        refreshPending = true;
        Promise.resolve().then(() => {
            refreshPending = false;
            if (disposed) {
                refreshCallbacks.length = 0;
                return;
            }
            if (needsFullRefresh) resetState();
            renderMaterialsPanel();
            const callbacks = refreshCallbacks.splice(0);
            callbacks.forEach(cb => {
                try { cb(); } catch (err) { console.error('panel refresh callback failed', err); }
            });
        });
    }

    function getPanelMaterials(obj) {
        if (!obj) return [];
        const origMats = asMaterialArray(obj.userData?._origMaterial);
        if (origMats.length) {
            const currentMats = asMaterialArray(obj.material);
            const currentIsGeneratedDisplay = currentMats.some(m => isGeneratedDisplayMaterial(obj, m));
            if (currentIsGeneratedDisplay) return origMats;
            const hasTex = origMats.some(m => PANEL_TEX_KEYS.some(k => !!m?.[k]));
            if (hasTex) return origMats;
        }
        return asMaterialArray(obj.material);
    }

    function formatPanelLabel(label, maxChars = 36, dots = '....') {
        if (label == null) return '';
        const str = String(label);
        if (str.length <= maxChars) return str;
        const ellipsis = dots || '....';
        const reserved = Math.min(maxChars, ellipsis.length);
        const available = Math.max(maxChars - reserved, 0);
        if (available <= 0) return str.slice(0, maxChars);

        let headLen = Math.max(2, Math.ceil(available / 2));
        let tailLen = Math.max(2, available - headLen);

        const minSegment = 3;
        if (headLen < minSegment && available >= minSegment * 2) {
            tailLen = Math.max(minSegment, tailLen - (minSegment - headLen));
            headLen = minSegment;
        }
        if (tailLen < minSegment && available >= minSegment * 2) {
            headLen = Math.max(minSegment, headLen - (minSegment - tailLen));
            tailLen = minSegment;
        }

        while (headLen + tailLen > available) {
            if (headLen > tailLen && headLen > 1) headLen--;
            else if (tailLen > 1) tailLen--;
            else break;
        }

        const head = str.slice(0, headLen);
        const tail = str.slice(Math.max(str.length - tailLen, headLen));
        return head + ellipsis + tail;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Рендерит один FBX в панель материалов: заголовок, секции коллизий,
     * список мешей, интерактивные контролы стекла и кнопки видимости.
     */
    function renderOneModel(model, chunksArr) {
        function glassInfoRow(obj, material, matIndex) {
            const info = material?.userData?.glassInfo;
            if (!info) return '';
            const overrides = material?.userData?.glassOverrides || {};
            const alphaVal = clamp01(overrides.opacity ?? info.opacity ?? material.opacity ?? 1);
            const roughVal = clamp01(overrides.roughness ?? info.roughness ?? material.roughness ?? 0.1);
            const metalVal = clamp01(overrides.metalness ?? info.metalness ?? material.metalness ?? 0);
            const transVal = clamp01(overrides.transmission ?? info.transmission ?? (material.transmission ?? Math.max(0, 1 - (material.opacity ?? 1))));
            const refractionRaw = overrides.refraction ?? info.refraction ?? material.ior ?? 1.5;
            const iorVal = Number.isFinite(refractionRaw) ? refractionRaw : 1.5;
            const reflectVal = Number.isFinite(overrides.envIntensity) ? overrides.envIntensity : (Number.isFinite(info.envIntensity) ? info.envIntensity : (Number.isFinite(material.envMapIntensity) ? material.envMapIntensity : 1));
            const rawColor = overrides.color || info.colorHex || (material.color?.isColor ? `#${material.color.getHexString()}` : '#ffffff');
            const colorHex = (rawColor.startsWith ? rawColor : `#${rawColor}`).toUpperCase();
            const rgbDisplay = formatColorForDisplay(material?.color);
            const sourceLabel = info.source === 'override' ? 'Custom' : (info.source === 'geojson' ? 'GeoJSON' : 'UI');
            return `
                <tr class="glass-row">
                    <td class="k glass-cell">Glass</td>
                    <td>
                        <div class="glass-controls" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                            <div class="glass-group">
                                <label><span>α</span>
                                    <input type="range" min="0" max="1" step="0.01" value="${alphaVal}" class="glass-slider" data-prop="opacity" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                    <span class="glass-value" data-prop="opacity">${alphaVal.toFixed(2)}</span>
                                </label>
                            </div>
                            <div class="glass-group">
                                <label><span>rough</span>
                                    <input type="range" min="0" max="1" step="0.01" value="${roughVal}" class="glass-slider" data-prop="roughness" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                    <span class="glass-value" data-prop="roughness">${roughVal.toFixed(2)}</span>
                                </label>
                            </div>
                            <div class="glass-group">
                                <label><span>metal</span>
                                    <input type="range" min="0" max="1" step="0.01" value="${metalVal}" class="glass-slider" data-prop="metalness" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                    <span class="glass-value" data-prop="metalness">${metalVal.toFixed(2)}</span>
                                </label>
                            </div>
                            <div class="glass-group">
                                <label><span>trans</span>
                                    <input type="range" min="0" max="1" step="0.01" value="${transVal}" class="glass-slider" data-prop="transmission" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                    <span class="glass-value" data-prop="transmission">${transVal.toFixed(2)}</span>
                                </label>
                            </div>
                            <div class="glass-group">
                                <label><span>IOR</span>
                                    <input type="range" min="1" max="4" step="0.01" value="${iorVal}" class="glass-slider" data-prop="refraction" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                    <span class="glass-value" data-prop="refraction">${iorVal.toFixed(2)}</span>
                                </label>
                            </div>
                            <div class="glass-group">
                                <label><span>reflect</span>
                                    <input type="range" min="0" max="5" step="0.05" value="${reflectVal}" class="glass-slider" data-prop="envIntensity" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                    <span class="glass-value" data-prop="envIntensity">${reflectVal.toFixed(2)}</span>
                                </label>
                            </div>
                            <div class="glass-group">
                                <label><span>color</span>
                                    <input type="color" class="glass-color-input" data-prop="color" data-uuid="${obj.uuid}" data-mat-index="${matIndex}" value="${colorHex}">
                                    <span class="glass-value" data-prop="color-rgb">${rgbDisplay}</span>
                                </label>
                            </div>
                            <div class="glass-group glass-source-wrap">
                                <span class="glass-source" data-role="glass-source">${sourceLabel}</span>
                            </div>
                        </div>
                    </td>
                </tr>`;
        }

        const modelId = `file-${model.obj.uuid}`;
        const kindBadge =
            model.zipKind === 'NPM' ? '<span class="pill">НПМ</span>' :
                model.zipKind === 'SM' ? '<span class="pill">ВПМ</span>' : '';

        const hasGeo = !!(model.geojson || model.obj.userData?.geojson);
        const collisions = sceneIndex.getModelCollisions(model);

        // заголовок файла FBX
        const fileControls = `${hasGeo ? `<button type="button" class="doc" data-uuid="${model.obj.uuid}" title="Показать GeoJSON">📄</button>` : ''}<button type="button" class="eye" data-target="${modelId}" title="Показать/скрыть файл">👁</button>`;
        const fileTitlePieces = [];
        if (kindBadge) fileTitlePieces.push(kindBadge);
        const displayName = formatPanelLabel(model.name);
        fileTitlePieces.push(`<span>${escapeHtml(displayName)}</span>`);

        const fileTitle = fileTitlePieces.join('');
        chunksArr.push(`
                <div class="collapsible" data-level="file">
                    <details data-level="file">
                        <summary>
                            <span class="sumline">${fileTitle}</span>
                        </summary>
            `);
        model.obj.userData._panelId = modelId;
        model.obj.userData._panelKind = 'file-root';

        // ---- СЕКЦИЯ КОЛЛИЗИЙ (UCX) ВНУТРИ ЭТОГО FBX ----
        if (collisions.length) {
            const colGroupId = `colgrp|${model.obj.uuid}`;
            const colControls = `<button type="button" class="eye" data-target="${colGroupId}" data-icon-on="🧱" data-icon-off="🚫" title="Показать/скрыть все коллизии файла">🧱</button>`;
            chunksArr.push(`
                    <div class="collapsible" data-level="collisions">
                        <details open data-level="collisions">
                            <summary>
                                <span class="sumline">
                                    <span>🧱 КОЛЛИЗИИ</span>
                                </span>
                            </summary>
                `);

            collisions.forEach(o => {
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m, idx) => {
                    const objId = `collision-${o.uuid}-${idx}`;
                    o.userData._panelId = objId;
                    const humanIdx = mats.length > 1 ? ` [${idx + 1}]` : '';
                    const rawTitle = (m?.name || o.name || o.geometry?.name || '__COLLISION__') + humanIdx;
                    const title = formatPanelLabel(rawTitle);

                    const present = [];
                    ['map', 'alphaMap', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap']
                        .forEach(k => { if (m?.[k]) present.push(`<span class="tag">${k}</span>`); });

                    const colEntryControls = `<button type="button" class="eye" data-target="${objId}" data-uuid="${o.uuid}" data-mat-index="${idx}" title="Показать/скрыть">👁</button>`;
                    chunksArr.push(`
                            <div class="collapsible" data-level="collision-mesh">
                                <details>
                                    <summary>
                                        <span class="sumline"><span title="${escapeHtml(rawTitle)}">${escapeHtml(title)}</span></span>
                                    </summary>
                                <table>
                                    <tr><td class="k">Тип</td><td>${m?.type || '—'}</td></tr>
                                    <tr><td class="k">Цвет/α</td><td>#ff3333 · α=${(m?.opacity ?? 1).toFixed(2)}</td></tr>
                                    <tr><td class="k">Карты</td><td>${present.length ? present.join(' ') : '<span class="muted">—</span>'}</td></tr>
                                    ${glassInfoRow(o, m, idx)}
                                </table>
                                </details>
                                <div class="collapsible-controls">${colEntryControls}</div>
                            </div>
                        `);
                });
            });

            chunksArr.push(`</details><div class="collapsible-controls">${colControls}</div></div>`);
        }

        // ---- ОСТАЛЬНЫЕ МЕШИ (ИСКЛЮЧАЕМ КОЛЛИЗИИ) ----
        sceneIndex.getModelRenderables(model).forEach((obj) => {
            if (!obj.isMesh) return;
            const mats = getPanelMaterials(obj);
            if (!mats.length) return;

            mats.forEach((m, idx) => {
                const humanIdx = idx + 1;
                const matName = m.name || obj.name || `${m.type}`;
                const rawTitle = `${matName}${mats.length > 1 ? ` [${humanIdx}]` : ''}`;
                const title = formatPanelLabel(rawTitle);
                const present = [];
                ['map', 'alphaMap', 'normalMap', 'bumpMap', 'aoMap', 'emissiveMap', 'specularMap', 'roughnessMap', 'metalnessMap']
                    .forEach(k => { if (m[k]) present.push(`<span class="tag">${k}</span>`); });

                const objId = `${modelId}-mesh-${obj.uuid}-${idx}`;
                obj.userData._panelId = objId;

                const meshControls = `<button type="button" class="eye" data-target="${objId}" data-uuid="${obj.uuid}" data-mat-index="${idx}" title="Показать/скрыть">👁</button>`;
                chunksArr.push(`
                        <div class="collapsible" data-level="mesh">
                            <details>
                                <summary>
                                    <span class="sumline"><span title="${escapeHtml(rawTitle)}">${escapeHtml(title)}</span></span>
                                </summary>
                            <table>
                                <tr><td class="k">Карты</td><td>${present.length ? present.join(' ') : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Diffuse</td><td>${m.map ? texInfo(m.map) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Alpha</td><td>${m.alphaMap ? texInfo(m.alphaMap) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Normal</td><td>${m.normalMap ? texInfo(m.normalMap) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">AO</td><td>${m.aoMap ? texInfo(m.aoMap) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Roughness</td><td>${m.roughnessMap ? texInfo(m.roughnessMap) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Metalness</td><td>${m.metalnessMap ? texInfo(m.metalnessMap) : '<span class="muted">—</span>'}</td></tr>
                                ${glassInfoRow(obj, m, idx)}
                            </table>
                            </details>
                            <div class="collapsible-controls">${meshControls}</div>
                        </div>
                    `);
            });
        });

        sceneIndex.invalidateModel(model);

        chunksArr.push(`</details><div class="collapsible-controls">${fileControls}</div></div>`);
    }

    function ensurePanelRoot() {
        if (panelState.rootDetails && panelState.ungroupedMarker?.isConnected) {
            return panelState.rootDetails;
        }
        panelState.groups.clear();
        panelState.renderedModels.clear();
        panelState.rootDetails = null;
        panelState.ungroupedMarker = null;
        if (outEl) outEl.innerHTML = '';
        const rootDetails = document.createElement('details');
        rootDetails.open = true;
        rootDetails.dataset.level = 'root';
        const summary = document.createElement('summary');
        summary.textContent = 'Объекты';
        rootDetails.appendChild(summary);
        const marker = document.createComment('ungrouped-marker');
        rootDetails.appendChild(marker);
        outEl?.appendChild?.(rootDetails);
        panelState.rootDetails = rootDetails;
        panelState.ungroupedMarker = marker;
        return rootDetails;
    }

    function ensureGroupEntry(groupName, zipKind = '') {
        const rootDetails = ensurePanelRoot();
        if (panelState.groups.has(groupName)) {
            return panelState.groups.get(groupName);
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'collapsible';
        wrapper.dataset.level = 'group';

        const details = document.createElement('details');
        details.dataset.level = 'group';

        const summary = document.createElement('summary');
        const sumline = document.createElement('span');
        sumline.className = 'sumline';

        if (zipKind) {
            const pill = document.createElement('span');
            pill.className = 'pill';
            pill.style.marginRight = '6px';
            pill.textContent = zipKind === 'NPM' ? 'НПМ' : zipKind === 'SM' ? 'ВПМ' : zipKind;
            sumline.appendChild(pill);
        }

        const label = document.createElement('span');
        const displayGroup = formatPanelLabel(groupName);
        label.textContent = `📦 ${displayGroup}`;
        label.title = groupName || '';
        sumline.appendChild(label);

        summary.appendChild(sumline);
        details.appendChild(summary);
        wrapper.appendChild(details);

        const controls = document.createElement('div');
        controls.className = 'collapsible-controls';
        const eyeBtn = document.createElement('button');
        eyeBtn.type = 'button';
        eyeBtn.className = 'eye';
        eyeBtn.dataset.target = `group|${groupName}`;
        eyeBtn.title = 'Показать/скрыть группу';
        eyeBtn.textContent = '👁';
        controls.appendChild(eyeBtn);
        wrapper.appendChild(controls);

        rootDetails.insertBefore(wrapper, panelState.ungroupedMarker);
        attachPanelEvents(wrapper);

        const entry = { wrapper, details, controls, groupName, hasCollisionButton: false, zipKind };
        panelState.groups.set(groupName, entry);
        return entry;
    }

    function appendNodesToRoot(nodes) {
        const rootDetails = ensurePanelRoot();
        nodes.forEach(node => {
            rootDetails.insertBefore(node, panelState.ungroupedMarker);
            attachPanelEvents(node);
        });
    }

    function createNodesFromModel(model) {
        const chunks = [];
        renderOneModel(model, chunks);
        const html = chunks.join('').trim();
        if (!html) return [];
        const template = document.createElement('template');
        template.innerHTML = html;
        return Array.from(template.content.children);
    }

    function appendModelToPanel(model, targetDetails) {
        const nodes = createNodesFromModel(model);
        if (!nodes.length) return;
        nodes.forEach(node => {
            targetDetails.appendChild(node);
            attachPanelEvents(node);
        });
        panelState.renderedModels.add(model.obj.uuid);
    }

    function modelHasCollisions(model) {
        return sceneIndex.getModelCollisions(model).length > 0;
    }

    function ensureGroupCollisionButton(entry, groupName) {
        if (entry.hasCollisionButton) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'eye';
        btn.dataset.target = `zipcoll|${groupName}`;
        btn.dataset.iconOn = '🧱';
        btn.dataset.iconOff = '🚫';
        btn.title = 'Показать/скрыть коллизии группы';
        btn.textContent = '🧱';
        entry.controls.insertBefore(btn, entry.controls.firstChild);
        attachPanelEvents(btn);
        entry.hasCollisionButton = true;
    }

    function bindEyeButton(btn) {
        if (!btn || btn.dataset.boundEye) return;
        btn.dataset.boundEye = '1';
        btn.style.cursor = 'pointer';
        btn.addEventListener('click', () => handleEyeToggle(btn));
    }

    function bindDocButton(btn) {
        if (!btn || btn.dataset.boundDoc) return;
        btn.dataset.boundDoc = '1';
        btn.style.cursor = 'pointer';
        btn.addEventListener('click', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            const uuid = btn.dataset.uuid;
            if (!uuid) return;
            const mdl = loadedModels.find(m => m.obj.uuid === uuid);
            const meta = mdl?.geojson || mdl?.obj?.userData?.geojson;
            if (!meta) {
                notify('GeoJSON не найден для этого FBX');
                return;
            }
            openGeoModal(meta, mdl?.name || 'GeoJSON');
        });
    }

    function bindGlassSlider(input) {
        if (!input || input.dataset.boundGlassSlider) return;
        input.dataset.boundGlassSlider = '1';
        input.addEventListener('input', handleGlassSliderInput);
    }

    function bindGlassColorInput(input) {
        if (!input || input.dataset.boundGlassColor) return;
        input.dataset.boundGlassColor = '1';
        input.addEventListener('input', handleGlassColorInput);
        input.addEventListener('change', handleGlassColorInput);
    }

    function attachPanelEvents(root) {
        if (!root) return;
        const elements = [];
        if (root instanceof Element) {
            if (root.matches('.eye')) elements.push(root);
            root.querySelectorAll('.eye').forEach(el => elements.push(el));
        }
        elements.forEach(bindEyeButton);

        const docButtons = [];
        if (root instanceof Element) {
            if (root.matches('.doc')) docButtons.push(root);
            root.querySelectorAll('.doc').forEach(el => docButtons.push(el));
        }
        docButtons.forEach(bindDocButton);

        const glassSliders = [];
        if (root instanceof Element) {
            if (root.matches('.glass-slider')) glassSliders.push(root);
            root.querySelectorAll('.glass-slider').forEach(el => glassSliders.push(el));
        }
        glassSliders.forEach(bindGlassSlider);

        const glassColors = [];
        if (root instanceof Element) {
            if (root.matches('.glass-color-input')) glassColors.push(root);
            root.querySelectorAll('.glass-color-input').forEach(el => glassColors.push(el));
        }
        glassColors.forEach(bindGlassColorInput);
    }

    /**
     * Собирает данные по всем загруженным моделям и перерисовывает панель материалов.
     * Обновляет выпадающий список, интерактивные элементы и синхронизацию коллизий.
     */
    function renderMaterialsPanel() {
        if (disposed) return;
        const newModels = loadedModels.filter(m => !panelState.renderedModels.has(m.obj.uuid));
        if (!newModels.length) return;

        newModels.forEach(model => {
            if (model.group) {
                const entry = ensureGroupEntry(model.group, model.zipKind || '');
                appendModelToPanel(model, entry.details);
                if (modelHasCollisions(model)) {
                    ensureGroupCollisionButton(entry, model.group);
                }
            } else {
                const nodes = createNodesFromModel(model);
                if (!nodes.length) return;
                appendNodesToRoot(nodes);
                panelState.renderedModels.add(model.obj.uuid);
            }
        });

        rebuildMaterialsDropdown();
        syncCollisionButtons();
    }

    /** Возвращает { mesh, mat, index, source } по UUID и индексу материала для стеклянных контролов. */
    function resolveGlassMaterial(uuid, matIndex) {
        if (!uuid) return null;
        const mesh = world?.getObjectByProperty?.('uuid', uuid);
        if (!mesh) return null;
        const currentMats = asMaterialArray(mesh.material);
        const originalMats = asMaterialArray(mesh.userData?._origMaterial);
        const currentIsGeneratedDisplay = currentMats.some(m => isGeneratedDisplayMaterial(mesh, m));
        const useOriginal = originalMats.length > 0 && currentIsGeneratedDisplay;
        const mats = useOriginal ? originalMats : currentMats;
        if (!mats.length) return null;
        const index = Number.isInteger(matIndex) ? matIndex : (Number.isFinite(matIndex) ? matIndex : 0);
        const safeIndex = (index >= 0 && index < mats.length) ? index : 0;
        const mat = mats[safeIndex];
        if (!mat) return null;
        return { mesh, mat, index: safeIndex, source: useOriginal ? 'original' : 'current' };
    }

    /** Синхронизирует состояние кнопок «Коллизии» (по файлам и группам) с текущей видимостью. */
    function syncCollisionButtons() {
        if (!outEl) return;

        loadedModels.forEach(model => {
            const root = model.obj;
            if (!root) return;
            const collisions = sceneIndex.getModelCollisions(model);
            const hasAny = collisions.length > 0;
            const anyVisible = collisions.some((o) => o.visible !== false);
            if (hasAny) updateEyeButtonsForTarget(`colgrp|${root.uuid}`, anyVisible);
        });

        const grouped = new Map();
        loadedModels.forEach(model => {
            if (!model.group) return;
            if (!grouped.has(model.group)) grouped.set(model.group, []);
            grouped.get(model.group).push(model);
        });

        grouped.forEach((models, groupName) => {
            const collisions = models.flatMap((model) => sceneIndex.getModelCollisions(model));
            const hasAny = collisions.length > 0;
            const anyVisible = collisions.some((o) => o.visible !== false);
            if (hasAny) updateEyeButtonsForTarget(`zipcoll|${groupName}`, anyVisible);
        });
    }

    /**
     * Собирает материалы из сцены (кроме коллизий) для выпадающего списка.
     */
    function collectMaterialsFromWorld() {
        const out = [];
        loadedModels.forEach((model) => {
            sceneIndex.getModelRenderables(model).forEach((obj) => {
                if (!obj.isMesh) return;
                const mats = getPanelMaterials(obj);
                if (!mats.length) return;
                mats.forEach((m, i) => {
                    const humanIdx = i + 1;
                    const label = `${obj.name || obj.type} · ${m.type}${m.name ? ` (${m.name})` : ''}${mats.length > 1 ? ` [${humanIdx}]` : ''}`;
                    out.push({ obj, index: i, label, path: `${obj.uuid}:${i}` });
                });
            });
        });
        return out;
    }

    /**
     * Пересобирает выпадающий список материалов для ручной привязки текстур.
     */
    function rebuildMaterialsDropdown() {
        if (disposed) return;
        if (!matSelect) return;
        const items = collectMaterialsFromWorld();
        matSelect.innerHTML = '<option value="">— выберите материал —</option>';
        items.forEach((it, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = it.label;
            matSelect.appendChild(opt);
        });
        matSelect.dataset._map = JSON.stringify(items.map((x, idx) => ({ idx, path: x.path })));
    }

    function markSceneChanged() {
        if (disposed) return;
        requestRender();
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        refreshPending = false;
        refreshCallbacks.length = 0;
        resetState({ force: true, rebuildDropdown: false });
    }

    return Object.freeze({
        scheduleRefresh,
        resetState,
        markNeedsFullRefresh,
        renderMaterialsPanel,
        rebuildMaterialsDropdown,
        getPanelMaterials,
        resolveGlassMaterial,
        syncCollisionButtons,
        markSceneChanged,
        dispose,
    });
}
