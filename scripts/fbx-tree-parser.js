/**
 * Simplified FBX tree reader focused on extracting the Objects.Model branch
 * with Properties70 arrays so that we can retrieve Lcl Translation/Rotation.
 */
export function readFBXTreeFromArrayBuffer(arrayBuffer) {
    if (!arrayBuffer) return null;
    try {
        const text = new TextDecoder('utf-8').decode(arrayBuffer);
        const start = text.indexOf('Objects:');
        if (start === -1) return null;
        const end = text.indexOf('Connections:', start);
        const slice = text.substring(start, end === -1 ? undefined : end);
        const models = {};
        const modelRegex = /Model:\s*(\d+),\s*"Model::([^"]+)"[^{]*?Properties70\s*{([\s\S]*?)}/gi;
        let match;
        while ((match = modelRegex.exec(slice))) {
            const id = match[1];
            const name = match[2];
            const block = match[3];
            const properties = [];
            const propRegex = /P:\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]*)",\s*([\d\-\.eE ,]+)/gi;
            let propMatch;
            while ((propMatch = propRegex.exec(block))) {
                const values = propMatch[5]
                    .split(',')
                    .map(s => parseFloat(s.trim()))
                    .filter(Number.isFinite);
                if (values.length >= 3) {
                    properties.push([propMatch[1], propMatch[2], propMatch[3], propMatch[4], ...values.slice(0, 3)]);
                }
            }
            models[id] = {
                attrName: name,
                Properties70: {
                    Property: properties
                }
            };
        }
        if (!Object.keys(models).length) return null;
        return {
            Objects: {
                Model: models
            }
        };
    } catch (err) {
        console.warn('[FBX parser] Failed to read tree', err);
        return null;
    }
}
