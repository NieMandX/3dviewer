export function isRegisteredAccount(user) {
    return !!(user?.id && user?.email && user.is_anonymous !== true);
}

export function canManageProject(user, isSuperuser, project) {
    return !!(isRegisteredAccount(user) && project?.id
        && (isSuperuser || project.owner_id === user.id));
}

export function canManageRoom(user, isSuperuser, room, project) {
    return !!(room?.id && project?.id === room.project_id
        && canManageProject(user, isSuperuser, project));
}
