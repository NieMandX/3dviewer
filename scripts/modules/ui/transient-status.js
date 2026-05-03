export function createTransientStatusController(options = {}) {
    const setStatusMessage = typeof options.setStatusMessage === 'function' ? options.setStatusMessage : () => {};
    const getStatusMessage = typeof options.getStatusMessage === 'function' ? options.getStatusMessage : () => '';

    let token = 0;

    function begin() {
        const ownToken = ++token;
        let lastMessage = '';
        let kept = false;

        const isCurrent = () => ownToken === token;

        function set(message = '') {
            if (!isCurrent()) return false;
            lastMessage = String(message ?? '');
            kept = false;
            setStatusMessage(lastMessage);
            return true;
        }

        function clear() {
            if (!isCurrent() || kept || !lastMessage) return false;
            if (String(getStatusMessage() ?? '') !== lastMessage) return false;
            setStatusMessage('');
            lastMessage = '';
            return true;
        }

        function keep() {
            if (!isCurrent()) return false;
            kept = true;
            lastMessage = '';
            return true;
        }

        return Object.freeze({
            set,
            clear,
            keep,
            isCurrent,
        });
    }

    return Object.freeze({ begin });
}
