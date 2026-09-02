import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function runUserDirectorySmoke({ page, diagnostics }) {
    try {
        await page.evaluate(() => {
            const client = window.__adminSmokeClient;
            const rpc = client.rpc.bind(client);
            const users = Array.from({ length: 52 }, (_, index) => ({
                user_id: `account-${index}`, email: `account-${index}@example.com`,
                display_name: `User ${index}`, role: index === 0 ? 'superuser' : 'user',
                created_at: '2026-09-01T08:00:00Z', last_sign_in_at: index ? null : '2026-09-02T08:00:00Z',
                email_confirmed: index !== 1,
            }));
            users[1].email = 'account-without-projects@example.com';
            users[1].display_name = '<img src=x onerror="window.__directoryXss=true">';
            window.__directoryCalls = [];
            client.rpc = (name, params) => {
                if (name === 'is_superuser') return Promise.resolve({ data: true, error: null });
                if (name !== 'admin_list_registered_users') return rpc(name, params);
                window.__directoryCalls.push(params);
                return { abortSignal(signal) {
                    window.__directorySignal = signal;
                    const query = params.search_text.toLowerCase();
                    const matches = users.filter((user) => `${user.email} ${user.display_name}`.toLowerCase().includes(query));
                    const result = { data: { total: matches.length,
                        users: matches.slice(params.page_offset, params.page_offset + params.page_size) }, error: null };
                    if (window.__directoryError) return Promise.resolve({ data: null, error: window.__directoryError });
                    if (window.__holdDirectory) return new Promise((resolve) => {
                        window.__resolveDirectory = () => resolve(result);
                    });
                    return Promise.resolve(result);
                } };
            };
        });
        await page.locator('#collabStatusBtn').click();
        await page.locator('#collabShowLoginBtn').click();
        await page.locator('#collabEmail').fill('switch@example.com');
        await page.locator('#collabPassword').fill('secret123');
        await page.locator('#collabJoinBtn').click();
        await page.locator('#collabRoomManageBtn').click();
        await page.waitForFunction(() => !document.querySelector('#roomContentRefresh').disabled);
        await page.locator('#roomContentTabUsers').click();
        await page.waitForFunction(() => document.querySelectorAll('.user-directory-table tbody tr').length === 50);
        assert.match(await page.locator('#roomContentSummary').innerText(), /52/);
        assert.equal(await page.locator('#roomContentRoomSelect').isVisible(), false);
        assert.equal(await page.locator('[data-user-id="account-1"]').count(), 1, 'User with no projects is missing');
        assert.equal(await page.locator('.user-directory-table img').count(), 0, 'User name interpreted as HTML');
        assert.equal(await page.evaluate(() => !!window.__directoryXss), false);
        await page.locator('.user-directory-pagination').getByRole('button', { name: 'Далее' }).click();
        await page.waitForFunction(() => document.querySelectorAll('.user-directory-table tbody tr').length === 2);
        assert.equal(await page.locator('[data-user-id="account-50"]').count(), 1);
        const search = page.getByRole('searchbox', { name: 'Поиск пользователей по email или имени' });
        await search.fill('without-projects');
        await search.press('Enter');
        await page.waitForFunction(() => document.querySelectorAll('.user-directory-table tbody tr').length === 1);
        assert.match(await page.locator('#roomContentSummary').innerText(), /Найдено пользователей: 1/);
        assert.equal(await page.evaluate(() => window.__directoryCalls.at(-1).page_offset), 0);
        await search.fill('no-such-account');
        await search.press('Enter');
        await page.getByText('Пользователи не найдены.', { exact: true }).waitFor();
        await search.fill('');
        await search.press('Enter');
        await page.waitForFunction(() => document.querySelectorAll('.user-directory-table tbody tr').length === 50);
        await page.setViewportSize({ width: 1440, height: 960 });
        await page.screenshot({ path: join(tmpdir(), 'lpmview-users-desktop.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: join(tmpdir(), 'lpmview-users-mobile.png') });
        assert.equal(await page.locator('.room-content-panel').evaluate((panel) => {
            const rect = panel.getBoundingClientRect();
            return rect.left < 0 || rect.right > innerWidth || panel.scrollWidth > panel.clientWidth + 1;
        }), false, 'User directory overflows mobile viewport');
        await page.setViewportSize({ width: 1440, height: 960 });

        await page.evaluate(() => { window.__holdDirectory = true; });
        await page.locator('#roomContentRefresh').click();
        await page.waitForFunction(() => !!window.__resolveDirectory);
        await page.locator('#roomContentClose').click();
        assert.equal(await page.evaluate(() => window.__directorySignal.aborted), true, 'Closing panel did not abort request');
        assert.equal(await page.locator('#roomContentList').innerHTML(), '', 'Directory persisted in closed modal DOM');
        await page.evaluate(() => { window.__holdDirectory = false; });
        await page.locator('#collabRoomManageBtn').click();
        await page.waitForFunction(() => !document.querySelector('#roomContentRefresh').disabled);
        await page.locator('#roomContentTabUsers').click();
        await page.waitForFunction(() => document.querySelectorAll('.user-directory-table tbody tr').length === 50);
        await search.fill('account-51@');
        await search.press('Enter');
        await page.waitForFunction(() => document.querySelectorAll('.user-directory-table tbody tr').length === 1);
        await page.evaluate(async () => { window.__resolveDirectory(); await new Promise(requestAnimationFrame); });
        assert.equal(await page.locator('[data-user-id="account-51"]').count(), 1, 'Stale response replaced current search');
        assert.equal(await page.locator('.user-directory-table tbody tr').count(), 1);

        await page.evaluate(() => { window.__directoryError = { code: 'PGRST202', message: 'Function not found' }; });
        await page.locator('#roomContentRefresh').click();
        await page.getByText('Список пользователей недоступен: требуется обновление базы данных.', { exact: true }).waitFor();
        assert.equal(await page.locator('.user-directory-table tbody tr').count(), 0, 'Error retained old directory');
        await page.evaluate(() => { window.__directoryError = { code: '42501', message: 'superuser access required' }; });
        await page.locator('#roomContentRefresh').click();
        await page.getByText('Не удалось загрузить пользователей: superuser access required', { exact: true }).waitFor();
        await page.locator('#roomContentTabProjects').click();
        assert.equal(await page.locator('#roomContentRoomSelect').isVisible(), true);
        assert.equal(await page.locator('.project-admin-project').count(), 3);

        await page.evaluate(() => { window.__directoryError = null; window.__holdDirectory = true; });
        await page.locator('#roomContentTabUsers').click();
        await page.waitForFunction(() => document.querySelector('#roomContentRefresh').disabled);
        await page.evaluate(async () => {
            await window.viewerApp.dispose();
            window.__resolveDirectory();
            await new Promise(requestAnimationFrame);
        });
        assert.equal(await page.locator('#roomContentList').innerHTML(), '', 'Disposed app retained account data');
        assert.equal(await page.evaluate(() => window.__directorySignal.aborted), true);
        diagnostics.assertNoErrors('Superuser directory smoke');
    } finally {
        await page.close();
    }
}
