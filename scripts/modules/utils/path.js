export function basename(p) {
    return (p || '').split(/[\\/]/).pop();
}

