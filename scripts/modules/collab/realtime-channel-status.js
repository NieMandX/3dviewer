const FAILURE_STATUSES = new Set(['CLOSED', 'CHANNEL_ERROR', 'TIMED_OUT']);

export function normalizeRealtimeStatus(status) {
    return String(status || '').trim().toUpperCase();
}

export function isRealtimeFailureStatus(status) {
    return FAILURE_STATUSES.has(normalizeRealtimeStatus(status));
}

export function formatRealtimeFailureReason(label = 'realtime', status = '', error = null) {
    const safeLabel = String(label || 'realtime').trim() || 'realtime';
    if (error) return `${safeLabel}:SUBSCRIBE_ERROR`;
    const safeStatus = normalizeRealtimeStatus(status) || 'UNKNOWN';
    return `${safeLabel}:${safeStatus}`;
}

export function createRealtimeChannelStatusHandler(options = {}) {
    const label = options.label || 'realtime';
    const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
    const onSubscribed = typeof options.onSubscribed === 'function' ? options.onSubscribed : null;
    const onFailure = typeof options.onFailure === 'function' ? options.onFailure : null;

    return (statusValue, error = null) => {
        if (!isCurrent()) return;
        const status = normalizeRealtimeStatus(statusValue);
        if (status === 'SUBSCRIBED') {
            onSubscribed?.({ status, label });
            return;
        }
        if (error || isRealtimeFailureStatus(status)) {
            onFailure?.({
                status,
                error,
                label,
                reason: formatRealtimeFailureReason(label, status, error),
            });
        }
    };
}
