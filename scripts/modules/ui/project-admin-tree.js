import { isRegisteredAccount, canManageProject, canManageRoom } from '../collab/project-permissions.js';

export function renderProjectAdminTree(root, {
    projects = [], rooms = [], user, isSuperuser = false, owners = new Map(), busy = false,
    onCreateProject, onCreateRoom, onRenameProject, onRenameRoom, onDeleteProject, onDeleteRoom,
} = {}) {
    const expanded = new Set(Array.from(root.querySelectorAll('.project-admin-project[open]'))
        .map((node) => node.dataset.projectId));
    root.replaceChildren();
    if (!isRegisteredAccount(user)) return;
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        node.className = className;
        if (text != null) node.textContent = text;
        return node;
    };
    const command = (label, action, danger = false) => {
        const button = el('button', `btn${danger ? ' danger' : ''}`, label);
        button.type = 'button';
        button.disabled = busy;
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!button.disabled) action?.();
        });
        return button;
    };
    const bar = el('div', 'project-admin-bar');
    bar.append(el('span', 'project-admin-role', isSuperuser ? 'Суперпользователь · Все проекты' : 'Владелец · Мои проекты'));
    bar.append(command('Создать проект', onCreateProject));
    root.append(bar);
    if (!projects.length) {
        root.append(el('div', 'room-content-empty', 'Нет проектов.'));
        return;
    }
    const tree = el('div', 'project-admin-tree');
    for (const project of projects) {
        if (!canManageProject(user, isSuperuser, project)) continue;
        const details = el('details', 'project-admin-project');
        details.dataset.projectId = project.id;
        details.open = expanded.has(project.id);
        const summary = el('summary', 'project-admin-summary');
        const heading = el('div', 'project-admin-heading');
        heading.append(el('strong', 'project-admin-name', project.name || project.slug));
        const owner = owners.get(project.owner_id) || (project.owner_id === user.id ? user.email : project.owner_id);
        heading.append(el('span', 'project-admin-owner', `Владелец: ${owner || 'не указан'}`));
        const projectRooms = rooms.filter((room) => room.project_id === project.id);
        summary.append(heading, el('span', 'project-admin-count', `Комнат: ${projectRooms.length}`));
        details.append(summary);
        const actions = el('div', 'project-admin-actions');
        actions.append(
            command('Создать комнату', () => onCreateRoom?.(project)),
            command('Переименовать проект', () => onRenameProject?.(project)),
            command('Удалить проект', () => onDeleteProject?.(project), true),
        );
        details.append(actions);
        if (!projectRooms.length) details.append(el('div', 'room-content-empty', 'Нет комнат.'));
        for (const room of projectRooms) {
            if (!canManageRoom(user, isSuperuser, room, project)) continue;
            const row = el('div', 'project-admin-room');
            row.dataset.roomId = room.id;
            row.append(el('span', 'project-admin-name', room.slug));
            const roomActions = el('div', 'project-admin-actions');
            roomActions.append(
                command('Переименовать', () => onRenameRoom?.(room, project)),
                command('Удалить комнату', () => onDeleteRoom?.(room), true),
            );
            row.append(roomActions);
            details.append(row);
        }
        tree.append(details);
    }
    root.append(tree);
}
