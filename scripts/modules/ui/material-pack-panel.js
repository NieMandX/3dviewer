import { matchMaterialPack } from '../material/material-pack.js';

export function createMaterialPackPanel({ host, store, getModels, getEntries, apply, onSaved, onBusy, tell }) {
    const panel = document.createElement('details'); panel.className = 'me-packs';
    panel.innerHTML = `<summary>Наборы материалов проекта</summary><p class="me-note" data-pack-context></p>
      <label>Модель <select data-pack-model aria-label="Модель для набора материалов"></select></label>
      <label>Название новой папки <input data-pack-name maxlength="120" placeholder="Например, М8 — основные материалы"></label>
      <div class="me-actions"><button data-pack-action="save">Сохранить набор в проекте</button></div>
      <label>Папка с набором <select data-pack-list aria-label="Набор материалов проекта"><option value="">Выберите набор…</option></select></label>
      <div class="me-actions"><button data-pack-action="reload">Обновить список</button><button data-pack-action="preview">Сопоставить с моделью</button><button data-pack-action="apply" disabled>Применить</button><button data-pack-action="cancel" hidden>Отменить</button></div>
      <p class="me-note" data-pack-summary></p><p class="me-note">В папке сохраняются все материалы выбранной модели, карты и течение воды. После применения нажмите «Сохранить в комнате».</p>`;
    host.append(panel);
    const modelSelect = panel.querySelector('[data-pack-model]'), packSelect = panel.querySelector('[data-pack-list]'), name = panel.querySelector('[data-pack-name]'), summary = panel.querySelector('[data-pack-summary]');
    let alive = true, revision = 0, busy = false, plan = null, projectKey = '', modelKey = '', listRevision = 0;
    const model = () => getModels().find((m) => m.obj.uuid === modelSelect.value);
    function resetPlan() { plan = null; summary.textContent = ''; updateButtons(); }
    function updateButtons() {
        const allowed = store?.state().canManage && !!model();
        for (const el of panel.querySelectorAll('input,select,button')) el.disabled = busy;
        for (const action of ['save', 'preview']) panel.querySelector(`[data-pack-action=${action}]`).disabled = busy || !allowed || (action === 'preview' && !packSelect.value);
        panel.querySelector('[data-pack-action=apply]').disabled = busy || !plan?.matches.length;
        panel.querySelector('[data-pack-action=reload]').disabled = busy || !store?.state().canManage;
        const cancel = panel.querySelector('[data-pack-action=cancel]'); cancel.hidden = !busy; cancel.disabled = false;
    }
    function setBusy(value) { busy = value; onBusy(value); updateButtons(); }
    async function reload() {
        const token = ++listRevision;
        try {
            if (!store?.state().canManage) return;
            const rows = await store.list(); if (!alive || token !== listRevision) return;
            const previous = packSelect.value; packSelect.replaceChildren(new Option('Выберите набор…', ''));
            for (const row of rows) packSelect.add(new Option(`${row.name} · ${row.material_count} материалов · ${new Date(row.created_at).toLocaleString('ru')}`, row.id));
            if (rows.some((r) => r.id === previous)) packSelect.value = previous;
            updateButtons();
        } catch (error) { if (alive && token === listRevision) tell(error.message); }
    }
    function refresh() {
        if (!alive) return;
        const state = store?.state() || {}, models = getModels(), nextModels = models.map((m) => m.obj.uuid).join('|');
        const nextProject = `${state.projectId || ''}:${!!state.canManage}`;
        if (nextModels !== modelKey || nextProject !== projectKey) {
            revision++; listRevision++; if (busy) setBusy(false); resetPlan();
            const previous = modelSelect.value; modelSelect.replaceChildren();
            for (const m of models) modelSelect.add(new Option(m.name || m.obj.userData.sourceFileName || 'Модель', m.obj.uuid));
            if (models.some((m) => m.obj.uuid === previous)) modelSelect.value = previous;
            if (nextProject !== projectKey) { packSelect.replaceChildren(new Option('Выберите набор…', '')); if (panel.open) void reload(); }
            projectKey = nextProject; modelKey = nextModels;
        }
        panel.querySelector('[data-pack-context]').textContent = state.canManage ? `Проект: ${state.name || 'Текущий проект'}. Один набор — одна отдельная папка.` : state.projectId ? 'Библиотекой наборов управляет владелец проекта.' : 'Откройте комнату проекта, чтобы сохранять и загружать наборы.';
        updateButtons();
    }
    async function click(event) {
        const action = event.target.closest('[data-pack-action]')?.dataset.packAction; if (!action) return;
        if (action === 'cancel') { revision++; setBusy(false); tell('Операция отменена.'); return; }
        if (busy) return;
        if (action === 'reload') { resetPlan(); await reload(); return; }
        const target = model(); if (!target) return;
        const token = ++revision, initial = store?.state(), packId = packSelect.value;
        const current = () => alive && token === revision && getModels().includes(target) && model() === target && initial?.projectId === store?.state().projectId;
        setBusy(true);
        try {
            if (action === 'save') {
                const entries = getEntries(target), versions = entries.map((e) => e.material.version);
                const unchanged = () => current() && entries.every((e, i) => e.material.version === versions[i]);
                const result = await store.save({ name: name.value, sourceModel: target.name, entries, isCurrent: unchanged, onProgress: (n, total) => { if (current()) tell(`Сохраняю материалы: ${n} из ${total}…`); } });
                if (unchanged() && result.current) { onSaved(entries, result); await reload(); packSelect.value = result.id; tell(`Папка «${result.name}» сохранена в проекте. Для автозагрузки нажмите «Сохранить в комнате».`); }
            } else if (action === 'preview') {
                const source = await store.open(packId, { isCurrent: current }); if (!current()) return;
                plan = { ...matchMaterialPack(source.pack, getEntries(target)), source };
                summary.textContent = `Совпало: ${plan.matches.length}. Без пары: ${plan.missing.length}. Неоднозначных: ${plan.ambiguous.length}.` + (plan.missing.length ? ` Без пары: ${plan.missing.join(', ')}.` : '') + (plan.ambiguous.length ? ` Пропустим неоднозначные: ${plan.ambiguous.join(', ')}.` : '');
                tell(plan.matches.length ? 'Проверьте сопоставление и нажмите «Применить».' : 'Совпадений по именам нет. Материалы модели сохранены.');
            } else if (action === 'apply' && plan) {
                plan.source = await store.open(packId, { isCurrent: current });
                const count = await apply(plan, current); if (!current()) return;
                plan = null; summary.textContent = `Применено материалов: ${count}. Остальные материалы модели сохранены.`;
                tell('Набор применён. Нажмите «Сохранить в комнате», чтобы закрепить результат.');
            }
        } catch (error) { if (current()) tell(error.message); }
        finally { if (alive && token === revision) setBusy(false); }
    }
    const change = (event) => { if (event.target === modelSelect || event.target === packSelect) { revision++; resetPlan(); } };
    const toggle = () => { if (panel.open) { refresh(); void reload(); } };
    panel.addEventListener('click', click); panel.addEventListener('change', change); panel.addEventListener('toggle', toggle);
    refresh();
    return { refresh, get busy() { return busy; }, cancel() { revision++; if (busy) setBusy(false); resetPlan(); }, dispose() { alive = false; revision++; listRevision++; panel.removeEventListener('click', click); panel.removeEventListener('change', change); panel.removeEventListener('toggle', toggle); panel.remove(); } };
}
