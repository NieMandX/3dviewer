import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const scriptsDir = join(projectRoot, 'scripts');
const servicesDir = join(projectRoot, 'services', 'voice-api');
const extraFiles = [join(projectRoot, 'config', 'runtime.js')];

async function walkJsFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await walkJsFiles(entryPath));
            continue;
        }
        if (entry.isFile() && /\.m?js$/.test(entry.name)) {
            files.push(entryPath);
        }
    }
    return files;
}

function runSyntaxCheck(filePath) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ['--experimental-default-type=module', '--check', filePath],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );

        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk || '');
        });

        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr.trim() || `Syntax check failed for ${filePath}`));
        });
    });
}

const scriptFiles = await walkJsFiles(scriptsDir);
const serviceFiles = await walkJsFiles(servicesDir);
const filesToCheck = [...new Set([...scriptFiles, ...serviceFiles, ...extraFiles])].sort();

console.log(`Checking syntax for ${filesToCheck.length} files...`);

for (const filePath of filesToCheck) {
    process.stdout.write(`- ${relative(projectRoot, filePath)}\n`);
    await runSyntaxCheck(filePath);
}

console.log('Syntax checks passed.');
