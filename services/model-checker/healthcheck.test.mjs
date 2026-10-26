import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('local health probe checks services, disk, endpoint and fail-closed responses', () => {
    execFileSync('python3', ['-B', fileURLToPath(new URL('./deploy/healthcheck_test.py', import.meta.url))],
        { stdio: 'pipe', timeout: 30000 });
});
