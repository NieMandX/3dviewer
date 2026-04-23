const DEFAULT_STATE_KEY = '__LPM_CONSOLE_DIAGNOSTICS_GATE__';

export const FBX_Z_UP_DIAGNOSTIC_RULE = Object.freeze({
    id: 'fbx-z-up',
    includes: ['z-up coordinate system', 'vertex data are not converted'],
});

function normalizeConsolePayload(args) {
    if (!Array.isArray(args) || !args.length) return '';
    return args
        .map((arg) => {
            if (typeof arg === 'string') return arg;
            if (arg && typeof arg === 'object' && typeof arg.message === 'string') return arg.message;
            return '';
        })
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

function matchesRule(payload, rule) {
    if (!payload || !rule) return false;
    const includes = Array.isArray(rule.includes) ? rule.includes : [];
    if (!includes.length) return false;
    return includes.every((token) => payload.includes(String(token || '').toLowerCase()));
}

function cloneRuleStats(stats) {
    const next = {};
    for (const [key, value] of Object.entries(stats || {})) {
        next[key] = value;
    }
    return next;
}

export function installConsoleDiagnosticsGate(options = {}) {
    if (typeof console === 'undefined') return { installed: false };

    const root = typeof globalThis !== 'undefined' ? globalThis : null;
    const stateKey = options.stateKey || DEFAULT_STATE_KEY;
    const existing = root?.[stateKey];
    if (existing?.installed) return existing.api;

    const signatures = Array.isArray(options.signatures) && options.signatures.length
        ? options.signatures
        : [FBX_Z_UP_DIAGNOSTIC_RULE];
    const patchLog = options.patchLog === true;
    const verbose = options.verbose === true;

    const originalWarn = typeof console.warn === 'function' ? console.warn.bind(console) : null;
    const originalError = typeof console.error === 'function' ? console.error.bind(console) : null;
    const originalLog = patchLog && typeof console.log === 'function' ? console.log.bind(console) : null;

    const stats = {
        suppressed: 0,
        byRule: {},
    };

    function shouldSuppress(args) {
        if (verbose) return false;
        const payload = normalizeConsolePayload(args);
        if (!payload) return false;

        for (const rule of signatures) {
            if (!matchesRule(payload, rule)) continue;
            const ruleId = rule.id || 'rule';
            stats.suppressed += 1;
            stats.byRule[ruleId] = (stats.byRule[ruleId] || 0) + 1;
            return true;
        }

        return false;
    }

    if (originalWarn) {
        console.warn = (...args) => {
            if (!shouldSuppress(args)) originalWarn(...args);
        };
    }
    if (originalError) {
        console.error = (...args) => {
            if (!shouldSuppress(args)) originalError(...args);
        };
    }
    if (originalLog) {
        console.log = (...args) => {
            if (!shouldSuppress(args)) originalLog(...args);
        };
    }

    const api = Object.freeze({
        installed: true,
        getStats() {
            return {
                suppressed: stats.suppressed,
                byRule: cloneRuleStats(stats.byRule),
            };
        },
        dispose() {
            if (originalWarn) console.warn = originalWarn;
            if (originalError) console.error = originalError;
            if (originalLog) console.log = originalLog;
            if (root?.[stateKey]?.api === api) {
                delete root[stateKey];
            }
        },
    });

    if (root) {
        root[stateKey] = { installed: true, api };
    }

    return api;
}
