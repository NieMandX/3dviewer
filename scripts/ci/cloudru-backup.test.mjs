import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Cloud.ru backup safeguards, snapshot consistency and retention', () => {
    execFileSync('python3', ['-B', fileURLToPath(new URL('../../infra/supabase-cloudru/backup_test.py', import.meta.url))],
        { stdio: 'pipe', timeout: 30000 });
});
