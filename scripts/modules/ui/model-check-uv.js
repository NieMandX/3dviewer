// Checker evidence describes the original ZIP, never the normalized scene.
// Tile-local UV origin is bottom-left; PNG raster origin is top-left.
const COLORS = ['#28e0d1', '#ffbf55'];
const finite = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const point = p => Array.isArray(p) && p.length === 2 && p.every(n => finite(n, 0, 1));
const size = s => Array.isArray(s) && s.length === 2 && s.every(n => Number.isInteger(n) && n > 0 && n <= 4096);
const text = s => typeof s === 'string' && s.length <= 1024;
function png(value) {
    if (!value || !size(value.size) || value.size.some(n => n > 1024)) return false;
    const url = value.data_url;
    if (typeof url !== 'string' || url.length > 140000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) return false;
    try {
        const bytes = Uint8Array.from(atob(url.slice(22)), c => c.charCodeAt(0));
        if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return false;
        const data = new DataView(bytes.buffer);
        return data.getUint32(8) === 13 && data.getUint32(12) === 0x49484452
            && data.getUint32(16) === value.size[0] && data.getUint32(20) === value.size[1];
    } catch { return false; }
}

export function uvEvidence(report) {
    const views = [];
    const additional = Array.isArray(report?.additional_checks) ? report.additional_checks : [];
    for (const entry of additional.slice(0, 100)) {
        if (entry?.id !== 'AV.UV.SPACING.001' || !Array.isArray(entry.groups)) continue;
        for (const group of entry.groups.slice(0, 100)) {
            if (!Array.isArray(group?.objects)) continue;
            for (const object of group.objects.slice(0, 50)) {
                const visual = object?.measurements?.visuals;
                if (visual?.schema !== 'agr-uv-evidence-v1' || visual.coordinate_space !== 'tile_uv_bottom_left'
                    || !['NPM', 'VPM'].includes(visual.profile) || !text(visual.source_fbx)
                    || visual.requirement_ref !== (visual.profile === 'NPM' ? '2.5.4' : '2.5.1.5')
                    || !Array.isArray(visual.textures) || !Array.isArray(visual.cases)) continue;
                const textures = new Map();
                for (const t of visual.textures.slice(0, 6)) {
                    if (!t || !text(t.id) || !text(t.name) || !/^[a-f0-9]{64}$/.test(t.sha256) || !size(t.size)
                        || !Number.isInteger(t.tile) || t.tile < 1001 || t.tile > 1100 || !png(t.preview)) continue;
                    textures.set(t.id, t);
                }
                for (const c of visual.cases.slice(0, 6)) {
                    const t = textures.get(c?.texture_id);
                    if (!t || !['small_gap', 'borderline'].includes(c.kind)
                        || !finite(c.gap_px, 0, 4096) || !finite(c.threshold_px, 1, 128)
                        || !Array.isArray(c.points_uv) || c.points_uv.length !== 2 || !c.points_uv.every(point)
                        || !Array.isArray(c.island_segments_uv) || c.island_segments_uv.length !== 2
                        || !c.island_segments_uv.every(list => Array.isArray(list) && list.length > 0 && list.length <= 2048
                            && list.every(s => Array.isArray(s) && s.length === 2 && s.every(point)))
                        || !png(c.detail)) continue;
                    const r = c.detail.region_uv;
                    if (!Array.isArray(r) || r.length !== 4 || !r.every(n => finite(n, 0, 1)) || r[0] >= r[2] || r[1] >= r[3]) continue;
                    const measured = Math.hypot((c.points_uv[0][0] - c.points_uv[1][0]) * t.size[0], (c.points_uv[0][1] - c.points_uv[1][1]) * t.size[1]);
                    if (Math.abs(measured - c.gap_px) > 0.001) continue;
                    views.push({ profile: visual.profile, requirementRef: visual.requirement_ref, sourceFbx: visual.source_fbx,
                        partial: object.measurements.coverage_complete !== true, texture: t, sample: c });
                    if (views.length >= 24) return views;
                }
            }
        }
    }
    return views;
}

export function createUVTextureDialog({ document: doc = document } = {}) {
    let dialog; let refs; let observer; let disposed = false; let previousFocus; let generation = 0;
    let views = []; let chosen; let atlas; let detail; let view; let drag;
    const removers = [];
    const el = (tag, value, className) => { const node = doc.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node; };
    const listen = (node, event, handler, options) => { node.addEventListener(event, handler, options); removers.push(() => node.removeEventListener(event, handler, options)); };
    const format = n => n.toLocaleString('ru-RU', { maximumFractionDigits: 4 });
    function releaseImages() {
        for (const image of [atlas, detail]) if (image) { image.onload = image.onerror = null; image.removeAttribute('src'); }
        atlas = detail = null;
    }
    function close() {
        generation++; releaseImages(); views = []; chosen = null; view = null; drag = null;
        dialog?.close();
        if (refs) { refs.canvas.width = refs.canvas.height = 1; refs.select.replaceChildren(); }
        if (!disposed && previousFocus?.isConnected) previousFocus.focus();
        previousFocus = null;
    }
    function transform() {
        const rect = refs.canvas.getBoundingClientRect();
        const [w, h] = chosen.texture.size;
        const scale = Math.min(rect.width / ((view[2] - view[0]) * w), rect.height / ((view[3] - view[1]) * h));
        return { scale, width: rect.width, height: rect.height, project: p => [rect.width / 2 + (p[0] - (view[0] + view[2]) / 2) * w * scale,
            rect.height / 2 + ((view[1] + view[3]) / 2 - p[1]) * h * scale] };
    }
    function draw() {
        if (disposed || !dialog?.open || !chosen || !view) return;
        const canvas = refs.canvas; const { scale, width, height, project } = transform();
        if (!width || !height) return;
        const dpr = Math.min(doc.defaultView.devicePixelRatio || 1, 2);
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
        const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#182428'; ctx.fillRect(0, 0, width, height);
        const [tw, th] = chosen.texture.size;
        function picture(image, region) {
            if (!image?.complete || !image.naturalWidth) return;
            const [x, y] = project([region[0], region[3]]);
            ctx.drawImage(image, x, y, (region[2] - region[0]) * tw * scale, (region[3] - region[1]) * th * scale);
        }
        picture(atlas, [0, 0, 1, 1]); picture(detail, chosen.sample.detail.region_uv);
        chosen.sample.island_segments_uv.forEach((segments, index) => {
            for (const [color, lineWidth] of [['#102326', 4.5], [COLORS[index], 2]]) {
                ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = lineWidth;
                for (const segment of segments) { ctx.moveTo(...project(segment[0])); ctx.lineTo(...project(segment[1])); }
                ctx.stroke();
            }
        });
        const points = chosen.sample.points_uv.map(project);
        for (const [color, lineWidth, dash] of [['#102326', 4, []], ['#ffffff', 2, [5, 3]]]) {
            ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = lineWidth; ctx.setLineDash(dash);
            ctx.moveTo(...points[0]); ctx.lineTo(...points[1]); ctx.stroke();
        }
        ctx.setLineDash([]);
        points.forEach((p, i) => { ctx.beginPath(); ctx.fillStyle = COLORS[i]; ctx.arc(...p, 4, 0, 2 * Math.PI); ctx.fill(); });
        const label = `${format(chosen.sample.gap_px)} px`; ctx.font = 'bold 14px system-ui';
        const labelWidth = ctx.measureText(label).width + 16;
        const x = Math.max(6, Math.min(width - labelWidth - 6, (points[0][0] + points[1][0]) / 2 - labelWidth / 2));
        const y = Math.max(6, Math.min(height - 32, (points[0][1] + points[1][1]) / 2 - 38));
        ctx.fillStyle = '#102326'; ctx.fillRect(x, y, labelWidth, 28); ctx.fillStyle = 'white'; ctx.fillText(label, x + 8, y + 19);
    }
    function fit() { if (chosen) { view = [...chosen.sample.detail.region_uv]; draw(); } }
    function zoom(factor) {
        if (!view) return;
        const span = Math.max(view[2] - view[0], view[3] - view[1]);
        if (span * factor < 1 / 512 || span * factor > 3) return;
        const cx = (view[0] + view[2]) / 2; const cy = (view[1] + view[3]) / 2;
        view = [cx + (view[0] - cx) * factor, cy + (view[1] - cy) * factor, cx + (view[2] - cx) * factor, cy + (view[3] - cy) * factor]; draw();
    }
    function select() {
        generation++; releaseImages(); drag = null; chosen = views[Number(refs.select.value)];
        if (!chosen) return;
        const mark = generation; const { texture: t, sample: c } = chosen;
        refs.texture.textContent = `${t.name} · UDIM ${t.tile} · ${t.size.join(' × ')} px`;
        refs.source.textContent = chosen.sourceFbx;
        refs.distance.textContent = `${format(c.gap_px)} px`;
        refs.threshold.textContent = `Ориентир — ${format(c.threshold_px)} px для уникальных изображений`;
        refs.note.textContent = `Снимок исходной текстуры из отчёта. Расстояние указано в пикселях оригинала.${chosen.partial ? ' Анализ модели выполнен частично.' : ''} Допустимость повторного использования изображения требует просмотра.`;
        refs.status.textContent = 'Загрузка снимка…'; let pending = 2; let failed = false;
        function image(url) {
            const result = new doc.defaultView.Image();
            result.onload = () => { if (mark !== generation || !dialog.open) return; pending--; if (!pending) refs.status.textContent = failed ? 'Один из снимков недоступен; показаны сохранённые контуры.' : ''; draw(); };
            result.onerror = () => { if (mark !== generation || !dialog.open) return; failed = true; pending--; refs.status.textContent = 'Снимок не удалось открыть; показаны сохранённые контуры.'; draw(); };
            result.src = url; return result;
        }
        atlas = image(t.preview.data_url); detail = image(c.detail.data_url); fit();
    }
    function ensure() {
        if (dialog) return;
        dialog = el('dialog', undefined, 'sheet model-check-uv-dialog'); dialog.id = 'modelCheckUVDialog'; dialog.setAttribute('aria-labelledby', 'modelCheckUVTitle');
        const head = el('div', undefined, 'head'); const title = el('strong', 'UV-острова на текстуре'); title.id = 'modelCheckUVTitle';
        const exit = el('button', 'Вернуться к отчёту', 'btn'); exit.type = 'button'; head.append(title, exit);
        const body = el('div', undefined, 'model-check-uv-body');
        const selectLabel = el('label', 'Найденный участок'); selectLabel.htmlFor = 'modelCheckUVSample';
        const selectEl = el('select'); selectEl.id = selectLabel.htmlFor;
        const texture = el('p', '', 'model-check-uv-texture'); const source = el('p', '', 'muted');
        const facts = el('div', undefined, 'model-check-uv-facts'); const distance = el('strong'); const threshold = el('span'); facts.append(distance, threshold);
        const legend = el('div', undefined, 'model-check-uv-legend'); legend.append(el('span', 'Остров A'), el('span', 'Остров B'), el('span', 'Линия измерения'));
        const canvas = el('canvas'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Два UV-острова поверх исходной текстуры и линия измеренного зазора');
        const controls = el('div', undefined, 'model-check-actions');
        for (const [label, fn] of [['Участок', fit], ['Весь тайл', () => { view = [0, 0, 1, 1]; draw(); }], ['Увеличить', () => zoom(0.7)], ['Уменьшить', () => zoom(1 / 0.7)]]) {
            const button = el('button', label, 'btn'); button.type = 'button'; listen(button, 'click', fn); controls.append(button);
        }
        const hint = el('p', 'Перетаскивайте текстуру для перемещения. Масштаб меняется кнопками или колесом мыши.', 'muted');
        const status = el('p', '', 'model-check-uv-status'); status.setAttribute('role', 'status');
        const note = el('p', '', 'muted'); body.append(selectLabel, selectEl, texture, source, facts, legend, canvas, controls, hint, status, note);
        dialog.append(head, body); doc.body.append(dialog); refs = { select: selectEl, texture, source, distance, threshold, canvas, status, note };
        listen(exit, 'click', close); listen(dialog, 'cancel', e => { e.preventDefault(); close(); }); listen(dialog, 'keydown', e => e.stopPropagation());
        listen(selectEl, 'change', select);
        listen(canvas, 'wheel', e => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15); }, { passive: false });
        listen(canvas, 'pointerdown', e => { if (!view || e.button !== 0 || drag) return; drag = { id: e.pointerId, x: e.clientX, y: e.clientY, view: [...view], scale: transform().scale }; canvas.setPointerCapture(e.pointerId); });
        listen(canvas, 'pointermove', e => {
            if (!drag || e.pointerId !== drag.id || !chosen) return;
            const dx = (e.clientX - drag.x) / (chosen.texture.size[0] * drag.scale); const dy = (e.clientY - drag.y) / (chosen.texture.size[1] * drag.scale);
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) return;
            view = [drag.view[0] - dx, drag.view[1] + dy, drag.view[2] - dx, drag.view[3] + dy]; draw();
        });
        for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(canvas, event, () => { drag = null; });
        observer = new doc.defaultView.ResizeObserver(draw); observer.observe(canvas);
    }
    return { close, open(items, trigger) {
        if (disposed || !items?.length) return;
        close(); ensure(); previousFocus = trigger || doc.activeElement; views = items;
        refs.select.replaceChildren(...items.map((v, i) => { const option = el('option', `Место ${i + 1} · ${format(v.sample.gap_px)} px · ${v.texture.name}`); option.value = String(i); return option; }));
        refs.select.value = '0'; dialog.showModal(); select();
    }, dispose() { if (disposed) return; disposed = true; close(); observer?.disconnect(); for (const remove of removers) remove(); dialog?.remove(); refs = null; } };
}
