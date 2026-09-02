import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function runProjectAdminTreeSmoke(context, baseUrl) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
        await page.goto(`${baseUrl}/__smoke_blank`);
        await page.addStyleTag({ url: `${baseUrl}/styles/viewer.css` });
        await page.evaluate(async () => {
            const { renderProjectAdminTree } = await import('/scripts/modules/ui/project-admin-tree.js');
            const { canManageRoom } = await import('/scripts/modules/collab/project-permissions.js');
            const html = await fetch('/index.html').then((response) => response.text());
            const modal = new DOMParser().parseFromString(html, 'text/html').getElementById('roomContentModal');
            modal.classList.add('show');
            document.body.append(modal);
            const a = { id: 'a', name: 'Шаболовка 35', owner_id: 'owner-a' };
            const b = { id: 'b', name: 'Антонова-Овсеенко · фасады', owner_id: 'owner-b' };
            const rooms = [
                { id: 'r1', project_id: 'a', slug: 'highpoly', owner_id: 'owner-a' },
                { id: 'r2', project_id: 'b', slug: 'Дневной вариант', owner_id: 'owner-b' },
            ];
            const user = { id: 'owner-a', email: 'owner-a@example.com' };
            const root = document.querySelector('#roomContentList');
            const render = (account, superuser) => renderProjectAdminTree(root, {
                projects: [a, b], rooms, user: account, isSuperuser: superuser,
                owners: new Map([['owner-a', 'owner-a@example.com'], ['owner-b', 'owner-b@example.com']]),
                onRenameRoom: () => { globalThis.__adminRenameClicked = true; },
            });
            render(user, false);
            if (document.querySelectorAll('.project-admin-project').length !== 1) throw new Error('Owner sees foreign projects');
            if (canManageRoom(user, false, { ...rooms[1], owner_id: user.id }, b)) throw new Error('Legacy room owner bypasses project ownership');
            render({ ...user, is_anonymous: true }, true);
            if (root.children.length) throw new Error('Anonymous account can open management panel');
            render(user, true);
            document.querySelector('#roomContentUserEmail').textContent = 'admin@example.com';
            document.querySelector('#roomContentSummary').textContent = 'Проектов: 2 · Комнат: 2';
            document.querySelector('#roomContentRoomSelect').innerHTML = '<option>Все проекты</option>';
        });
        assert.equal(await page.locator('.project-admin-project').count(), 2);
        assert.equal(await page.locator('.project-admin-project[open]').count(), 0);
        await page.setViewportSize({ width: 1440, height: 960 });
        await page.locator('[data-project-id="a"] > summary').click();
        await page.locator('[data-room-id="r1"]').getByRole('button', { name: 'Переименовать', exact: true }).click();
        assert.equal(await page.evaluate(() => globalThis.__adminRenameClicked), true);
        await page.screenshot({ path: join(tmpdir(), 'lpmview-admin-desktop.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: join(tmpdir(), 'lpmview-admin-mobile.png') });
        const overflow = await page.locator('#roomContentModal .room-content-panel').evaluate((panel) => {
            const box = panel.getBoundingClientRect();
            return box.left < 0 || box.right > innerWidth || panel.scrollWidth > panel.clientWidth + 1;
        });
        assert.equal(overflow, false, 'Admin panel overflows mobile viewport');
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
}
