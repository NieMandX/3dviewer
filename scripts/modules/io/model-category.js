// Explicit package names take precedence so an incomplete VPM package does not
// silently escape validation by becoming environment content.
export function classifyZIP(name, hasGeoJSON = false) {
    const base = String(name || '').split(/[\\/]/).pop();
    if (/^\d/.test(base)) return 'NPM';
    if (/^SM/i.test(base)) return 'SM';
    return hasGeoJSON ? 'SM' : 'ENV';
}

export function isEnvironmentModel(model) {
    return model?.category === 'ENV' || model?.sourceContainer === 'file';
}
