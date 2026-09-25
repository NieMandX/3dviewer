import { matchMaterialPack } from '../material/material-pack.js';
import { saveMaterialPackFile, openMaterialPackFile } from '../material/material-pack-file.js';

export function createMaterialPackPanel({ host, getModels, getEntries, apply, onBusy, tell }) {
    const panel = document.createElement('details'); panel.className = 'me-packs';
    panel.innerHTML = `<summary>Набор материалов на компьютере</summary>
      <label>Модель <select data-pack-model aria-label="Модель для набора материалов"></select></label>
      <div class="me-actions"><button data-pack-action="save">Сохранить набор на диск</button><button data-pack-action="open">Открыть набор с диска</button><button data-pack-action="apply" disabled>Применить</button><button data-pack-action="cancel" hidden>Отменить</button></div>
      <input type="file" data-pack-file accept=".lpmat" hidden>
      <p class="me-note" data-pack-summary></p><p class="me-note">Файл .lpmat содержит все материалы выбранной модели, текстуры и течение воды. Геометрия не входит. В комнате сохраняются только параметры: после повторного открытия модели локальный набор с картами нужно открыть снова.</p>`;
    host.append(panel);
    const modelSelect = panel.querySelector('[data-pack-model]'), input = panel.querySelector('[data-pack-file]'), summary = panel.querySelector('[data-pack-summary]');
    let alive = true, revision = 0, busy = false, plan = null, file = null, modelKey = '';
    const downloads = new Map();
    const model = () => getModels().find((m) => m.obj.uuid === modelSelect.value);
    function resetPlan() { plan = file = null; input.value = ''; summary.textContent = ''; updateButtons(); }
    function updateButtons() {
        for (const el of panel.querySelectorAll('input,select,button')) el.disabled = busy;
        for (const action of ['save', 'open']) panel.querySelector(`[data-pack-action=${action}]`).disabled = busy || !model();
        panel.querySelector('[data-pack-action=apply]').disabled = busy || !plan?.matches.length;
        const cancel = panel.querySelector('[data-pack-action=cancel]'); cancel.hidden = !busy; cancel.disabled = false;
    }
    function setBusy(value) { busy = value; onBusy(value); updateButtons(); }
    function refresh() {
        if (!alive) return;
        const models = getModels(), nextModels = models.map((m) => m.obj.uuid).join('|');
        if (nextModels !== modelKey) {
            revision++; if (busy) setBusy(false); resetPlan();
            const previous = modelSelect.value; modelSelect.replaceChildren();
            for (const m of models) modelSelect.add(new Option(m.name || m.obj.userData.sourceFileName || 'Модель', m.obj.uuid));
            if (models.some((m) => m.obj.uuid === previous)) modelSelect.value = previous;
            modelKey = nextModels;
        }
        updateButtons();
    }
    async function run(action, chosenFile) {
        const target = model(); if (!target || busy) return;
        const token = ++revision;
        const current = () => alive && token === revision && getModels().includes(target) && model() === target;
        setBusy(true);
        try {
            if (action === 'save') {
                const blob = await saveMaterialPackFile(getEntries(target), { isCurrent: current, onProgress: (n, total) => { if (current()) tell(`Подготовка набора: ${n} из ${total}…`); } });
                if (!current()) return;
                const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url;
                a.download = `${(target.name || 'materials').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_. -]/gu, '_')}.lpmat`;
                a.click(); downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 60000));
                tell('Файл набора готов. Сохраните его в выбранную папку на компьютере.');
            } else if (action === 'preview') {
                plan = file = null;
                const source = await openMaterialPackFile(chosenFile, { isCurrent: current }); if (!current()) return;
                file = chosenFile; plan = { ...matchMaterialPack(source.pack, getEntries(target)), source };
                summary.textContent = `${file.name}. Совпало: ${plan.matches.length}. Без пары: ${plan.missing.length}. Неоднозначных: ${plan.ambiguous.length}.` + (plan.missing.length ? ` Без пары: ${plan.missing.join(', ')}.` : '') + (plan.ambiguous.length ? ` Пропустим неоднозначные: ${plan.ambiguous.join(', ')}.` : '');
                tell(plan.matches.length ? 'Проверьте сопоставление и нажмите «Применить».' : 'Совпадений по именам нет. Материалы модели сохранены.');
            } else if (action === 'apply' && plan) {
                // Re-open with the apply generation; the preview guard has expired.
                const source = await openMaterialPackFile(file, { isCurrent: current });
                const count = await apply({ ...matchMaterialPack(source.pack, getEntries(target)), source }, current); if (!current()) return;
                resetPlan(); summary.textContent = `Применено материалов: ${count}. Остальные материалы модели сохранены.`;
                tell('Набор применён. «Сохранить в комнате» сохранит только параметры, без текстур.');
            }
        } catch (error) { if (current()) tell(error.message); }
        finally { if (alive && token === revision) setBusy(false); }
    }
    function click(event) {
        const action = event.target.closest('[data-pack-action]')?.dataset.packAction; if (!action) return;
        if (action === 'cancel') { revision++; setBusy(false); resetPlan(); tell('Операция отменена.'); return; }
        if (busy) return;
        if (action === 'open') { input.click(); return; }
        void run(action);
    }
    function change(event) {
        if (event.target === modelSelect) { revision++; resetPlan(); }
        if (event.target === input) { const chosen = input.files[0]; input.value = ''; if (chosen) void run('preview', chosen); }
    }
    panel.addEventListener('click', click); panel.addEventListener('change', change); refresh();
    return { refresh, get busy() { return busy; }, cancel() { revision++; if (busy) setBusy(false); resetPlan(); }, dispose() {
        alive = false; revision++; for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); } downloads.clear();
        panel.removeEventListener('click', click); panel.removeEventListener('change', change); panel.remove();
    } };
}
