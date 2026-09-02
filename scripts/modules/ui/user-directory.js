export const USER_DIRECTORY_PAGE_SIZE = 50;

export function emptyUserDirectory() {
    return { query: '', page: 0, total: null, users: [] };
}

function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    });
}

export function renderUserDirectory(root, { state, busy = false, onSearch, onPage } = {}) {
    root.replaceChildren();
    const form = document.createElement('form');
    form.className = 'user-directory-search';
    form.setAttribute('role', 'search');
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'collab-input';
    input.placeholder = 'Email или имя';
    input.setAttribute('aria-label', 'Поиск пользователей по email или имени');
    input.maxLength = 200;
    input.value = state.query;
    input.disabled = busy;
    const search = document.createElement('button');
    search.type = 'submit';
    search.className = 'btn';
    search.textContent = 'Найти';
    search.disabled = busy;
    form.append(input, search);
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!busy) onSearch?.(input.value.trim());
    });
    root.append(form);

    if (state.total === null) return;
    if (!state.users.length) {
        const empty = document.createElement('div');
        empty.className = 'room-content-empty';
        empty.textContent = 'Пользователи не найдены.';
        root.append(empty);
    } else {
        const table = document.createElement('table');
        table.className = 'user-directory-table';
        table.setAttribute('aria-label', 'Зарегистрированные пользователи');
        const labels = ['Пользователь', 'Роль', 'Регистрация', 'Последний вход'];
        const head = table.createTHead().insertRow();
        labels.forEach((label) => {
            const th = document.createElement('th');
            th.scope = 'col';
            th.textContent = label;
            head.append(th);
        });
        const body = table.createTBody();
        state.users.forEach((user) => {
            const row = body.insertRow();
            row.dataset.userId = user.user_id;
            const account = row.insertCell();
            const email = document.createElement('div');
            email.className = 'user-directory-email';
            email.textContent = user.email;
            account.append(email);
            if (user.display_name) {
                const name = document.createElement('div');
                name.className = 'user-directory-name';
                name.textContent = user.display_name;
                account.append(name);
            }
            if (!user.email_confirmed) {
                const status = document.createElement('div');
                status.className = 'user-directory-name';
                status.textContent = 'Email не подтверждён';
                account.append(status);
            }
            [user.role === 'superuser' ? 'Суперпользователь' : 'Пользователь',
                formatDate(user.created_at), formatDate(user.last_sign_in_at)].forEach((value, index) => {
                const cell = row.insertCell();
                cell.dataset.label = labels[index + 1];
                cell.textContent = value;
            });
        });
        root.append(table);
    }
    const pages = Math.max(1, Math.ceil(state.total / USER_DIRECTORY_PAGE_SIZE));
    const pagination = document.createElement('div');
    pagination.className = 'user-directory-pagination';
    const label = document.createElement('span');
    label.textContent = `Страница ${state.page + 1} из ${pages}`;
    for (const [text, delta, disabled] of [['Назад', -1, state.page === 0], ['Далее', 1, state.page + 1 >= pages]]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn';
        button.textContent = text;
        button.disabled = busy || disabled;
        button.addEventListener('click', () => { if (!button.disabled) onPage?.(state.page + delta); });
        pagination.append(button);
    }
    pagination.insertBefore(label, pagination.lastChild);
    root.append(pagination);
}
