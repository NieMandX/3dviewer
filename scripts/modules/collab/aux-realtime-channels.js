export function createAuxRealtimeChannelRegistry() {
    const channels = new Map();

    function normalizeLabel(label) {
        return String(label || '').trim();
    }

    function get(label) {
        const key = normalizeLabel(label);
        if (!key) return null;
        return channels.get(key) || null;
    }

    function set(label, channel) {
        const key = normalizeLabel(label);
        if (!key || !channel) return null;
        channels.set(key, channel);
        return channel;
    }

    function clear(label, expectedChannel = null) {
        const key = normalizeLabel(label);
        if (!key) return null;
        const current = channels.get(key) || null;
        if (!current) return null;
        if (expectedChannel && current !== expectedChannel) return null;
        channels.delete(key);
        return current;
    }

    function clearAll() {
        const entries = Array.from(channels.values()).filter(Boolean);
        channels.clear();
        return entries;
    }

    async function remove(label, options = {}) {
        const target = clear(label, options.channel || null);
        if (!target) return false;
        const removeChannel = typeof options.removeChannel === 'function' ? options.removeChannel : null;
        if (removeChannel) {
            try {
                await removeChannel(target);
            } catch (_) {}
        }
        return true;
    }

    return Object.freeze({
        get,
        set,
        clear,
        clearAll,
        remove,
        values: () => Array.from(channels.values()).filter(Boolean),
        size: () => channels.size,
    });
}
