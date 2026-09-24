import * as THREE from 'three';
import { captureParsedMaterials, collectSceneMaterials, keepMaterials } from '../material/scene-materials.js';
import { asMaterialArray, collectMaterialTextures, copyTextureSettings } from '../material/texture-utils.js';
import { getDepthPriority, setDepthPriority } from '../material/depth-priority.js';
import { MATERIAL_PRESETS, createPresetMaterial } from '../material/material-presets.js';
import { createFlowNetworkEditor, createFlowField, validateFlowNetwork } from '../material/flow-network.js';
import { createRiverMaterial, attachRiverRuntime, readRiverFlowSettings } from '../material/river-flow.js';
import { createMaterialThumbnails } from './material-thumbnails.js';

const NUMBERS = [
    ['roughness', 'Шероховатость', 0, 1, .01], ['metalness', 'Металличность', 0, 1, .01],
    ['opacity', 'Непрозрачность', 0, 1, .01], ['transmission', 'Пропускание', 0, 1, .01],
    ['ior', 'Преломление · IOR', 1, 3, .01], ['specularIntensity', 'Отражение', 0, 1, .01],
    ['envMapIntensity', 'Отражение окружения', 0, 5, .1], ['thickness', 'Толщина', 0, 10, .01],
    ['clearcoat', 'Лак', 0, 1, .01], ['clearcoatRoughness', 'Шероховатость лака', 0, 1, .01],
    ['attenuationDistance', 'Глубина затухания', 0.01, 1000, .1], ['alphaTest', 'Отсечение прозрачности', 0, 1, .01],
    ['emissiveIntensity', 'Свечение', 0, 10, .1], ['normalStrength', 'Сила рельефа', 0, 10, .1],
    ['depthPriority', 'Z-приоритет', -8, 8, 1],
];
const MAPS = [['map', 'Цвет'], ['normalMap', 'Рельеф'], ['roughnessMap', 'Шероховатость'], ['metalnessMap', 'Металличность'], ['aoMap', 'Затенение'], ['emissiveMap', 'Свечение']];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const emptyImage = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export function createMaterialEditor(options) {
    const host = document.getElementById('materialEditor');
    if (!host || !options.renderer) return null;
    const { loadedModels, world, requestRender } = options;
    let entries = new Map(), selectedId = '', originals = false, alive = true, generation = 0, query = '', active = false, flowDraft = null;
    const changed = new Set(), undo = new Map(), comparisons = new WeakMap();
    const thumbs = createMaterialThumbnails({ renderer: options.renderer, ready: options.rendererReady, getEnvironment: options.getEnvironment, requestRender });
    const flow = createFlowNetworkEditor({ ...options, onActive: (value) => document.body.classList.toggle('material-flow-edit', value), canvas: options.renderer.domElement, onChange: (network) => { flowDraft = structuredClone(network); updateFlowCount(); } });
    host.innerHTML = `
        <div class="me-modes" role="group" aria-label="Сравнение материалов"><button data-mode="edited" aria-pressed="true">Изменённые</button><button data-mode="original" aria-pressed="false">Исходные</button></div>
        <div class="me-toolbar"><button data-action="save">Сохранить в комнате</button><button data-action="download">Скачать настройки</button><button data-action="load">Открыть настройки</button></div>
        <p class="me-note">Материалы сохраняются отдельно от модели. Исходные доступны для сравнения в любой момент.</p>
        <div class="me-presets" aria-label="Готовые материалы">${MATERIAL_PRESETS.map((p) => `<button data-preset="${p.id}" title="Применить к выбранному материалу"><i class="me-preset-ball" style="--sample:${p.color}"></i>${p.name}</button>`).join('')}</div>
        <input class="me-search" type="search" aria-label="Поиск материалов" placeholder="Найти материал…">
        <p class="me-note" id="materialCount"></p><div class="me-grid" aria-label="Материалы сцены"></div>
        <div class="me-inspector"></div><div class="me-status" role="status" aria-live="polite"></div>
        <input type="file" data-file="settings" accept=".json,application/json" hidden><input type="file" data-file="texture" accept="image/png,image/jpeg,image/webp" hidden>`;
    const grid = host.querySelector('.me-grid'), inspector = host.querySelector('.me-inspector'), status = host.querySelector('.me-status');
    const sceneTab = document.getElementById('sceneTab'), materialTab = document.getElementById('materialsTab'), scenePanel = document.getElementById('scenePanel');
    const selected = () => entries.get(selectedId);
    const tell = (text) => { if (alive) status.textContent = text; };
    const live = (entry) => entry && entry.uses.some((u) => loadedModels.some((m) => m.obj === u.root) && asMaterialArray(u.object.userData._editorEditedMaterials || u.object.material).includes(entry.material));
    function tab(show) {
        active = show; host.hidden = !show; scenePanel.hidden = show;
        sceneTab.setAttribute('aria-selected', String(!show)); materialTab.setAttribute('aria-selected', String(show));
        sceneTab.tabIndex = show ? -1 : 0; materialTab.tabIndex = show ? 0 : -1;
        if (!show) flow.stop(); else refresh();
    }
    const sceneClick = () => tab(false), materialClick = () => tab(true);
    function tabKey(event) { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); tab(event.key === 'Home' ? false : event.key === 'End' ? true : !active); (active ? materialTab : sceneTab).focus(); } }
    sceneTab.addEventListener('click', sceneClick); materialTab.addEventListener('click', materialClick);
    sceneTab.addEventListener('keydown', tabKey); materialTab.addEventListener('keydown', tabKey);

    function refresh() {
        if (!alive) return;
        loadedModels.forEach((m) => captureParsedMaterials(m.obj));
        entries = collectSceneMaterials(loadedModels);
        if (!entries.has(selectedId)) { selectedId = entries.keys().next().value || ''; if (flow.active) flow.stop(); }
        for (const material of changed) if (![...entries.values()].some((e) => e.material === material)) changed.delete(material);
        for (const material of undo.keys()) if (![...entries.values()].some((e) => e.material === material)) undo.delete(material);
        if (active) { renderList(); renderInspector(); }
        options.persistence?.refresh?.();
    }
    function renderList() {
        thumbs.clear(); grid.replaceChildren();
        const visible = [...entries.values()].filter(({ material }) => String(material.name || '').toLowerCase().includes(query.toLowerCase()));
        host.querySelector('#materialCount').textContent = `${entries.size} материалов · показано ${visible.length}`;
        for (const { material, uses } of visible) {
            const button = document.createElement('button'); button.className = 'me-card'; button.dataset.material = material.uuid; button.title = material.name;
            button.setAttribute('aria-pressed', String(selectedId === material.uuid));
            button.innerHTML = `<img alt="" src="${emptyImage}" style="--sample:#${material.color?.getHexString() || '888888'}"><span>${esc(material.name || 'Без имени')}</span><small>${new Set(uses.map((u) => u.object)).size} объектов${changed.has(material) ? ' · изменён' : ''}</small>`;
            grid.append(button);
            const preview = originals ? asMaterialArray(uses[0].object.userData._editorOriginalMaterials)[uses[0].index] : material;
            thumbs.enqueue(button.querySelector('img'), preview || material);
        }
        host.querySelectorAll('[data-preset]').forEach((b) => { b.disabled = originals || !selected(); });
    }
    function renderInspector() {
        const entry = selected();
        if (!entry) { inspector.innerHTML = '<p class="me-note">Загрузите модель, чтобы редактировать материалы.</p>'; return; }
        const m = originals ? asMaterialArray(entry.uses[0].object.userData._editorOriginalMaterials)[entry.uses[0].index] : entry.material;
        inspector.innerHTML = `<h3>${esc(m.name || 'Без имени')}</h3><div class="me-actions"><button data-action="focus">Показать объекты</button><button data-action="undo" ${!undo.has(m) || originals ? 'disabled' : ''}>Отменить правку</button><button data-action="reset" ${originals ? 'disabled' : ''}>Вернуть исходный</button></div>
          <fieldset ${originals ? 'disabled' : ''}><div class="me-controls">
          <label for="meColor">Цвет</label><input id="meColor" data-color="color" type="color" value="#${m.color?.getHexString() || 'ffffff'}">
          <label for="meAttenuation">Цвет затухания</label><input id="meAttenuation" data-color="attenuationColor" type="color" value="#${m.attenuationColor?.getHexString() || 'ffffff'}">
          <label for="meEmission">Цвет свечения</label><input id="meEmission" data-color="emissive" type="color" value="#${m.emissive?.getHexString() || '000000'}">
          ${NUMBERS.map(([key, label, min, max, step]) => `<label for="me-${key}">${label}</label><input id="me-${key}" data-number="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${key === 'normalStrength' ? m.normalScale?.x ?? 1 : key === 'depthPriority' ? getDepthPriority(m) : Number.isFinite(m[key]) ? Number(m[key].toFixed(4)) : key === 'attenuationDistance' ? 1000 : 0}">`).join('')}
          <label for="meSide">Стороны</label><select id="meSide" data-select="side"><option value="0" ${m.side === 0 ? 'selected' : ''}>Лицевая</option><option value="2" ${m.side === 2 ? 'selected' : ''}>Обе</option><option value="1" ${m.side === 1 ? 'selected' : ''}>Обратная</option></select>
          <label for="meAlpha">Прозрачность</label><select id="meAlpha" data-select="alpha"><option value="opaque" ${!m.transparent ? 'selected' : ''}>Непрозрачный</option><option value="blend" ${m.transparent ? 'selected' : ''}>Смешивание</option></select>
          </div><details><summary>Текстурные карты</summary><div class="me-textures">${MAPS.map(([key, label]) => `<div class="me-texture"><img alt="" data-map-image="${key}" src="${emptyImage}"><span>${label}${m[key] ? ' · есть' : ' · нет'}</span><button data-texture="${key}">Заменить</button><button data-clear="${key}" ${!m[key] || (key === 'normalMap' && m.riverFlow) ? 'disabled' : ''}>Убрать</button></div>`).join('')}</div></details>
          ${m.riverFlow || m.userData.viewerPreset === 'water' || m.userData.lpmview_water ? `<div class="me-water"><h4>Течение воды</h4><div class="me-controls"><label for="meSpeed">Скорость</label><input id="meSpeed" data-number="flowSpeed" type="number" min="0" max="30" step="0.1" value="${m.riverFlow?.speed ?? 1}"></div>
          <div class="me-actions"><button data-action="flow-start">Нарисовать течение</button><button data-action="flow-pause">${m.riverFlow?.playing === false ? 'Пустить воду' : 'Пауза'}</button></div>
          <div data-flow-tools hidden><p class="me-note">Щёлкайте по воде, чтобы добавить точки. Щелчок по существующей точке соединяет с ней ветку. Затем можно продолжить от неё. Перетаскивайте точки по поверхности.</p><div class="me-actions"><button data-action="flow-branch">Выбрать начало ветки</button><button data-action="flow-delete">Удалить точку</button><button data-action="flow-reverse">Развернуть всё</button><button data-action="flow-apply">Применить течение</button><button data-action="flow-cancel">Отмена</button></div><p data-flow-count class="me-note"></p></div></div>` : ''}
          </fieldset>${originals ? '<p class="me-note">Показаны исходные материалы. Правки сохранены — нажмите «Изменённые», чтобы продолжить.</p>' : ''}`;
        for (const [key] of MAPS) {
            const image = inspector.querySelector(`[data-map-image="${key}"]`);
            if (image && m[key]) { try { image.src = textureURL(m[key]); } catch (_) {} }
        }
    }
    function setMode(value) {
        flow.stop(); flowDraft = null; originals = value; options.ensurePBR?.();
        for (const model of loadedModels) model.obj.traverse((object) => {
            if (!object.isMesh || !object.userData._editorOriginalMaterials) return;
            if (!object.userData._editorEditedMaterials) keepMaterials(object, '_editorEditedMaterials', Array.isArray(object.material) ? [...object.material] : object.material);
            const source = object.userData._editorOriginalMaterials;
            if (value) {
                const compare = (m) => {
                    let copy = comparisons.get(m);
                    if (!copy) { copy = m.clone(); comparisons.set(m, copy); }
                    else copy.copy(m);
                    const retained = asMaterialArray(object.userData._removedMaterials);
                    if (!retained.includes(copy)) keepMaterials(object, '_removedMaterials', [...retained, copy]);
                    return copy;
                };
                object.material = Array.isArray(source) ? source.map(compare) : compare(source);
            } else object.material = object.userData._editorEditedMaterials;
            object.userData._origMaterial = object.material;
        });
        host.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.mode === 'original') === value)));
        requestRender(); refresh();
    }
    function bind(entry, next) {
        const prev = entry.material;
        const history = undo.get(prev); if (history) { undo.delete(prev); undo.set(next, { ...history, previous: prev }); }
        next.userData.viewerMaterialId = prev.userData.viewerMaterialId;
        for (const { object, index } of entry.uses) {
            const state = asMaterialArray(object.userData._editorEditedMaterials || object.material).slice(); state[index] = next;
            const value = Array.isArray(object.material) ? state : state[0];
            keepMaterials(object, '_editorEditedMaterials', value);
            object.material = value; object.userData._origMaterial = value;
            const retained = asMaterialArray(object.userData._removedMaterials);
            if (!retained.includes(prev)) keepMaterials(object, '_removedMaterials', [...retained, prev]);
        }
        selectedId = next.uuid; entry.material = next;
        entries.delete(prev.uuid); entries.set(next.uuid, entry); changed.delete(prev); changed.add(next);
        options.sceneIndex?.invalidateAll?.(); requestRender();
    }
    function checkpoint(entry) {
        if (!entry || originals) return;
        options.ensurePBR?.();
        const m = entry.material;
        // A single undo snapshot owns no textures; retained original references live on the mesh.
        undo.get(m)?.clone?.dispose();
        undo.set(m, { clone: m.clone(), priority: getDepthPriority(m), speed: m.riverFlow?.speed, playing: m.riverFlow?.playing });
    }
    function mark(entry) {
        const m = entry.material;
        m.userData.viewerBaseColorNeutralized = false;
        if (m.color) m.userData.viewerSourceBaseColor = m.color.toArray();
        if (m.userData.glassOriginal || /glass|glas|стекл/i.test(m.name)) m.userData.glassOverrides = {
            ...m.userData.glassOverrides, color: '#' + m.color.getHexString(), opacity: m.opacity, roughness: m.roughness,
            metalness: m.metalness, transmission: m.transmission, refraction: m.ior, envIntensity: m.envMapIntensity,
        };
        changed.add(m); m.needsUpdate = true; requestRender(); renderList(); options.onMaterialsChanged?.(); tell('Есть несохранённые изменения.');
    }
    function physical(entry) {
        if (entry.material.isMeshPhysicalMaterial) return entry.material;
        const source = entry.material, next = new THREE.MeshPhysicalMaterial();
        if (source.isMeshStandardMaterial) THREE.MeshStandardMaterial.prototype.copy.call(next, source);
        else { next.name = source.name; next.color.copy(source.color || new THREE.Color('white')); next.map = source.map || null; }
        bind(entry, next); return next;
    }
    async function applyWater(entry, network, settings = null) {
        const token = generation, old = entry.material;
        const bounds = new THREE.Box3(); for (const use of entry.uses) bounds.expandByObject(use.object);
        bounds.translate(world.position.clone().negate());
        const origin = [bounds.min.x, bounds.min.z], extent = [Math.max(.01, bounds.max.x - bounds.min.x), Math.max(.01, bounds.max.z - bounds.min.z)];
        const fieldCanvas = createFlowField(network, [...origin, ...extent]);
        const field = new THREE.CanvasTexture(fieldCanvas); field.flipY = false; field.colorSpace = THREE.NoColorSpace; field.generateMipmaps = false; field.minFilter = field.magFilter = THREE.LinearFilter;
        const meta = { version: 2, origin, extent, tileMeters: 6, cycleSeconds: 8, metersPerSecond: .19654007225, speed: old.riverFlow?.speed ?? 1, specularColor: old.specularColor?.toArray() || [2, 2, 2], ...settings, flowMap: fieldCanvas.toDataURL(), network };
        const source = old.isMeshPhysicalMaterial && old.normalMap ? old : createPresetMaterial('water', old);
        let runtime;
        try { runtime = await createRiverMaterial(source, field, meta, options.useWebGPU); }
        catch (error) { field.dispose(); if (source !== old) { source.normalMap?.dispose(); source.dispose(); } throw error; }
        if (!alive || token !== generation || !live(entry) || entry.material !== old) { field.dispose(); runtime.material.dispose(); if (source !== old) source.normalMap?.dispose(); return; }
        runtime.material.userData.lpmview_water = meta; runtime.material.userData.viewerPreset = 'water';
        attachRiverRuntime(runtime, [...new Set(entry.uses.map((u) => u.object))], entry.uses[0].root, meta, { requestRender, world });
        checkpoint(entry); bind(entry, runtime.material); mark(entry); if (source !== old) source.dispose();
        refresh();
    }
    function updateFlowCount() { const el = inspector.querySelector('[data-flow-count]'); if (el) el.textContent = `${flowDraft?.nodes.length || 0} точек · ${flowDraft?.edges.length || 0} соединений`; }
    let textureSlot = '', textureEntry = null;
    async function click(event) {
        const button = event.target.closest('button'); if (!button) return;
        try {
            if (button.dataset.material) { flow.stop(); selectedId = button.dataset.material; renderList(); renderInspector(); return; }
            if (button.dataset.mode) { setMode(button.dataset.mode === 'original'); return; }
            const entry = selected(), m = entry?.material, action = button.dataset.action;
            if (action === 'download') { const data = serialize(); download(data); tell('Настройки сохранены в файл.'); return; }
            if (action === 'load') { host.querySelector('[data-file=settings]').click(); return; }
            if (action === 'save') { if (!options.saveSettings) throw Error('Откройте комнату проекта, чтобы сохранить настройки.'); await options.saveSettings(serialize()); tell('Настройки материалов сохранены в комнате.'); return; }
            if (!entry) return;
            if (action === 'focus') { options.focusOn?.([...new Set(entry.uses.map((u) => u.object))]); return; }
            if (originals) return;
            if (button.dataset.preset) {
                flow.stop(); checkpoint(entry);
                const id = button.dataset.preset;
                if (id === 'water') {
                    if (m.riverFlow) { tell('Течение уже настроено. Параметры воды доступны ниже.'); return; }
                    const next = createPresetMaterial(id, m); bind(entry, next); await applyWater(entry, { nodes: [], edges: [] });
                } else { const next = createPresetMaterial(id, m); bind(entry, next); mark(entry); }
                refresh(); return;
            }
            if (action === 'reset') {
                flow.stop(); const first = entry.uses[0], original = asMaterialArray(first.object.userData._editorOriginalMaterials)[first.index];
                checkpoint(entry); bind(entry, original.clone()); mark(entry); refresh(); return;
            }
            if (action === 'undo') { const state = undo.get(m); if (!state) return; if (state.previous) { undo.delete(m); bind(entry, state.previous); state.clone.dispose(); mark(entry); refresh(); return; } m.copy(state.clone); setDepthPriority(m, state.priority); if (m.riverFlow) { m.riverFlow.speed = state.speed; m.riverFlow.playing = state.playing; } undo.delete(m); state.clone.dispose(); mark(entry); renderInspector(); return; }
            if (button.dataset.texture) { textureSlot = button.dataset.texture; textureEntry = entry; host.querySelector('[data-file=texture]').click(); return; }
            if (button.dataset.clear) {
                checkpoint(entry); const slot = button.dataset.clear; retainTextures(m); m[slot] = null; mark(entry); renderInspector(); return;
            }
            if (action === 'flow-start') { flowDraft = structuredClone(m.userData.lpmview_water?.network || { nodes: [], edges: [] }); flow.start(entry, flowDraft); inspector.querySelector('[data-flow-tools]').hidden = false; inspector.querySelector('[data-flow-tools]').scrollIntoView({ block: 'nearest' }); updateFlowCount(); return; }
            if (action === 'flow-branch') { flow.newBranch(); tell('Щёлкните по точке, из которой должна начаться новая ветка.'); return; }
            if (action === 'flow-delete') { flow.removePoint(); return; }
            if (action === 'flow-reverse') { flow.reverse(); return; }
            if (action === 'flow-cancel') { flow.stop(); renderInspector(); return; }
            if (action === 'flow-apply') { if (!flowDraft?.edges.length) throw Error('Соедините хотя бы две точки на воде.'); const network = flow.value; flow.stop(); await applyWater(entry, network); return; }
            if (action === 'flow-pause' && m.riverFlow) { m.riverFlow.playing = !m.riverFlow.playing; requestRender(); renderInspector(); }
        } catch (error) { tell(error.message); }
    }
    function retainTextures(m) { m.editorRetainedTextures = [...new Set([...(m.editorRetainedTextures || []), ...collectMaterialTextures(m)])]; }
    async function change(event) {
        const input = event.target;
        try {
            if (input.dataset.file === 'settings') { const file = input.files[0]; if (file) { if (file.size > 32 * 1024 * 1024) throw Error('Файл настроек слишком большой.'); await applySettings(JSON.parse(await file.text())); } input.value = ''; return; }
            if (input.dataset.file === 'texture') {
                const file = input.files[0], entry = textureEntry, slot = textureSlot, token = generation; input.value = '';
                if (!file || !live(entry) || originals) return;
                if (file.size > 16 * 1024 * 1024) throw Error('Выберите текстуру до 16 МБ.');
                const url = URL.createObjectURL(file); let texture;
                try { texture = await new THREE.TextureLoader().loadAsync(url); } finally { URL.revokeObjectURL(url); }
                if (!alive || token !== generation || !live(entry) || originals) { texture.dispose(); return; }
                checkpoint(entry); const m = physical(entry); retainTextures(m); copyTextureSettings(m[slot] || m.map, texture);
                texture.colorSpace = ['map', 'emissiveMap'].includes(slot) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                m[slot] = texture; if (slot === 'normalMap') m.updateRiverNormal?.(texture); mark(entry); renderInspector(); return;
            }
            const entry = selected(); if (!entry || originals) return;
            checkpoint(entry); const m = physical(entry);
            if (input.dataset.number) {
                const key = input.dataset.number, config = NUMBERS.find((n) => n[0] === key) || [key, '', 0, 30];
                const value = Math.max(config[2], Math.min(config[3], Number(input.value))); if (!Number.isFinite(value)) return;
                input.value = value;
                if (key === 'normalStrength') m.normalScale.setScalar(value);
                else if (key === 'depthPriority') setDepthPriority(m, value);
                else if (key === 'flowSpeed') { if (m.riverFlow) m.riverFlow.speed = value; if (m.userData.lpmview_water) m.userData.lpmview_water.speed = value; }
                else m[key] = value;
            } else if (input.dataset.color) m[input.dataset.color].set(input.value);
            else if (input.dataset.select === 'side') m.side = Number(input.value);
            else if (input.dataset.select === 'alpha') m.transparent = input.value === 'blend';
            else return;
            mark(entry); const undoButton = inspector.querySelector('[data-action=undo]'); if (undoButton) undoButton.disabled = false;
        } catch (error) { tell(error.message); }
    }
    const search = (event) => { query = event.target.value; renderList(); };
    host.addEventListener('click', click); host.addEventListener('change', change); host.querySelector('.me-search').addEventListener('input', search);

    function materialKey(entry) {
        const use = entry.uses[0], record = loadedModels.find((r) => r.obj === use.root);
        return { model: String(record?.scope?.modelId || record?.obj?.userData?.sourceFileName || record?.name || ''), material: entry.material.userData.viewerMaterialId };
    }
    function serialize() {
        return { format: 'lpmview-materials', version: 1, materials: [...entries.values()].filter((e) => changed.has(e.material)).map((entry) => {
            const m = entry.material, first = entry.uses[0], original = asMaterialArray(first.object.userData._editorOriginalMaterials)[first.index];
            return { ...materialKey(entry), name: m.name, preset: m.userData.viewerPreset || null,
                values: Object.fromEntries(NUMBERS.filter(([key]) => !['normalStrength', 'depthPriority'].includes(key)).map(([key]) => [key, m[key] ?? 0])),
                attenuationColor: m.attenuationColor?.toArray(), specularColor: m.specularColor?.toArray(), color: m.color?.toArray(), emissive: m.emissive?.toArray(), normalScale: m.normalScale?.toArray(), depthPriority: getDepthPriority(m), side: m.side, transparent: m.transparent,
                water: m.userData.lpmview_water || null,
                maps: Object.fromEntries(MAPS.map(([key]) => [key, m[key] === original?.[key] ? { original: true } : m[key] ? { data: textureURL(m[key]), repeat: m[key].repeat.toArray(), offset: m[key].offset.toArray(), rotation: m[key].rotation, flipY: m[key].flipY, channel: m[key].channel } : null])),
            };
        }) };
    }
    async function applySettings(data, { isCurrent = () => true } = {}) {
        if (data?.format !== 'lpmview-materials' || data.version !== 1 || !Array.isArray(data.materials) || data.materials.length > 4096) throw Error('Неподдерживаемый файл материалов.');
        const token = ++generation; if (originals) setMode(false); let applied = 0;
        refresh();
        for (const saved of data.materials) {
            if (!alive || token !== generation || !isCurrent()) return;
            const entry = [...entries.values()].find((e) => { const key = materialKey(e); return key.model === saved.model && key.material === saved.material; });
            if (!entry) continue;
            const next = createPresetMaterial(MATERIAL_PRESETS.some((p) => p.id === saved.preset) ? saved.preset : 'stone', entry.material);
            for (const t of collectMaterialTextures(next)) t.dispose();
            MAPS.forEach(([key]) => { next[key] = null; });
            const first = entry.uses[0], original = asMaterialArray(first.object.userData._editorOriginalMaterials)[first.index];
            const created = [];
            try {
                for (const [key] of MAPS) {
                    const value = saved.maps?.[key];
                    if (value?.original) next[key] = original?.[key] || null;
                    else if (value?.data) {
                        if (!/^data:image\/(png|jpeg|webp);base64,/.test(value.data) || value.data.length > 8 * 1024 * 1024) throw Error('Недопустимая текстура в настройках.');
                        const t = await new THREE.TextureLoader().loadAsync(value.data); created.push(t); next[key] = t;
                        t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = ['map', 'emissiveMap'].includes(key) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                        for (const k of ['repeat', 'offset']) if (Array.isArray(value[k]) && value[k].length === 2 && value[k].every(Number.isFinite)) t[k].fromArray(value[k]);
                        t.flipY = value.flipY !== false; t.channel = [0, 1, 2, 3].includes(value.channel) ? value.channel : 0; t.rotation = Number.isFinite(value.rotation) ? value.rotation : 0;
                    }
                }
                if (!alive || token !== generation || !isCurrent() || !live(entry)) { created.forEach((t) => t.dispose()); next.dispose(); return; }
                for (const [key, , min, max] of NUMBERS) if (key in next && Number.isFinite(saved.values?.[key])) next[key] = Math.max(min, Math.min(max, saved.values[key]));
                for (const key of ['color', 'emissive', 'attenuationColor', 'specularColor']) if (Array.isArray(saved[key]) && saved[key].length === 3 && saved[key].every((v) => Number.isFinite(v) && v >= 0 && v <= 2)) next[key].fromArray(saved[key]);
                if (Array.isArray(saved.normalScale) && saved.normalScale.length === 2 && saved.normalScale.every((v) => Number.isFinite(v) && Math.abs(v) <= 10)) next.normalScale.fromArray(saved.normalScale);
                if (!saved.preset) delete next.userData.viewerPreset;
                next.side = [0, 1, 2].includes(saved.side) ? saved.side : 0; next.transparent = !!saved.transparent;
                setDepthPriority(next, saved.depthPriority || 0); bind(entry, next);
                if (readRiverFlowSettings(saved.water)?.version === 2 && validateFlowNetwork(saved.water.network)) await applyWater(entry, saved.water.network, saved.water);
                else if (readRiverFlowSettings(saved.water)?.version === 1) {
                    const meta = readRiverFlowSettings(saved.water);
                    const field = await new THREE.TextureLoader().loadAsync(meta.flowMap);
                    field.flipY = false; field.colorSpace = THREE.NoColorSpace; field.generateMipmaps = false;
                    field.minFilter = field.magFilter = THREE.LinearFilter;
                    let runtime;
                    try { runtime = await createRiverMaterial(next, field, meta, options.useWebGPU); }
                    catch (error) { field.dispose(); throw error; }
                    if (!alive || token !== generation || !isCurrent() || !live(entry)) { field.dispose(); runtime.material.dispose(); return; }
                    runtime.material.userData.lpmview_water = meta;
                    attachRiverRuntime(runtime, [...new Set(entry.uses.map((u) => u.object))], first.root, meta, { requestRender, world });
                    bind(entry, runtime.material);
                }
                mark(entry); applied++;
            } catch (error) { if (entry.material !== next) { created.forEach((t) => t.dispose()); next.dispose(); } throw error; }
        }
        refresh(); tell(`Восстановлено материалов: ${applied}.`); return applied;
    }
    function download(data) {
        const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = 'materials.lpmview.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return {
        refresh, serialize, applySettings, setMode,
        get originalMode() { return originals; },
        dispose() { alive = false; generation++; flow.dispose(); thumbs.dispose(); for (const state of undo.values()) state.clone.dispose(); undo.clear(); entries.clear(); changed.clear(); host.removeEventListener('click', click); host.removeEventListener('change', change); host.querySelector('.me-search').removeEventListener('input', search); sceneTab.removeEventListener('click', sceneClick); materialTab.removeEventListener('click', materialClick); sceneTab.removeEventListener('keydown', tabKey); materialTab.removeEventListener('keydown', tabKey); },
    };
}

function textureURL(texture) {
    const image = texture.source?.data || texture.image; if (!image) return emptyImage;
    const canvas = document.createElement('canvas'); const max = Math.max(image.width || 1, image.height || 1); const scale = Math.min(1, 1024 / max);
    canvas.width = Math.max(1, Math.round((image.width || 1) * scale)); canvas.height = Math.max(1, Math.round((image.height || 1) * scale));
    const ctx = canvas.getContext('2d');
    if (image.data) { const temp = document.createElement('canvas'); temp.width = image.width; temp.height = image.height; temp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0); ctx.drawImage(temp, 0, 0, canvas.width, canvas.height); }
    else ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
}
