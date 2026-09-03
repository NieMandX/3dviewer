function appendText(parent, className, text) {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
}

function formatUpdatedAt(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
}

export function renderGisAdmin(root, {
    state = {}, busy = false, onSave = () => {}, onClear = () => {}, onRefresh = () => {},
} = {}) {
    root.replaceChildren();
    const panel = document.createElement('form');
    panel.className = 'gis-admin-panel';
    panel.autocomplete = 'off';

    appendText(panel, 'gis-admin-title', 'Администрирование 2ГИС');
    appendText(panel, 'gis-admin-description',
        'Ключ хранится на сервере и применяется ко всем посетителям viewer. В браузер значение ключа не передаётся.');

    const status = document.createElement('div');
    status.className = `gis-admin-key-status ${state.configured ? 'configured' : 'missing'}`;
    const statusLabel = state.loading ? 'Проверка настройки…'
        : state.configured ? 'API-ключ настроен' : 'API-ключ не настроен';
    appendText(status, 'gis-admin-key-state', statusLabel);
    const metadata = [
        state.fingerprint ? `Отпечаток: ${state.fingerprint}` : '',
        formatUpdatedAt(state.updatedAt) ? `Обновлён: ${formatUpdatedAt(state.updatedAt)}` : '',
    ].filter(Boolean).join(' · ');
    if (metadata) appendText(status, 'gis-admin-key-meta', metadata);
    panel.appendChild(status);

    const label = document.createElement('label');
    label.className = 'gis-admin-key-field';
    const labelText = document.createElement('span');
    labelText.textContent = state.configured ? 'Новый API-ключ' : 'API-ключ';
    const input = document.createElement('input');
    input.type = 'password';
    input.name = 'gis-api-key';
    input.autocomplete = 'new-password';
    input.spellcheck = false;
    input.maxLength = 256;
    input.placeholder = state.configured ? 'Введите ключ только для замены' : 'Введите API-ключ 2ГИС';
    input.disabled = busy || state.loading;
    label.append(labelText, input);
    panel.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'gis-admin-actions';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'btn primary';
    save.textContent = state.configured ? 'Заменить ключ' : 'Сохранить ключ';
    save.disabled = busy || state.loading;
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'btn';
    refresh.textContent = 'Обновить статус';
    refresh.disabled = busy || state.loading;
    refresh.addEventListener('click', () => onRefresh());
    actions.append(save, refresh);
    if (state.configured) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'btn danger';
        clear.textContent = 'Удалить ключ';
        clear.disabled = busy || state.loading;
        clear.addEventListener('click', () => onClear());
        actions.appendChild(clear);
    }
    panel.appendChild(actions);
    panel.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = input.value.trim();
        if (!value || busy || state.loading) {
            if (!value) input.focus();
            return;
        }
        onSave(value);
    });
    root.appendChild(panel);
}
