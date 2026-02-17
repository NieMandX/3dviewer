export function getRoomSlugFromUrl(windowRef = (typeof window !== 'undefined' ? window : null)) {
    try {
        const url = new URL(windowRef?.location?.href || '');
        return url.searchParams.get('room') || '';
    } catch (_) {
        return '';
    }
}

export function getProjectSlugFromUrl(windowRef = (typeof window !== 'undefined' ? window : null)) {
    try {
        const url = new URL(windowRef?.location?.href || '');
        return url.searchParams.get('project') || '';
    } catch (_) {
        return '';
    }
}

export function setRoomSlugInUrl(
    projectSlug,
    roomSlug,
    windowRef = (typeof window !== 'undefined' ? window : null)
) {
    try {
        const url = new URL(windowRef?.location?.href || '');
        if (projectSlug) {
            url.searchParams.set('project', projectSlug);
        } else {
            url.searchParams.delete('project');
        }
        if (roomSlug) {
            url.searchParams.set('room', roomSlug);
        } else {
            url.searchParams.delete('room');
        }
        windowRef?.history?.replaceState?.({}, '', url.toString());
        return url.toString();
    } catch (_) {
        return '';
    }
}

export function formatChatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function makeSlug(length = 8) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
}

export function slugifyName(value) {
    const cleaned = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return cleaned || '';
}

export function resolveDisplayName(
    value,
    storage = (typeof localStorage !== 'undefined' ? localStorage : null)
) {
    const trimmed = String(value || '').trim();
    if (trimmed) return trimmed;
    const stored = String(storage?.getItem?.('lpmview.displayName') || '').trim();
    if (stored) return stored;
    return 'Guest';
}

export function normalizeDisplayName(value) {
    const trimmed = String(value || '').trim();
    return trimmed || 'Guest';
}

export function normalizeEmailInput(value) {
    let email = String(value || '').trim();
    const angleMatch = email.match(/<([^>]+)>/);
    if (angleMatch) {
        email = angleMatch[1];
    }
    return email.replace(/\s+/g, '');
}

export function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

export function isExistingSignupError(err) {
    const code = String(err?.code || '').toLowerCase();
    if (code === 'user_already_exists' || code === 'email_address_already_in_use') {
        return true;
    }
    const message = String(err?.message || '').toLowerCase();
    return (
        message.includes('already registered') ||
        message.includes('already been registered') ||
        message.includes('user already') ||
        message.includes('user exists') ||
        message.includes('email already') ||
        message.includes('user_already_exists')
    );
}

export function isRegisteredUser(user) {
    return !!(user && user.email);
}

export function buildResetRedirectUrl(windowRef = (typeof window !== 'undefined' ? window : null)) {
    try {
        const url = new URL(windowRef?.location?.href || '');
        const removeKeys = ['type', 'token', 'code', 'access_token', 'refresh_token'];
        removeKeys.forEach((key) => url.searchParams.delete(key));
        url.hash = '';
        return url.toString();
    } catch (_) {
        return `${windowRef?.location?.origin || ''}${windowRef?.location?.pathname || ''}`;
    }
}

export function isRecoveryUrl(windowRef = (typeof window !== 'undefined' ? window : null)) {
    try {
        const url = new URL(windowRef?.location?.href || '');
        if (url.searchParams.get('type') === 'recovery') return true;
        const hashParams = new URLSearchParams(String(url.hash || '').replace(/^#/, ''));
        return hashParams.get('type') === 'recovery';
    } catch (_) {
        return false;
    }
}

export function clearRecoveryUrl(windowRef = (typeof window !== 'undefined' ? window : null)) {
    try {
        const url = new URL(windowRef?.location?.href || '');
        const removeKeys = ['type', 'token', 'code', 'access_token', 'refresh_token'];
        removeKeys.forEach((key) => url.searchParams.delete(key));
        url.hash = '';
        windowRef?.history?.replaceState?.({}, '', url.toString());
    } catch (_) {}
}
