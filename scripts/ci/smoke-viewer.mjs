import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const roomProject = process.env.LPMVIEW_SMOKE_PROJECT || 'shmit';
const roomSlug = process.env.LPMVIEW_SMOKE_ROOM || '1';

const MIME_TYPES = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.exr', 'application/octet-stream'],
    ['.fbx', 'application/octet-stream'],
    ['.hdr', 'application/octet-stream'],
    ['.html', 'text/html; charset=utf-8'],
    ['.ico', 'image/x-icon'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.webp', 'image/webp'],
    ['.zip', 'application/zip'],
]);

function resolveFsPath(urlPathname) {
    const normalizedPath = normalize(decodeURIComponent(urlPathname.split('?')[0] || '/'));
    const relativePath = normalizedPath === '/' ? 'index.html' : normalizedPath.replace(/^\/+/, '');
    const absolutePath = resolve(projectRoot, relativePath);
    const relativeToRoot = relative(projectRoot, absolutePath);
    if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
        return null;
    }
    return absolutePath;
}

async function createStaticServer() {
    const server = createServer(async (req, res) => {
        try {
            if (String(req.url || '').startsWith('/__smoke_blank')) {
                const body = Buffer.from(`<!doctype html>
                    <meta charset="utf-8">
                    <title>LPM smoke</title>
                    <script type="importmap">
                    {
                        "imports": {
                            "three": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js",
                            "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/"
                        }
                    }
                    </script>`);
                res.writeHead(200, {
                    'Content-Length': body.length,
                    'Content-Type': 'text/html; charset=utf-8',
                });
                res.end(body);
                return;
            }

            const fsPath = resolveFsPath(req.url || '/');
            if (!fsPath) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }

            const fileStats = await stat(fsPath);
            if (!fileStats.isFile()) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const body = await readFile(fsPath);
            const contentType = MIME_TYPES.get(extname(fsPath).toLowerCase()) || 'application/octet-stream';
            res.writeHead(200, {
                'Content-Length': body.length,
                'Content-Type': contentType,
            });
            res.end(body);
        } catch (error) {
            const code = error?.code === 'ENOENT' ? 404 : 500;
            res.writeHead(code);
            res.end(code === 404 ? 'Not found' : 'Internal server error');
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to resolve smoke server address');
    }

    return {
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        }),
    };
}

function attachPageDiagnostics(page, options = {}) {
    const consoleErrors = [];
    const pageErrors = [];
    const ignoreConsoleError =
        typeof options.ignoreConsoleError === 'function' ? options.ignoreConsoleError : () => false;

    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (!ignoreConsoleError(text)) consoleErrors.push(text);
    });
    page.on('pageerror', (error) => {
        pageErrors.push(String(error));
    });

    return {
        assertNoErrors(context) {
            assert.equal(pageErrors.length, 0, `${context}: page errors\n${pageErrors.join('\n')}`);
            assert.equal(consoleErrors.length, 0, `${context}: console errors\n${consoleErrors.join('\n')}`);
        },
    };
}

async function runBootSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/?renderer=webgl`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => (
        !!globalThis.viewerApp && !document.body.classList.contains('app-loading')
    ), null, { timeout: 45000 });

    const state = await page.evaluate(() => ({
        appReady: !!globalThis.viewerApp,
        loading: document.body.classList.contains('app-loading'),
        activeRenderer: globalThis.__LPMVIEW_ACTIVE_RENDERER || null,
    }));
    const webgpuImports = await page.evaluate(async () => {
        const [webgpu, tsl] = await Promise.all([
            import('three/webgpu'),
            import('three/tsl'),
        ]);
        return {
            webgpuRenderer: !!webgpu.WebGPURenderer,
            meshBasicNodeMaterial: !!webgpu.MeshBasicNodeMaterial,
            normalView: !!tsl.normalView,
            positionViewDirection: !!tsl.positionViewDirection,
        };
    });

    assert.equal(state.appReady, true, 'Boot smoke: viewerApp not initialized');
    assert.equal(state.loading, false, 'Boot smoke: body still in app-loading state');
    assert.equal(state.activeRenderer, 'webgl', 'Boot smoke: unexpected renderer mode');
    assert.equal(webgpuImports.webgpuRenderer, true, 'Boot smoke: three/webgpu WebGPURenderer export missing');
    assert.equal(webgpuImports.meshBasicNodeMaterial, true, 'Boot smoke: three/webgpu MeshBasicNodeMaterial export missing');
    assert.equal(webgpuImports.normalView, true, 'Boot smoke: three/tsl normalView export missing');
    assert.equal(webgpuImports.positionViewDirection, true, 'Boot smoke: three/tsl positionViewDirection export missing');
    diagnostics.assertNoErrors('Boot smoke');
    await page.close();
}

async function runRoomEntrySmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    const targetUrl = `${baseUrl}/?project=${encodeURIComponent(roomProject)}&room=${encodeURIComponent(roomSlug)}&renderer=webgl`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => (
        !!globalThis.viewerApp &&
        !document.body.classList.contains('app-loading') &&
        document.body.classList.contains('room-entry-landing') &&
        document.querySelector('#collabDrawer')?.hidden === false &&
        document.querySelector('#collabAuthPanel')?.dataset?.mode === 'roomEntry' &&
        (() => {
            const guestBtn = document.querySelector('#collabGuestBtn');
            return !!guestBtn && guestBtn.offsetParent !== null && guestBtn.disabled === false;
        })()
    ), null, { timeout: 45000 });

    const state = await page.evaluate(() => {
        const guestBtn = document.querySelector('#collabGuestBtn');
        return {
            appReady: !!globalThis.viewerApp,
            loading: document.body.classList.contains('app-loading'),
            roomEntryLanding: document.body.classList.contains('room-entry-landing'),
            drawerHidden: document.querySelector('#collabDrawer')?.hidden ?? null,
            authMode: document.querySelector('#collabAuthPanel')?.dataset?.mode || null,
            guestVisible: !!guestBtn && guestBtn.offsetParent !== null,
            guestDisabled: guestBtn?.disabled ?? null,
        };
    });

    assert.equal(state.appReady, true, 'Room smoke: viewerApp not initialized');
    assert.equal(state.loading, false, 'Room smoke: body still in app-loading state');
    assert.equal(state.roomEntryLanding, true, 'Room smoke: room-entry landing state missing');
    assert.equal(state.drawerHidden, false, 'Room smoke: collab drawer is closed');
    assert.equal(state.authMode, 'roomEntry', 'Room smoke: unexpected auth mode');
    assert.equal(state.guestVisible, true, 'Room smoke: guest button is not visible');
    assert.equal(state.guestDisabled, false, 'Room smoke: guest button is disabled');
    diagnostics.assertNoErrors('Room smoke');
    await page.close();
}

async function runDisposeReinitSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    await page.addInitScript(() => {
        const nativeAdd = EventTarget.prototype.addEventListener;
        const nativeRemove = EventTarget.prototype.removeEventListener;
        const registry = new WeakMap();

        function captureFlag(options) {
            if (options === true) return true;
            if (!options || typeof options !== 'object') return false;
            return !!options.capture;
        }

        function getTargetEntries(target, type, create = false) {
            let byType = registry.get(target);
            if (!byType && create) {
                byType = new Map();
                registry.set(target, byType);
            }
            if (!byType) return null;
            let entries = byType.get(type);
            if (!entries && create) {
                entries = [];
                byType.set(type, entries);
            }
            return entries || null;
        }

        EventTarget.prototype.addEventListener = function patchedAddEventListener(type, listener, options) {
            if (listener) {
                const eventType = String(type || '');
                const capture = captureFlag(options);
                const entries = getTargetEntries(this, eventType, true);
                const exists = entries.some((entry) => entry.listener === listener && entry.capture === capture);
                if (!exists) entries.push({ listener, capture });
            }
            return nativeAdd.call(this, type, listener, options);
        };

        EventTarget.prototype.removeEventListener = function patchedRemoveEventListener(type, listener, options) {
            const eventType = String(type || '');
            const capture = captureFlag(options);
            const entries = getTargetEntries(this, eventType, false);
            if (entries) {
                const index = entries.findIndex((entry) => entry.listener === listener && entry.capture === capture);
                if (index !== -1) entries.splice(index, 1);
            }
            return nativeRemove.call(this, type, listener, options);
        };

        globalThis.__lpmSmokeListenerCount = (targetRef, type) => {
            let target = null;
            if (targetRef === 'window') target = window;
            else if (targetRef === 'document') target = document;
            else if (targetRef === 'body') target = document.body;
            else target = document.querySelector(String(targetRef || ''));
            if (!target) return 0;
            return getTargetEntries(target, String(type || ''), false)?.length || 0;
        };
    });

    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/?renderer=webgl`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => (
        !!globalThis.viewerApp && !document.body.classList.contains('app-loading')
    ), null, { timeout: 45000 });

    const readCounts = () => page.evaluate(() => {
        const count = globalThis.__lpmSmokeListenerCount;
        const dragTargets = ['window', 'document', 'body', '#viewer', '#drop'];
        const dragTypes = ['dragenter', 'dragover', 'dragleave', 'drop'];
        return {
            fileInputChange: count('#fileInput', 'change'),
            emptyHintClick: count('#emptyHint', 'click'),
            sampleChange: count('#sampleSelect', 'change'),
            textureCloseClick: count('#mClose', 'click'),
            textureModalClick: count('#texModal', 'click'),
            textureBindClick: count('#bindBtn', 'click'),
            documentKeydown: count('document', 'keydown'),
            windowOffline: count('window', 'offline'),
            windowOnline: count('window', 'online'),
            orderClick: count('#orderBtn', 'click'),
            orderModalClick: count('#orderModal', 'click'),
            exportClick: count('#exportBtn', 'click'),
            collabNameKeydown: count('#collabName', 'keydown'),
            collabNameKeyup: count('#collabName', 'keyup'),
            collabEmailKeydown: count('#collabEmail', 'keydown'),
            collabEmailKeyup: count('#collabEmail', 'keyup'),
            collabJoinClick: count('#collabJoinBtn', 'click'),
            collabGuestClick: count('#collabGuestBtn', 'click'),
            camsToggleClick: count('#camsToggleBtn', 'click'),
            camsBarClick: count('#camsBarList', 'click'),
            camsBarDragStart: count('#camsBarList', 'dragstart'),
            camsBarDragOver: count('#camsBarList', 'dragover'),
            camsBarDrop: count('#camsBarList', 'drop'),
            camsBarDragEnd: count('#camsBarList', 'dragend'),
            camsSideClick: count('#camsSideList', 'click'),
            annotatePointerDown: count('#annotateCanvas', 'pointerdown'),
            annotatePointerMove: count('#annotateCanvas', 'pointermove'),
            annotatePointerUp: count('#annotateCanvas', 'pointerup'),
            annotatePointerCancel: count('#annotateCanvas', 'pointercancel'),
            annoToggleClick: count('#annoToggleBtn', 'click'),
            annoVisibleClick: count('#annoVisibleBtn', 'click'),
            annoDrawClick: count('#annoDrawBtn', 'click'),
            statsClick: count('#statsBtn', 'click'),
            gridClick: count('#gridToggleBtn', 'click'),
            resetViewerClick: count('#resetViewerBtn', 'click'),
            resetViewClick: count('#resetViewBtn', 'click'),
            fullscreenClick: count('#fullscreenBtn', 'click'),
            bgToggleClick: count('#bgToggleBtn', 'click'),
            bgAlphaInput: count('#bgAlpha', 'input'),
            bgAlphaChange: count('#bgAlpha', 'change'),
            sunEnabledChange: count('#sunEnabled', 'change'),
            sunDayInput: count('#sunDay', 'input'),
            sunMonthInput: count('#sunMonth', 'input'),
            sunHourInput: count('#sunHour', 'input'),
            sunHourTextChange: count('#sunHourInput', 'change'),
            sunIntensityInput: count('#sunIntensity', 'input'),
            sunIntensityTextChange: count('#sunIntensityInput', 'change'),
            sunNorthInput: count('#sunNorth', 'input'),
            hdriCheckChange: count('#hdriChk', 'change'),
            hdriPresetChange: count('#hdriPreset', 'change'),
            iblIntInput: count('#iblInt', 'input'),
            iblGammaInput: count('#iblGamma', 'input'),
            iblRotInput: count('#iblRot', 'input'),
            hdriExposureInput: count('#hdriExposure', 'input'),
            hdriSaturationInput: count('#hdriSaturation', 'input'),
            hdriBlurInput: count('#hdriBlur', 'input'),
            hemiIntInput: count('#hemiInt', 'input'),
            hemiIntChange: count('#hemiInt', 'change'),
            hemiSkyInput: count('#hemiSky', 'input'),
            hemiSkyChange: count('#hemiSky', 'change'),
            hemiGroundInput: count('#hemiGround', 'input'),
            hemiGroundChange: count('#hemiGround', 'change'),
            shadingChange: count('#shadingMode', 'change'),
            solidToggleClick: count('#solidToggleBtn', 'click'),
            collToggleClick: count('#collToggleBtn', 'click'),
            vpmToggleClick: count('#vpmToggleBtn', 'click'),
            npmToggleClick: count('#npmToggleBtn', 'click'),
            lightHelpersClick: count('#lightHelpersBtn', 'click'),
            lightEmittersClick: count('#lightEmittersBtn', 'click'),
            shadowHelpersClick: count('#shadowHelpersBtn', 'click'),
            shadowDbgClick: count('#shadowDbgBtn', 'click'),
            shadowDbgCloseClick: count('#shadowDbgClose', 'click'),
            shadowApplyClick: count('#shadowApply', 'click'),
            shadowResetClick: count('#shadowReset', 'click'),
            glassOpacityInput: count('#glassOpacity', 'input'),
            glassIorInput: count('#glassIor', 'input'),
            glassTransmissionInput: count('#glassTransmission', 'input'),
            glassReflectInput: count('#glassReflect', 'input'),
            glassRoughInput: count('#glassRough', 'input'),
            glassMetalInput: count('#glassMetal', 'input'),
            glassAttenDistInput: count('#glassAttenDist', 'input'),
            glassAttenColorInput: count('#glassAttenColor', 'input'),
            glassColorInput: count('#glassColor', 'input'),
            glassResetClick: count('#glassReset', 'click'),
            promptOkClick: count('#promptOk', 'click'),
            promptCancelClick: count('#promptCancel', 'click'),
            promptCloseClick: count('#promptClose', 'click'),
            promptModalClick: count('#promptModal', 'click'),
            promptInputKeydown: count('#promptInput', 'keydown'),
            confirmOkClick: count('#confirmOk', 'click'),
            confirmCancelClick: count('#confirmCancel', 'click'),
            confirmCloseClick: count('#confirmClose', 'click'),
            confirmModalClick: count('#confirmModal', 'click'),
            confirmModalKeydown: count('#confirmModal', 'keydown'),
            resetOkClick: count('#resetOk', 'click'),
            resetCancelClick: count('#resetCancel', 'click'),
            resetCloseClick: count('#resetClose', 'click'),
            resetModalClick: count('#resetModal', 'click'),
            resetModalKeydown: count('#resetModal', 'keydown'),
            transitionOkClick: count('#transitionOk', 'click'),
            transitionCancelClick: count('#transitionCancel', 'click'),
            transitionCloseClick: count('#transitionClose', 'click'),
            transitionModalClick: count('#transitionModal', 'click'),
            transitionSecondsKeydown: count('#transitionSeconds', 'keydown'),
            transitionTypeKeydown: count('#transitionType', 'keydown'),
            transitionTrajectoryKeydown: count('#transitionTrajectory', 'keydown'),
            exportOkClick: count('#exportOk', 'click'),
            exportCancelClick: count('#exportCancel', 'click'),
            exportCloseClick: count('#exportClose', 'click'),
            exportModalClick: count('#exportModal', 'click'),
            exportFormatKeydown: count('#exportFormat', 'keydown'),
            exportCoordsKeydown: count('#exportCoords', 'keydown'),
            exportModalKeydown: count('#exportModal', 'keydown'),
            rectAnnotOkClick: count('#rectAnnotOk', 'click'),
            rectAnnotCancelClick: count('#rectAnnotCancel', 'click'),
            rectAnnotCloseClick: count('#rectAnnotClose', 'click'),
            rectAnnotInfoChange: count('#rectAnnotInfo', 'change'),
            rectAnnotModalClick: count('#rectAnnotModal', 'click'),
            rectAnnotModalKeydown: count('#rectAnnotModal', 'keydown'),
            dragListeners: dragTargets.reduce((total, target) => (
                total + dragTypes.reduce((sum, type) => sum + count(target, type), 0)
            ), 0),
            canvasCount: document.querySelectorAll('canvas').length,
        };
    });

    const lifecycleListenerExpectations = Object.freeze({
        statsClick: 1,
        gridClick: 1,
        resetViewerClick: 1,
        resetViewClick: 1,
        fullscreenClick: 1,
        bgToggleClick: 1,
        bgAlphaInput: 2,
        bgAlphaChange: 1,
        sunEnabledChange: 1,
        sunDayInput: 1,
        sunMonthInput: 1,
        sunHourInput: 2,
        sunHourTextChange: 1,
        sunIntensityInput: 1,
        sunIntensityTextChange: 1,
        sunNorthInput: 1,
        hdriCheckChange: 1,
        hdriPresetChange: 2,
        iblIntInput: 2,
        iblGammaInput: 2,
        iblRotInput: 2,
        hdriExposureInput: 2,
        hdriSaturationInput: 2,
        hdriBlurInput: 2,
        hemiIntInput: 2,
        hemiIntChange: 1,
        hemiSkyInput: 1,
        hemiSkyChange: 1,
        hemiGroundInput: 1,
        hemiGroundChange: 1,
        shadingChange: 2,
        solidToggleClick: 1,
        collToggleClick: 1,
        vpmToggleClick: 1,
        npmToggleClick: 1,
        lightHelpersClick: 1,
        lightEmittersClick: 1,
        shadowHelpersClick: 1,
        shadowDbgClick: 1,
        shadowDbgCloseClick: 1,
        shadowApplyClick: 1,
        shadowResetClick: 1,
        glassOpacityInput: 1,
        glassIorInput: 1,
        glassTransmissionInput: 1,
        glassReflectInput: 1,
        glassRoughInput: 1,
        glassMetalInput: 1,
        glassAttenDistInput: 1,
        glassAttenColorInput: 1,
        glassColorInput: 1,
        glassResetClick: 1,
        promptOkClick: 1,
        promptCancelClick: 1,
        promptCloseClick: 1,
        promptModalClick: 1,
        promptInputKeydown: 1,
        confirmOkClick: 1,
        confirmCancelClick: 1,
        confirmCloseClick: 1,
        confirmModalClick: 1,
        confirmModalKeydown: 1,
        resetOkClick: 1,
        resetCancelClick: 1,
        resetCloseClick: 1,
        resetModalClick: 1,
        resetModalKeydown: 1,
        transitionOkClick: 1,
        transitionCancelClick: 1,
        transitionCloseClick: 1,
        transitionModalClick: 1,
        transitionSecondsKeydown: 1,
        transitionTypeKeydown: 1,
        transitionTrajectoryKeydown: 1,
        exportOkClick: 1,
        exportCancelClick: 1,
        exportCloseClick: 1,
        exportModalClick: 1,
        exportFormatKeydown: 1,
        exportCoordsKeydown: 1,
        exportModalKeydown: 1,
        rectAnnotOkClick: 1,
        rectAnnotCancelClick: 1,
        rectAnnotCloseClick: 1,
        rectAnnotInfoChange: 2,
        rectAnnotModalClick: 1,
        rectAnnotModalKeydown: 1,
    });

    function assertLifecycleListeners(snapshot, phase) {
        for (const [key, expected] of Object.entries(lifecycleListenerExpectations)) {
            assert.equal(snapshot[key], expected, `Dispose smoke: ${key} listener count mismatch ${phase}`);
        }
    }

    function assertNoLifecycleListeners(snapshot, phase) {
        for (const key of Object.keys(lifecycleListenerExpectations)) {
            assert.equal(snapshot[key], 0, `Dispose smoke: ${key} listener leaked ${phase}`);
        }
    }

    const firstInit = await readCounts();
    assert.equal(firstInit.fileInputChange, 1, 'Dispose smoke: file input listener missing after first init');
    assert.equal(firstInit.emptyHintClick, 1, 'Dispose smoke: empty hint listener missing after first init');
    assert.equal(firstInit.sampleChange, 2, 'Dispose smoke: sample select listeners missing after first init');
    assert.equal(firstInit.textureCloseClick, 1, 'Dispose smoke: texture close listener missing after first init');
    assert.equal(firstInit.textureModalClick, 1, 'Dispose smoke: texture modal listener missing after first init');
    assert.equal(firstInit.textureBindClick, 1, 'Dispose smoke: texture bind listener missing after first init');
    assert.equal(firstInit.documentKeydown, 3, 'Dispose smoke: document keydown listeners missing after first init');
    assert.equal(firstInit.windowOffline, 1, 'Dispose smoke: window offline listener missing after first init');
    assert.equal(firstInit.windowOnline, 1, 'Dispose smoke: window online listener missing after first init');
    assert.equal(firstInit.orderClick, 1, 'Dispose smoke: order button listener missing after first init');
    assert.equal(firstInit.orderModalClick, 1, 'Dispose smoke: order modal listener missing after first init');
    assert.equal(firstInit.exportClick, 1, 'Dispose smoke: export listener missing after first init');
    assert.equal(firstInit.collabNameKeydown, 1, 'Dispose smoke: collab name keydown listener missing after first init');
    assert.equal(firstInit.collabNameKeyup, 1, 'Dispose smoke: collab name keyup listener missing after first init');
    assert.equal(firstInit.collabEmailKeydown, 1, 'Dispose smoke: collab email keydown listener missing after first init');
    assert.equal(firstInit.collabEmailKeyup, 1, 'Dispose smoke: collab email keyup listener missing after first init');
    assert.equal(firstInit.collabJoinClick, 1, 'Dispose smoke: collab join listener missing after first init');
    assert.equal(firstInit.collabGuestClick, 1, 'Dispose smoke: collab guest listener missing after first init');
    assert.equal(firstInit.camsToggleClick, 1, 'Dispose smoke: camera toggle listener missing after first init');
    assert.equal(firstInit.camsBarClick, 1, 'Dispose smoke: camera bar click listener missing after first init');
    assert.equal(firstInit.camsBarDragStart, 1, 'Dispose smoke: camera bar dragstart listener missing after first init');
    assert.equal(firstInit.camsBarDragOver, 1, 'Dispose smoke: camera bar dragover listener missing after first init');
    assert.equal(firstInit.camsBarDrop, 1, 'Dispose smoke: camera bar drop listener missing after first init');
    assert.equal(firstInit.camsBarDragEnd, 1, 'Dispose smoke: camera bar dragend listener missing after first init');
    assert.equal(firstInit.camsSideClick, 1, 'Dispose smoke: camera side click listener missing after first init');
    assert.ok(firstInit.annotatePointerDown >= 1, 'Dispose smoke: annotation pointerdown listener missing after first init');
    assert.ok(firstInit.annotatePointerMove >= 1, 'Dispose smoke: annotation pointermove listener missing after first init');
    assert.ok(firstInit.annotatePointerUp >= 1, 'Dispose smoke: annotation pointerup listener missing after first init');
    assert.ok(firstInit.annotatePointerCancel >= 1, 'Dispose smoke: annotation pointercancel listener missing after first init');
    assert.equal(firstInit.annoToggleClick, 1, 'Dispose smoke: annotation toggle listener missing after first init');
    assert.equal(firstInit.annoVisibleClick, 1, 'Dispose smoke: annotation visibility listener missing after first init');
    assert.equal(firstInit.annoDrawClick, 0, 'Dispose smoke: annotation draw button unexpectedly present after first init');
    assert.equal(firstInit.dragListeners, 20, 'Dispose smoke: unexpected file drop listener count after first init');
    assert.ok(firstInit.canvasCount >= 1, 'Dispose smoke: renderer canvas missing after first init');
    assertLifecycleListeners(firstInit, 'after first init');

    await page.evaluate(async () => {
        await globalThis.viewerApp.dispose();
    });
    const afterFirstDispose = await readCounts();
    assert.equal(afterFirstDispose.fileInputChange, 0, 'Dispose smoke: file input listener leaked after dispose');
    assert.equal(afterFirstDispose.emptyHintClick, 0, 'Dispose smoke: empty hint listener leaked after dispose');
    assert.equal(afterFirstDispose.sampleChange, 0, 'Dispose smoke: sample select listener leaked after dispose');
    assert.equal(afterFirstDispose.textureCloseClick, 0, 'Dispose smoke: texture close listener leaked after dispose');
    assert.equal(afterFirstDispose.textureModalClick, 0, 'Dispose smoke: texture modal listener leaked after dispose');
    assert.equal(afterFirstDispose.textureBindClick, 0, 'Dispose smoke: texture bind listener leaked after dispose');
    assert.equal(afterFirstDispose.documentKeydown, 0, 'Dispose smoke: document keydown listener leaked after dispose');
    assert.equal(afterFirstDispose.windowOffline, 0, 'Dispose smoke: window offline listener leaked after dispose');
    assert.equal(afterFirstDispose.windowOnline, 0, 'Dispose smoke: window online listener leaked after dispose');
    assert.equal(afterFirstDispose.orderClick, 0, 'Dispose smoke: order button listener leaked after dispose');
    assert.equal(afterFirstDispose.orderModalClick, 0, 'Dispose smoke: order modal listener leaked after dispose');
    assert.equal(afterFirstDispose.exportClick, 0, 'Dispose smoke: export listener leaked after dispose');
    assert.equal(afterFirstDispose.collabNameKeydown, 0, 'Dispose smoke: collab name keydown listener leaked after dispose');
    assert.equal(afterFirstDispose.collabNameKeyup, 0, 'Dispose smoke: collab name keyup listener leaked after dispose');
    assert.equal(afterFirstDispose.collabEmailKeydown, 0, 'Dispose smoke: collab email keydown listener leaked after dispose');
    assert.equal(afterFirstDispose.collabEmailKeyup, 0, 'Dispose smoke: collab email keyup listener leaked after dispose');
    assert.equal(afterFirstDispose.collabJoinClick, 0, 'Dispose smoke: collab join listener leaked after dispose');
    assert.equal(afterFirstDispose.collabGuestClick, 0, 'Dispose smoke: collab guest listener leaked after dispose');
    assert.equal(afterFirstDispose.camsToggleClick, 0, 'Dispose smoke: camera toggle listener leaked after dispose');
    assert.equal(afterFirstDispose.camsBarClick, 0, 'Dispose smoke: camera bar click listener leaked after dispose');
    assert.equal(afterFirstDispose.camsBarDragStart, 0, 'Dispose smoke: camera bar dragstart listener leaked after dispose');
    assert.equal(afterFirstDispose.camsBarDragOver, 0, 'Dispose smoke: camera bar dragover listener leaked after dispose');
    assert.equal(afterFirstDispose.camsBarDrop, 0, 'Dispose smoke: camera bar drop listener leaked after dispose');
    assert.equal(afterFirstDispose.camsBarDragEnd, 0, 'Dispose smoke: camera bar dragend listener leaked after dispose');
    assert.equal(afterFirstDispose.camsSideClick, 0, 'Dispose smoke: camera side click listener leaked after dispose');
    assert.equal(afterFirstDispose.annotatePointerDown, 0, 'Dispose smoke: annotation pointerdown listener leaked after dispose');
    assert.equal(afterFirstDispose.annotatePointerMove, 0, 'Dispose smoke: annotation pointermove listener leaked after dispose');
    assert.equal(afterFirstDispose.annotatePointerUp, 0, 'Dispose smoke: annotation pointerup listener leaked after dispose');
    assert.equal(afterFirstDispose.annotatePointerCancel, 0, 'Dispose smoke: annotation pointercancel listener leaked after dispose');
    assert.equal(afterFirstDispose.annoToggleClick, 0, 'Dispose smoke: annotation toggle listener leaked after dispose');
    assert.equal(afterFirstDispose.annoVisibleClick, 0, 'Dispose smoke: annotation visibility listener leaked after dispose');
    assert.equal(afterFirstDispose.annoDrawClick, 0, 'Dispose smoke: annotation draw listener leaked after dispose');
    assert.equal(afterFirstDispose.dragListeners, 0, 'Dispose smoke: file drop listeners leaked after dispose');
    assertNoLifecycleListeners(afterFirstDispose, 'after dispose');

    await page.evaluate(async () => {
        const { ViewerApp } = await import('/scripts/modules/app/viewer-app-main.js');
        globalThis.viewerApp = new ViewerApp();
    });
    await page.waitForFunction(() => (
        !!globalThis.viewerApp && document.querySelectorAll('canvas').length >= 1
    ), null, { timeout: 45000 });

    const secondInit = await readCounts();
    assert.equal(secondInit.fileInputChange, 1, 'Dispose smoke: file input listener duplicated after reinit');
    assert.equal(secondInit.emptyHintClick, 1, 'Dispose smoke: empty hint listener duplicated after reinit');
    assert.equal(secondInit.sampleChange, 2, 'Dispose smoke: sample select listeners duplicated after reinit');
    assert.equal(secondInit.textureCloseClick, 1, 'Dispose smoke: texture close listener duplicated after reinit');
    assert.equal(secondInit.textureModalClick, 1, 'Dispose smoke: texture modal listener duplicated after reinit');
    assert.equal(secondInit.textureBindClick, 1, 'Dispose smoke: texture bind listener duplicated after reinit');
    assert.equal(secondInit.documentKeydown, 3, 'Dispose smoke: document keydown listeners duplicated after reinit');
    assert.equal(secondInit.windowOffline, 1, 'Dispose smoke: window offline listener duplicated after reinit');
    assert.equal(secondInit.windowOnline, 1, 'Dispose smoke: window online listener duplicated after reinit');
    assert.equal(secondInit.orderClick, 1, 'Dispose smoke: order button listener duplicated after reinit');
    assert.equal(secondInit.orderModalClick, 1, 'Dispose smoke: order modal listener duplicated after reinit');
    assert.equal(secondInit.exportClick, 1, 'Dispose smoke: export listener duplicated after reinit');
    assert.equal(secondInit.collabNameKeydown, 1, 'Dispose smoke: collab name keydown listener duplicated after reinit');
    assert.equal(secondInit.collabNameKeyup, 1, 'Dispose smoke: collab name keyup listener duplicated after reinit');
    assert.equal(secondInit.collabEmailKeydown, 1, 'Dispose smoke: collab email keydown listener duplicated after reinit');
    assert.equal(secondInit.collabEmailKeyup, 1, 'Dispose smoke: collab email keyup listener duplicated after reinit');
    assert.equal(secondInit.collabJoinClick, 1, 'Dispose smoke: collab join listener duplicated after reinit');
    assert.equal(secondInit.collabGuestClick, 1, 'Dispose smoke: collab guest listener duplicated after reinit');
    assert.equal(secondInit.camsToggleClick, 1, 'Dispose smoke: camera toggle listener duplicated after reinit');
    assert.equal(secondInit.camsBarClick, 1, 'Dispose smoke: camera bar click listener duplicated after reinit');
    assert.equal(secondInit.camsBarDragStart, 1, 'Dispose smoke: camera bar dragstart listener duplicated after reinit');
    assert.equal(secondInit.camsBarDragOver, 1, 'Dispose smoke: camera bar dragover listener duplicated after reinit');
    assert.equal(secondInit.camsBarDrop, 1, 'Dispose smoke: camera bar drop listener duplicated after reinit');
    assert.equal(secondInit.camsBarDragEnd, 1, 'Dispose smoke: camera bar dragend listener duplicated after reinit');
    assert.equal(secondInit.camsSideClick, 1, 'Dispose smoke: camera side click listener duplicated after reinit');
    assert.equal(secondInit.annotatePointerDown, firstInit.annotatePointerDown, 'Dispose smoke: annotation pointerdown listener duplicated after reinit');
    assert.equal(secondInit.annotatePointerMove, firstInit.annotatePointerMove, 'Dispose smoke: annotation pointermove listener duplicated after reinit');
    assert.equal(secondInit.annotatePointerUp, firstInit.annotatePointerUp, 'Dispose smoke: annotation pointerup listener duplicated after reinit');
    assert.equal(secondInit.annotatePointerCancel, firstInit.annotatePointerCancel, 'Dispose smoke: annotation pointercancel listener duplicated after reinit');
    assert.equal(secondInit.annoToggleClick, 1, 'Dispose smoke: annotation toggle listener duplicated after reinit');
    assert.equal(secondInit.annoVisibleClick, 1, 'Dispose smoke: annotation visibility listener duplicated after reinit');
    assert.equal(secondInit.annoDrawClick, 0, 'Dispose smoke: annotation draw button unexpectedly present after reinit');
    assert.equal(secondInit.dragListeners, 20, 'Dispose smoke: unexpected file drop listener count after reinit');
    assertLifecycleListeners(secondInit, 'after reinit');

    await page.evaluate(async () => {
        await globalThis.viewerApp.dispose();
    });
    diagnostics.assertNoErrors('Dispose/reinit smoke');
    await page.close();
}

async function runFileFlowFailureSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page, {
        ignoreConsoleError: (text) => text.includes('File import failed: broken.fbx'),
    });
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createFileFlowController } = await import('/scripts/modules/io/file-flow.js');

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.multiple = true;
        const emptyHintEl = document.createElement('button');
        const rootEl = document.createElement('main');
        const dropEl = document.createElement('div');
        const sampleSelect = document.createElement('select');
        document.body.append(fileInput, emptyHintEl, rootEl, dropEl, sampleSelect);

        const calls = [];
        let loadedCount = 0;
        let finalizeResolve = null;
        const finalized = new Promise((resolve) => {
            finalizeResolve = resolve;
        });

        const controller = createFileFlowController({
            fileInput,
            emptyHintEl,
            rootEl,
            dropEl,
            sampleSelect,
            sampleModels: [],
            handleFBXFile: async (file) => {
                calls.push(`fbx:${file.name}`);
                throw new Error('broken import');
            },
            handleZIPFile: async (file) => {
                calls.push(`zip:${file.name}`);
                loadedCount += 1;
            },
            finalizeBatchAfterAllFiles: async () => {
                calls.push('finalize');
                finalizeResolve();
            },
            setEmptyHintVisible: (visible) => calls.push(`empty:${visible ? 'on' : 'off'}`),
            getLoadedModelCount: () => loadedCount,
        });

        const files = [
            new File(['bad'], 'broken.fbx', { type: 'application/octet-stream' }),
            new File(['ok'], 'ok.zip', { type: 'application/zip' }),
        ];
        Object.defineProperty(fileInput, 'files', {
            configurable: true,
            value: files,
        });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await finalized;
        controller.dispose();

        return {
            calls,
            fileInputValue: fileInput.value,
            dropVisible: dropEl.classList.contains('show'),
        };
    });

    assert.deepEqual(result.calls, [
        'empty:off',
        'fbx:broken.fbx',
        'zip:ok.zip',
        'empty:off',
        'finalize',
    ], 'File-flow smoke: failed file blocked batch finalization or later files');
    assert.equal(result.fileInputValue, '', 'File-flow smoke: file input value was not reset');
    assert.equal(result.dropVisible, false, 'File-flow smoke: drop overlay stayed visible after dispose');
    diagnostics.assertNoErrors('File-flow failure smoke');
    await page.close();
}

async function runCollabRealtimeDisposeSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createCollabController } = await import('/scripts/modules/collab/collab-controller.js');

        class FakeQuery {
            constructor(table) {
                this.table = table;
                this.payload = null;
            }
            upsert(payload) {
                this.payload = payload;
                return Promise.resolve({ data: payload, error: null });
            }
            insert(payload) {
                this.payload = payload;
                return this;
            }
            update(payload) {
                this.payload = payload;
                return this;
            }
            delete() {
                return this;
            }
            select() {
                return this;
            }
            eq() {
                return this;
            }
            order() {
                return Promise.resolve({ data: [], error: null });
            }
            limit() {
                return this;
            }
            maybeSingle() {
                return Promise.resolve({ data: null, error: null });
            }
            single() {
                const data = {
                    id: `${this.table}-row`,
                    ...(this.payload && typeof this.payload === 'object' ? this.payload : {}),
                };
                return Promise.resolve({ data, error: null });
            }
        }

        class FakeChannel {
            constructor(name) {
                this.name = name;
                this.handlers = [];
                this.state = 'joined';
                this.socket = { isConnected: () => true };
                this.tracked = [];
            }
            on(type, filter, callback) {
                this.handlers.push({ type, filter: filter || {}, callback });
                return this;
            }
            subscribe(callback) {
                if (typeof callback === 'function') {
                    Promise.resolve().then(() => callback('SUBSCRIBED'));
                }
                return Promise.resolve('SUBSCRIBED');
            }
            track(meta) {
                this.tracked.push({ ...(meta || {}) });
                return Promise.resolve('ok');
            }
            presenceState() {
                return {
                    peer: [{ name: 'Peer', joinedAt: 't0', lastSeenAt: 't1' }],
                };
            }
            send() {
                return Promise.resolve('ok');
            }
            httpSend() {
                return Promise.resolve('ok');
            }
            emit(type, event, payload) {
                this.handlers
                    .filter((handler) => handler.type === type && handler.filter?.event === event)
                    .forEach((handler) => handler.callback(payload));
            }
        }

        const channels = [];
        const removedChannels = [];
        const supabase = {
            from: (table) => new FakeQuery(table),
            channel: (name) => {
                const channel = new FakeChannel(name);
                channels.push(channel);
                return channel;
            },
            removeChannel: async (channel) => {
                removedChannels.push(channel.name);
                return 'ok';
            },
            rpc: async () => ({ data: null, error: null }),
        };

        const calls = [];
        const controller = await createCollabController({
            supabase,
            user: { id: 'local-user' },
            project: { id: 'project-1', slug: 'project' },
            room: { id: 'room-1', slug: 'room', camera_owner_id: null, camera_state: null },
            displayName: 'Local',
            onParticipants: (list) => calls.push(`participants:${list.length}`),
            onMessage: (record, meta) => calls.push(`message:${meta?.source || ''}:${record?.id || ''}`),
            onAnnotation: (record, meta) => calls.push(`annotation:${meta?.source || ''}:${record?.id || ''}`),
            onAnnotationDelete: (record) => calls.push(`annotation-delete:${record?.id || ''}`),
            onCameraState: (state) => calls.push(`camera:${state?.source || 'broadcast'}`),
            onCameraOwner: (ownerId) => calls.push(`owner:${ownerId || ''}`),
            onRoomUpdate: (room) => calls.push(`room:${room?.id || ''}`),
            onConnectionState: ({ connected, reason }) => calls.push(`connection:${connected ? 'on' : 'off'}:${reason}`),
        });

        const roomChannel = channels.find((channel) => channel.name === 'room:room-1');
        const updatesChannel = channels.find((channel) => channel.name === 'room:room-1:updates');
        const annotationsChannel = channels.find((channel) => channel.name === 'room:room-1:annotations');
        const messagesChannel = channels.find((channel) => channel.name === 'room:room-1:messages');

        roomChannel.emit('presence', 'sync', {});
        roomChannel.emit('broadcast', 'message', { payload: { id: 'broadcast-message', sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'annotation', { payload: { id: 'broadcast-annotation', sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'annotation-delete', { payload: { id: 'broadcast-delete', sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'camera', { payload: { sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'camera-lock', { payload: { ownerId: 'peer-user', sender: 'peer-user' } });
        updatesChannel.emit('postgres_changes', 'UPDATE', {
            new: { id: 'room-1', camera_owner_id: 'db-owner', camera_state: { position: [1, 2, 3] } },
        });
        annotationsChannel.emit('postgres_changes', 'INSERT', { new: { id: 'annotation-row' } });
        annotationsChannel.emit('postgres_changes', 'DELETE', { old: { id: 'annotation-old' } });
        messagesChannel.emit('postgres_changes', 'INSERT', { new: { id: 'message-row' } });

        await Promise.resolve();
        const beforeDispose = calls.slice();
        await controller.dispose();
        const afterDispose = calls.slice();

        roomChannel.emit('presence', 'sync', {});
        roomChannel.emit('broadcast', 'message', { payload: { id: 'late-broadcast-message', sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'annotation', { payload: { id: 'late-broadcast-annotation', sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'annotation-delete', { payload: { id: 'late-broadcast-delete', sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'camera', { payload: { sender: 'peer-user' } });
        roomChannel.emit('broadcast', 'camera-lock', { payload: { ownerId: 'late-owner', sender: 'peer-user' } });
        updatesChannel.emit('postgres_changes', 'UPDATE', {
            new: { id: 'room-1', camera_owner_id: 'late-db-owner', camera_state: { position: [4, 5, 6] } },
        });
        annotationsChannel.emit('postgres_changes', 'INSERT', { new: { id: 'late-annotation-row' } });
        annotationsChannel.emit('postgres_changes', 'DELETE', { old: { id: 'late-annotation-old' } });
        messagesChannel.emit('postgres_changes', 'INSERT', { new: { id: 'late-message-row' } });

        await Promise.resolve();
        return {
            beforeDispose,
            afterDispose,
            afterLateEvents: calls.slice(),
            removedChannels,
            channelNames: channels.map((channel) => channel.name),
        };
    });

    assert.deepEqual(result.channelNames, [
        'room:room-1',
        'room:room-1:updates',
        'room:room-1:annotations',
        'room:room-1:messages',
    ], 'Collab smoke: unexpected realtime channel set');
    assert.ok(result.beforeDispose.includes('message:broadcast:broadcast-message'), 'Collab smoke: broadcast message did not fire before dispose');
    assert.ok(result.beforeDispose.includes('annotation:realtime:annotation-row'), 'Collab smoke: realtime annotation did not fire before dispose');
    assert.ok(result.beforeDispose.includes('room:room-1'), 'Collab smoke: room update did not fire before dispose');
    assert.ok(result.afterDispose.includes('connection:off:DISPOSED'), 'Collab smoke: dispose did not emit connection close');
    assert.deepEqual(result.removedChannels, result.channelNames, 'Collab smoke: dispose did not remove all realtime channels');
    assert.deepEqual(result.afterLateEvents, result.afterDispose, 'Collab smoke: stale realtime callbacks fired after dispose');
    diagnostics.assertNoErrors('Collab realtime dispose smoke');
    await page.close();
}

async function runCollabInitFailureCleanupSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createCollabController } = await import('/scripts/modules/collab/collab-controller.js');

        const nativeSetInterval = globalThis.setInterval;
        const nativeClearInterval = globalThis.clearInterval;
        const intervalIds = [];
        const clearedIntervals = [];
        globalThis.setInterval = (fn, ms, ...args) => {
            const id = nativeSetInterval(fn, ms, ...args);
            intervalIds.push(id);
            return id;
        };
        globalThis.clearInterval = (id) => {
            clearedIntervals.push(id);
            return nativeClearInterval(id);
        };

        class FakeQuery {
            constructor(table) {
                this.table = table;
            }
            upsert() {
                return Promise.resolve({ data: null, error: null });
            }
            select() {
                return this;
            }
            eq() {
                return this;
            }
            order() {
                return Promise.resolve({ data: [], error: null });
            }
        }

        class FakeChannel {
            constructor(name) {
                this.name = name;
                this.handlers = [];
                this.state = 'joined';
                this.socket = { isConnected: () => true };
            }
            on(type, filter, callback) {
                this.handlers.push({ type, filter: filter || {}, callback });
                return this;
            }
            subscribe(callback) {
                if (this.name.endsWith(':annotations')) {
                    return Promise.reject(new Error('annotations subscribe failed'));
                }
                if (typeof callback === 'function') {
                    Promise.resolve().then(() => callback('SUBSCRIBED'));
                }
                return Promise.resolve('SUBSCRIBED');
            }
            track() {
                return Promise.resolve('ok');
            }
            presenceState() {
                return {
                    peer: [{ name: 'Peer', joinedAt: 't0', lastSeenAt: 't1' }],
                };
            }
            send() {
                return Promise.resolve('ok');
            }
            httpSend() {
                return Promise.resolve('ok');
            }
            emit(type, event, payload) {
                this.handlers
                    .filter((handler) => handler.type === type && handler.filter?.event === event)
                    .forEach((handler) => handler.callback(payload));
            }
        }

        const channels = [];
        const removedChannels = [];
        const supabase = {
            from: (table) => new FakeQuery(table),
            channel: (name) => {
                const channel = new FakeChannel(name);
                channels.push(channel);
                return channel;
            },
            removeChannel: async (channel) => {
                removedChannels.push(channel.name);
                return 'ok';
            },
            rpc: async () => ({ data: null, error: null }),
        };

        const calls = [];
        let thrown = '';
        try {
            await createCollabController({
                supabase,
                user: { id: 'local-user' },
                project: { id: 'project-1', slug: 'project' },
                room: { id: 'room-1', slug: 'room', camera_owner_id: null, camera_state: null },
                displayName: 'Local',
                onParticipants: (list) => calls.push(`participants:${list.length}`),
                onMessage: (record, meta) => calls.push(`message:${meta?.source || ''}:${record?.id || ''}`),
                onAnnotation: (record, meta) => calls.push(`annotation:${meta?.source || ''}:${record?.id || ''}`),
                onAnnotationDelete: (record) => calls.push(`annotation-delete:${record?.id || ''}`),
                onCameraState: (state) => calls.push(`camera:${state?.source || 'broadcast'}`),
                onCameraOwner: (ownerId) => calls.push(`owner:${ownerId || ''}`),
                onRoomUpdate: (room) => calls.push(`room:${room?.id || ''}`),
                onConnectionState: ({ connected, reason }) => calls.push(`connection:${connected ? 'on' : 'off'}:${reason}`),
            });
        } catch (err) {
            thrown = err?.message || String(err);
        }

        const afterFailure = calls.slice();
        channels.forEach((channel) => {
            channel.emit('presence', 'sync', {});
            channel.emit('broadcast', 'message', { payload: { id: 'late-message', sender: 'peer-user' } });
            channel.emit('broadcast', 'annotation', { payload: { id: 'late-annotation', sender: 'peer-user' } });
            channel.emit('postgres_changes', 'UPDATE', {
                new: { id: 'room-1', camera_owner_id: 'late-owner', camera_state: { position: [1, 2, 3] } },
            });
            channel.emit('postgres_changes', 'INSERT', { new: { id: 'late-row' } });
            channel.emit('postgres_changes', 'DELETE', { old: { id: 'late-old' } });
        });
        await Promise.resolve();

        globalThis.setInterval = nativeSetInterval;
        globalThis.clearInterval = nativeClearInterval;

        return {
            thrown,
            channelNames: channels.map((channel) => channel.name),
            removedChannels,
            afterFailure,
            afterLateEvents: calls.slice(),
            intervalCount: intervalIds.length,
            clearedIntervalCount: clearedIntervals.length,
            heartbeatCleared: intervalIds.length === clearedIntervals.length,
        };
    });

    assert.equal(result.thrown, 'annotations subscribe failed', 'Collab init-failure smoke: expected subscribe failure');
    assert.deepEqual(result.channelNames, [
        'room:room-1',
        'room:room-1:updates',
        'room:room-1:annotations',
    ], 'Collab init-failure smoke: unexpected channel set before failure');
    assert.deepEqual(result.removedChannels, result.channelNames, 'Collab init-failure smoke: failed init did not remove opened channels');
    assert.ok(result.afterFailure.includes('connection:on:SUBSCRIBED'), 'Collab init-failure smoke: room channel did not subscribe before failure');
    assert.deepEqual(result.afterLateEvents, result.afterFailure, 'Collab init-failure smoke: stale callbacks fired after failed init cleanup');
    assert.equal(result.intervalCount, 1, 'Collab init-failure smoke: expected one presence heartbeat');
    assert.equal(result.heartbeatCleared, true, 'Collab init-failure smoke: presence heartbeat leaked after failed init');
    diagnostics.assertNoErrors('Collab init-failure cleanup smoke');
    await page.close();
}

async function runCameraSyncLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createCameraSyncController } = await import('/scripts/modules/collab/camera-sync.js');

        const unhandled = [];
        const onUnhandled = (event) => {
            event.preventDefault();
            unhandled.push(String(event.reason?.message || event.reason || 'unknown'));
        };
        window.addEventListener('unhandledrejection', onUnhandled);

        function makeVector(x, y, z) {
            return {
                values: [x, y, z],
                toArray() {
                    return this.values.slice();
                },
                set(nx, ny, nz) {
                    this.values = [nx, ny, nz];
                },
            };
        }

        const controls = new EventTarget();
        controls.target = makeVector(0, 0, 0);
        controls.update = () => {
            calls.push('controls:update');
        };
        const camera = {
            position: makeVector(1, 2, 3),
            up: makeVector(0, 1, 0),
            fov: 50,
            zoom: 1,
            near: 0.1,
            far: 1000,
            updateProjectionMatrix: () => {
                calls.push('camera:updateProjectionMatrix');
            },
        };
        const calls = [];
        const collab = {
            broadcastCameraState: async () => {
                calls.push('broadcast');
                throw new Error('broadcast offline');
            },
            persistCameraState: async () => {
                calls.push('persist');
                throw new Error('persist offline');
            },
        };

        const controller = createCameraSyncController({
            camera,
            controls,
            collab,
            localUserId: 'local-user',
            requestRender: () => calls.push('render'),
            broadcastIntervalMs: 20,
            persistIntervalMs: 200,
            idleDelayMs: 200,
        });
        controller.setOwner('local-user');
        await new Promise((resolve) => setTimeout(resolve, 220));
        controls.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await Promise.resolve();
        const beforeDisposeCalls = calls.slice();

        controller.dispose();
        controller.setOwner('local-user');
        controls.dispatchEvent(new Event('change'));
        controller.handleRemoteState({
            sender: 'peer-user',
            position: [9, 9, 9],
            target: [1, 1, 1],
            up: [0, 1, 0],
            fov: 35,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        window.removeEventListener('unhandledrejection', onUnhandled);

        return {
            beforeDisposeCalls,
            afterDisposeCalls: calls.slice(),
            unhandled,
            cameraPosition: camera.position.toArray(),
        };
    });

    assert.deepEqual(result.beforeDisposeCalls, ['broadcast', 'persist'], 'Camera sync smoke: owner change did not send camera updates');
    assert.deepEqual(result.unhandled, [], 'Camera sync smoke: rejected camera sync promises became unhandled');
    assert.deepEqual(result.afterDisposeCalls, result.beforeDisposeCalls, 'Camera sync smoke: disposed controller still reacted to controls/remote state');
    assert.deepEqual(result.cameraPosition, [1, 2, 3], 'Camera sync smoke: disposed controller applied remote camera state');
    diagnostics.assertNoErrors('Camera sync lifecycle smoke');
    await page.close();
}

async function runRoomModelLoadQueueSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createRoomModelLoadQueue } = await import('/scripts/modules/collab/room-model-load-queue.js');

        let currentGeneration = 1;
        const events = [];
        const releases = new Map();
        const starts = new Map();

        const waitForStart = (id) => {
            if (starts.has(id)) return starts.get(id).promise;
            let resolve = null;
            const promise = new Promise((nextResolve) => {
                resolve = nextResolve;
            });
            starts.set(id, { promise, resolve });
            return promise;
        };

        const markStart = (id) => {
            if (!starts.has(id)) void waitForStart(id);
            starts.get(id).resolve();
        };

        const queue = createRoomModelLoadQueue({
            isCurrent: ({ generation, roomId }) => generation === currentGeneration && roomId === 'room-1',
            loadModelNow: async (model) => {
                const id = String(model?.id || '');
                events.push(`start:${id}`);
                markStart(id);
                if (id === 'A' || id === 'C') {
                    await new Promise((resolve) => {
                        releases.set(id, resolve);
                    });
                }
                events.push(`done:${id}`);
                return true;
            },
        });

        const firstLoad = queue.load({ id: 'A' }, { roomId: 'room-1', generation: 1 });
        await waitForStart('A');
        const secondLoadResult = await queue.load({ id: 'B' }, { roomId: 'room-1', generation: 1 });
        const staleLoadResult = await queue.load({ id: 'STALE' }, { roomId: 'room-1', generation: 2 });
        const pendingDuringActive = queue.getPendingModelIds();
        releases.get('A')();
        const firstLoadResult = await firstLoad;
        await waitForStart('B');

        currentGeneration = 2;
        const thirdLoad = queue.load({ id: 'C' }, { roomId: 'room-1', generation: 2 });
        await waitForStart('C');
        const removedBeforeDrain = queue.load({ id: 'D' }, { roomId: 'room-1', generation: 2 });
        const deletedPending = queue.delete({ roomId: 'room-1', modelId: 'D' });
        releases.get('C')();
        const thirdLoadResult = await thirdLoad;
        const removedLoadResult = await removedBeforeDrain;

        return {
            events,
            firstLoadResult,
            secondLoadResult,
            staleLoadResult,
            thirdLoadResult,
            removedLoadResult,
            pendingDuringActive,
            deletedPending,
            pendingAfter: queue.getPendingModelIds(),
            activeAfter: queue.isActive(),
        };
    });

    assert.equal(result.firstLoadResult, true, 'Room model queue smoke: first load did not complete');
    assert.equal(result.secondLoadResult, false, 'Room model queue smoke: concurrent load should be queued');
    assert.equal(result.staleLoadResult, false, 'Room model queue smoke: stale load should be ignored');
    assert.equal(result.thirdLoadResult, true, 'Room model queue smoke: next generation load did not complete');
    assert.equal(result.removedLoadResult, false, 'Room model queue smoke: queued load should resolve false immediately');
    assert.deepEqual(result.pendingDuringActive, ['B'], 'Room model queue smoke: concurrent model was not queued');
    assert.equal(result.deletedPending, true, 'Room model queue smoke: pending delete did not remove queued model');
    assert.deepEqual(result.pendingAfter, [], 'Room model queue smoke: pending queue did not drain');
    assert.equal(result.activeAfter, false, 'Room model queue smoke: queue stayed active after drain');
    assert.deepEqual(
        result.events,
        ['start:A', 'done:A', 'start:B', 'done:B', 'start:C', 'done:C'],
        'Room model queue smoke: queued/stale/deleted model order is wrong',
    );
    diagnostics.assertNoErrors('Room model load queue smoke');
    await page.close();
}

async function runDeferredRealtimeReloadSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createDeferredRealtimeReload } = await import('/scripts/modules/collab/deferred-realtime-reload.js');

        let muted = true;
        let currentGeneration = 1;
        const events = [];
        const releases = new Map();
        const starts = new Map();
        const dones = new Map();

        const waitFor = (map, label) => {
            if (map.has(label)) return map.get(label).promise;
            let resolve = null;
            const promise = new Promise((nextResolve) => {
                resolve = nextResolve;
            });
            map.set(label, { promise, resolve });
            return promise;
        };
        const mark = (map, label) => {
            if (!map.has(label)) void waitFor(map, label);
            map.get(label).resolve();
        };

        const reloader = createDeferredRealtimeReload({
            isMuted: () => muted,
            isCurrent: ({ generation }) => generation === currentGeneration,
            reload: async ({ label }) => {
                events.push(`start:${label}`);
                mark(starts, label);
                if (label === 'A' || label === 'B') {
                    await new Promise((resolve) => {
                        releases.set(label, resolve);
                    });
                }
                events.push(`done:${label}`);
                mark(dones, label);
            },
        });

        const requestMuted = reloader.request({ label: 'A', generation: 1 });
        const dirtyAfterMuted = reloader.isDirty();
        muted = false;
        const flushA = reloader.flush();
        await waitFor(starts, 'A');

        const requestQueued = reloader.request({ label: 'B', generation: 1 });
        currentGeneration = 2;
        const staleIgnored = reloader.request({ label: 'STALE', generation: 1 });
        currentGeneration = 1;

        releases.get('A')();
        await waitFor(dones, 'A');
        await waitFor(starts, 'B');

        muted = true;
        const requestWhileMutedInFlight = reloader.request({ label: 'C', generation: 1 });
        releases.get('B')();
        await waitFor(dones, 'B');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const beforeFlushEvents = events.slice();

        muted = false;
        const flushC = reloader.flush();
        await waitFor(dones, 'C');

        return {
            requestMuted,
            dirtyAfterMuted,
            flushA,
            requestQueued,
            staleIgnored,
            requestWhileMutedInFlight,
            flushC,
            beforeFlushEvents,
            events,
            dirtyAfterFlush: reloader.isDirty(),
            queuedAfterFlush: reloader.isQueued(),
            inFlightAfterFlush: reloader.isInFlight(),
            lastContext: reloader.getLastContext(),
        };
    });

    assert.equal(result.requestMuted, false, 'Deferred realtime smoke: muted request should be deferred');
    assert.equal(result.dirtyAfterMuted, true, 'Deferred realtime smoke: muted request did not mark dirty');
    assert.equal(result.flushA, true, 'Deferred realtime smoke: flush did not start deferred reload');
    assert.equal(result.requestQueued, false, 'Deferred realtime smoke: in-flight request should be queued');
    assert.equal(result.staleIgnored, false, 'Deferred realtime smoke: stale request should be ignored');
    assert.equal(result.requestWhileMutedInFlight, false, 'Deferred realtime smoke: muted in-flight request should be deferred');
    assert.deepEqual(result.beforeFlushEvents, ['start:A', 'done:A', 'start:B', 'done:B'], 'Deferred realtime smoke: dirty muted reload ran before unmute');
    assert.equal(result.flushC, true, 'Deferred realtime smoke: unmute flush did not replay dirty reload');
    assert.deepEqual(result.events, ['start:A', 'done:A', 'start:B', 'done:B', 'start:C', 'done:C'], 'Deferred realtime smoke: reload order is wrong');
    assert.equal(result.dirtyAfterFlush, false, 'Deferred realtime smoke: dirty flag stayed set');
    assert.equal(result.queuedAfterFlush, false, 'Deferred realtime smoke: queued flag stayed set');
    assert.equal(result.inFlightAfterFlush, false, 'Deferred realtime smoke: in-flight flag stayed set');
    assert.equal(result.lastContext?.label, 'C', 'Deferred realtime smoke: stale context replaced latest valid context');
    diagnostics.assertNoErrors('Deferred realtime reload smoke');
    await page.close();
}

async function runAbortableTusUploadSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { runAbortableTusUpload } = await import('/scripts/modules/collab/abortable-tus-upload.js');

        const events = [];
        let previousUploadsResolver = null;

        class SlowUpload {
            static instances = [];
            constructor(file, options) {
                this.file = file;
                this.options = options;
                SlowUpload.instances.push(this);
                events.push(`create:${file.name}`);
            }
            findPreviousUploads() {
                events.push('findPreviousUploads');
                return new Promise((resolve) => {
                    previousUploadsResolver = resolve;
                });
            }
            resumeFromPreviousUpload() {
                events.push('resume');
            }
            start() {
                events.push('start');
            }
            abort(shouldTerminate) {
                events.push(`abort:${shouldTerminate ? 'terminate' : 'keep'}`);
                return Promise.resolve();
            }
        }

        const abortController = new AbortController();
        const abortedPromise = runAbortableTusUpload({
            UploadCtor: SlowUpload,
            file: new File([new Uint8Array([1, 2, 3])], 'large.zip'),
            endpoint: '/upload',
            signal: abortController.signal,
            abortMessage: 'sync superseded',
        }).then(
            () => 'resolved',
            (err) => `${err?.name || 'Error'}:${err?.message || err}`,
        );

        for (let i = 0; i < 20 && !previousUploadsResolver; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        abortController.abort();
        previousUploadsResolver?.([]);
        const abortResult = await abortedPromise;

        class SuccessUpload {
            constructor(file, options) {
                this.file = file;
                this.options = options;
                events.push(`create:${file.name}`);
            }
            findPreviousUploads() {
                events.push('success:findPreviousUploads');
                return Promise.resolve([{ url: 'previous' }]);
            }
            resumeFromPreviousUpload() {
                events.push('success:resume');
            }
            start() {
                events.push('success:start');
                this.options.onProgress(25, 100);
                this.options.onSuccess();
            }
        }

        const progress = [];
        const successResult = await runAbortableTusUpload({
            UploadCtor: SuccessUpload,
            file: new File([new Uint8Array([1])], 'ok.zip'),
            endpoint: '/upload',
            onProgress: (bytesUploaded, bytesTotal) => progress.push(`${bytesUploaded}/${bytesTotal}`),
        }).then(() => 'resolved');

        return {
            abortResult,
            successResult,
            progress,
            events,
        };
    });

    assert.equal(result.abortResult, 'AbortError:sync superseded', 'Abortable TUS smoke: aborted upload did not reject with AbortError');
    assert.equal(result.events.includes('start'), false, 'Abortable TUS smoke: aborted upload started after abort');
    assert.ok(result.events.includes('abort:terminate'), 'Abortable TUS smoke: upload.abort(true) was not called');
    assert.equal(result.successResult, 'resolved', 'Abortable TUS smoke: successful upload did not resolve');
    assert.deepEqual(result.progress, ['25/100'], 'Abortable TUS smoke: progress callback did not fire');
    assert.ok(result.events.includes('success:resume'), 'Abortable TUS smoke: previous upload was not resumed');
    assert.ok(result.events.includes('success:start'), 'Abortable TUS smoke: successful upload did not start');
    diagnostics.assertNoErrors('Abortable TUS upload smoke');
    await page.close();
}

async function runWorkerLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const NativeWorker = globalThis.Worker;
        const THREE = await import('three');
        const successJson = new THREE.Group().toJSON();

        const events = [];
        let fbxAutoRespond = false;
        let zipAutoRespond = true;

        class FakeWorker {
            static instances = [];
            constructor(url) {
                this.url = String(url || '');
                this.onmessage = null;
                this.onerror = null;
                this.terminated = false;
                this.posts = [];
                FakeWorker.instances.push(this);
            }
            postMessage(message) {
                this.posts.push(message);
                if (this.terminated) {
                    events.push(`post-after-terminate:${this.kind}`);
                    return;
                }
                if (this.url.includes('fbx-worker')) {
                    this.kind = 'fbx';
                    if (fbxAutoRespond && message?.id != null) {
                        queueMicrotask(() => {
                            this.onmessage?.({
                                data: {
                                    id: message.id,
                                    ok: true,
                                    json: successJson,
                                    duration: 1,
                                    embedded: [],
                                    orientation: null,
                                },
                            });
                        });
                    }
                    return;
                }
                if (this.url.includes('zip-worker')) {
                    this.kind = 'zip';
                    if (message?.type === 'ack') {
                        events.push(`ack:${message.seq}`);
                        return;
                    }
                    if (zipAutoRespond && message?.id != null) {
                        queueMicrotask(() => {
                            this.onmessage?.({
                                data: {
                                    id: message.id,
                                    type: 'meta',
                                    counts: { fbx: 0, images: 0, geojson: 0 },
                                },
                            });
                            this.onmessage?.({ data: { id: message.id, type: 'done' } });
                        });
                    }
                }
            }
            terminate() {
                this.terminated = true;
                events.push(`terminate:${this.kind || 'unknown'}`);
            }
        }

        globalThis.Worker = FakeWorker;
        try {
            const { createFBXWorkerClient } = await import('/scripts/modules/workers/fbx-worker-client.js');
            const { createZIPWorkerClient } = await import('/scripts/modules/workers/zip-worker-client.js');

            const fbxClient = createFBXWorkerClient();
            const fbxAbort = new AbortController();
            const fbxFirst = fbxClient.parseFBXInWorker(
                new ArrayBuffer(8),
                { embedded: true, orientation: true },
                { signal: fbxAbort.signal },
            ).then(
                () => 'resolved',
                (err) => err?.name || String(err),
            );
            await Promise.resolve();
            fbxAbort.abort();
            const fbxAbortResult = await fbxFirst;
            const fbxOldWorker = FakeWorker.instances.find((worker) => worker.url.includes('fbx-worker'));
            fbxOldWorker?.onmessage?.({
                data: {
                    id: 1,
                    ok: true,
                    json: successJson,
                    duration: 1,
                    embedded: [{ short: 'late.png', buffer: new ArrayBuffer(1) }],
                    orientation: { source: 'late' },
                },
            });

            fbxAutoRespond = true;
            const fbxSecond = await fbxClient.parseFBXInWorker(
                new ArrayBuffer(8),
                { embedded: true, orientation: true },
            );

            const zipClient = createZIPWorkerClient();
            zipAutoRespond = false;
            const zipAbort = new AbortController();
            let resolveZipBuffer = null;
            const zipFile = {
                name: 'slow.zip',
                arrayBuffer: () => new Promise((resolve) => {
                    resolveZipBuffer = resolve;
                }),
            };
            const zipCallbacks = [];
            const zipFirst = zipClient.unpackZIPInWorker(zipFile, {
                onError: (err) => zipCallbacks.push(`onError:${err?.name || err}`),
            }, { signal: zipAbort.signal }).then(
                () => 'resolved',
                (err) => err?.name || String(err),
            );
            await Promise.resolve();
            zipAbort.abort();
            resolveZipBuffer(new ArrayBuffer(4));
            const zipAbortResult = await zipFirst;
            await Promise.resolve();
            const zipOldWorker = FakeWorker.instances.find((worker) => worker.url.includes('zip-worker'));
            zipOldWorker?.onmessage?.({ data: { id: 1, type: 'done' } });

            zipAutoRespond = true;
            const zipSecondMeta = [];
            const zipSecond = await zipClient.unpackZIPInWorker({
                name: 'ok.zip',
                arrayBuffer: async () => new ArrayBuffer(4),
            }, {
                onMeta: (msg) => zipSecondMeta.push(msg.counts?.fbx ?? -1),
                onError: (err) => zipCallbacks.push(`lateOnError:${err?.name || err}`),
            });

            return {
                fbxAbortResult,
                fbxOldTerminated: !!fbxOldWorker?.terminated,
                fbxSecondOk: !!fbxSecond?.obj,
                fbxWorkerCount: FakeWorker.instances.filter((worker) => worker.url.includes('fbx-worker')).length,
                zipAbortResult,
                zipOldTerminated: !!zipOldWorker?.terminated,
                zipSecondType: zipSecond?.type || null,
                zipWorkerCount: FakeWorker.instances.filter((worker) => worker.url.includes('zip-worker')).length,
                zipCallbacks,
                zipSecondMeta,
                events,
            };
        } finally {
            globalThis.Worker = NativeWorker;
        }
    });

    assert.equal(result.fbxAbortResult, 'AbortError', 'Worker smoke: FBX abort did not reject with AbortError');
    assert.equal(result.fbxOldTerminated, true, 'Worker smoke: FBX worker was not terminated on abort');
    assert.equal(result.fbxSecondOk, true, 'Worker smoke: FBX worker did not recover after abort');
    assert.equal(result.fbxWorkerCount, 2, 'Worker smoke: FBX worker was not recreated after abort');
    assert.equal(result.zipAbortResult, 'AbortError', 'Worker smoke: ZIP abort did not reject with AbortError');
    assert.equal(result.zipOldTerminated, true, 'Worker smoke: ZIP worker was not terminated on abort');
    assert.equal(result.zipSecondType, 'done', 'Worker smoke: ZIP worker did not recover after abort');
    assert.equal(result.zipWorkerCount, 2, 'Worker smoke: ZIP worker was not recreated after abort');
    assert.deepEqual(result.zipCallbacks, [], 'Worker smoke: ZIP stale onError fired after abort');
    assert.deepEqual(result.zipSecondMeta, [0], 'Worker smoke: ZIP next job did not receive meta after abort');
    assert.equal(result.events.includes('post-after-terminate:zip'), false, 'Worker smoke: ZIP posted ack to a terminated worker');
    diagnostics.assertNoErrors('Worker lifecycle smoke');
    await page.close();
}

async function runFBXCleanupLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { splitMeshByUDIM } = await import('/scripts/modules/fbx/udim-split.js');
        const { createFBXFileHandler } = await import('/scripts/modules/io/fbx-file.js');

        const disposedGeometries = [];
        const disposedMaterials = [];
        let skeletonDisposed = 0;
        const nativeDispose = THREE.BufferGeometry.prototype.dispose;
        const nativeMaterialDispose = THREE.Material.prototype.dispose;
        THREE.BufferGeometry.prototype.dispose = function patchedDispose(...args) {
            disposedGeometries.push(this.name || this.uuid || 'geometry');
            return nativeDispose.apply(this, args);
        };
        THREE.Material.prototype.dispose = function patchedMaterialDispose(...args) {
            disposedMaterials.push(this.name || this.uuid || 'material');
            return nativeMaterialDispose.apply(this, args);
        };

        function makeGeometry({ split = false } = {}) {
            const geometry = new THREE.BufferGeometry();
            geometry.name = split ? 'splitSource' : 'singleSource';
            geometry.setAttribute('position', new THREE.Float32BufferAttribute([
                0, 0, 0,
                1, 0, 0,
                0, 1, 0,
                0, 0, 1,
                1, 0, 1,
                0, 1, 1,
            ], 3));
            geometry.setAttribute('uv', new THREE.Float32BufferAttribute(split ? [
                0.1, 0.1,
                0.2, 0.1,
                0.1, 0.2,
                1.1, 0.1,
                1.2, 0.1,
                1.1, 0.2,
            ] : [
                0.1, 0.1,
                0.2, 0.1,
                0.1, 0.2,
                0.3, 0.1,
                0.4, 0.1,
                0.3, 0.2,
            ], 2));
            return geometry;
        }

        try {
            const singleParent = new THREE.Group();
            const singleMesh = new THREE.Mesh(makeGeometry(), new THREE.MeshBasicMaterial({ name: 'singleMaterial' }));
            singleParent.add(singleMesh);
            const beforeSingle = disposedGeometries.length;
            const singleResult = splitMeshByUDIM(singleMesh);
            const singleDisposed = disposedGeometries.length - beforeSingle;

            const splitParent = new THREE.Group();
            const sourceMaterial = new THREE.MeshBasicMaterial({ name: 'sourceMaterial' });
            const customDepth = new THREE.MeshDepthMaterial();
            const customDistance = new THREE.MeshDistanceMaterial();
            const splitMesh = new THREE.Mesh(makeGeometry({ split: true }), sourceMaterial);
            splitMesh.customDepthMaterial = customDepth;
            splitMesh.customDistanceMaterial = customDistance;
            splitParent.add(splitMesh);

            const beforeSplit = disposedGeometries.length;
            const splitResult = splitMeshByUDIM(splitMesh);
            const splitDisposed = disposedGeometries.length - beforeSplit;
            const holder = splitParent.children[0] || null;

            const abortWorld = new THREE.Group();
            const abortLoadedModels = [];
            const abortRoot = new THREE.Group();
            const abortGeometry = makeGeometry();
            abortGeometry.name = 'abortGeometry';
            const abortMaterial = new THREE.MeshBasicMaterial({ name: 'abortMaterial' });
            const abortMesh = new THREE.Mesh(abortGeometry, abortMaterial);
            abortMesh.skeleton = {
                dispose: () => {
                    skeletonDisposed += 1;
                },
            };
            abortRoot.add(abortMesh);

            let releaseParse = null;
            let markParseStarted = null;
            const parseStarted = new Promise((resolve) => {
                markParseStarted = resolve;
            });
            const abortController = new AbortController();
            const handleFBXFile = createFBXFileHandler({
                THREE,
                world: abortWorld,
                loadedModels: abortLoadedModels,
                parseFBXOnMainThread: async () => {
                    markParseStarted();
                    await new Promise((resolve) => {
                        releaseParse = resolve;
                    });
                    return { obj: abortRoot, duration: 1 };
                },
            });
            const abortPromise = handleFBXFile(
                new File([new Uint8Array([1, 2, 3])], 'abort.fbx', { type: 'application/octet-stream' }),
                null,
                null,
                null,
                { signal: abortController.signal },
            ).then(
                () => 'resolved',
                (err) => err?.name || String(err),
            );
            await parseStarted;
            abortController.abort();
            releaseParse();
            const abortResult = await abortPromise;

            return {
                singleResult,
                singleDisposed,
                singleStillInParent: singleParent.children[0] === singleMesh,
                splitResult,
                splitDisposed,
                holderIsUDIM: !!holder?.userData?.udimHolder,
                holderMaterialTracked: holder?.userData?._removedMaterials === sourceMaterial,
                holderDepthTracked: holder?.userData?._removedCustomDepthMaterial === customDepth,
                holderDistanceTracked: holder?.userData?._removedCustomDistanceMaterial === customDistance,
                childTileCount: holder?.children?.length || 0,
                oldMeshDetached: splitMesh.parent == null,
                oldMeshCleared: splitMesh.geometry == null && splitMesh.material == null,
                abortResult,
                abortWorldChildren: abortWorld.children.length,
                abortLoadedCount: abortLoadedModels.length,
                abortGeometryDisposed: disposedGeometries.includes('abortGeometry'),
                abortMaterialDisposed: disposedMaterials.includes('abortMaterial'),
                skeletonDisposed,
            };
        } finally {
            THREE.BufferGeometry.prototype.dispose = nativeDispose;
            THREE.Material.prototype.dispose = nativeMaterialDispose;
        }
    });

    assert.equal(result.singleResult, false, 'FBX cleanup smoke: single-UDIM mesh should not be split');
    assert.equal(result.singleDisposed, 1, 'FBX cleanup smoke: no-op UDIM temp geometry was not disposed');
    assert.equal(result.singleStillInParent, true, 'FBX cleanup smoke: no-op UDIM changed scene tree');
    assert.equal(result.splitResult, true, 'FBX cleanup smoke: multi-UDIM mesh was not split');
    assert.equal(result.splitDisposed, 2, 'FBX cleanup smoke: split source/temp geometries were not disposed');
    assert.equal(result.holderIsUDIM, true, 'FBX cleanup smoke: split holder missing');
    assert.equal(result.holderMaterialTracked, true, 'FBX cleanup smoke: removed source material is not tracked for later dispose');
    assert.equal(result.holderDepthTracked, true, 'FBX cleanup smoke: removed custom depth material is not tracked for later dispose');
    assert.equal(result.holderDistanceTracked, true, 'FBX cleanup smoke: removed custom distance material is not tracked for later dispose');
    assert.equal(result.childTileCount, 2, 'FBX cleanup smoke: expected two UDIM tile groups');
    assert.equal(result.oldMeshDetached, true, 'FBX cleanup smoke: original split mesh stayed attached');
    assert.equal(result.oldMeshCleared, true, 'FBX cleanup smoke: original split mesh retained disposed resources');
    assert.equal(result.abortResult, 'AbortError', 'FBX cleanup smoke: aborted post-parse FBX did not reject with AbortError');
    assert.equal(result.abortWorldChildren, 0, 'FBX cleanup smoke: aborted post-parse FBX was added to world');
    assert.equal(result.abortLoadedCount, 0, 'FBX cleanup smoke: aborted post-parse FBX was registered as loaded');
    assert.equal(result.abortGeometryDisposed, true, 'FBX cleanup smoke: aborted post-parse geometry was not disposed');
    assert.equal(result.abortMaterialDisposed, true, 'FBX cleanup smoke: aborted post-parse material was not disposed');
    assert.equal(result.skeletonDisposed, 1, 'FBX cleanup smoke: aborted post-parse skeleton was not disposed exactly once');
    diagnostics.assertNoErrors('FBX cleanup lifecycle smoke');
    await page.close();
}

async function runVPMAutobindLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const { createVPMBinder } = await import('/scripts/modules/material/vpm-autobind.js');

        const disposed = [];
        const labels = new Map();
        let bitmapClosed = 0;
        let releaseBitmap = null;
        const nativeCreateImageBitmap = globalThis.createImageBitmap;
        const nativeClose = globalThis.ImageBitmap?.prototype?.close || null;

        if (nativeClose) {
            globalThis.ImageBitmap.prototype.close = function patchedClose(...args) {
                bitmapClosed += 1;
                return nativeClose.apply(this, args);
            };
        }
        globalThis.createImageBitmap = async (...args) => {
            await new Promise((resolve) => {
                releaseBitmap = resolve;
            });
            return nativeCreateImageBitmap(...args);
        };

        class FakeTexture {
            constructor(label = '') {
                this.label = label;
                this.name = label;
                this.isTexture = true;
                this.userData = {};
            }
            dispose() {
                disposed.push(`texture:${this.label || this.name || 'unnamed'}`);
            }
        }

        class FakeMaterial {
            constructor(name = 'mat') {
                this.name = name;
                this.userData = {};
                this.alphaTest = 0;
                this.transparent = false;
            }
            clone() {
                return new FakeMaterial(`${this.name}:clone`);
            }
            dispose() {
                disposed.push(`material:${this.name}`);
            }
        }

        class FakeShadowMaterial {
            constructor(params = {}) {
                Object.assign(this, params);
            }
            dispose() {
                disposed.push('shadow');
            }
        }

        const THREE = {
            CanvasTexture: class FakeCanvasTexture extends FakeTexture {
                constructor() {
                    super('canvas');
                }
            },
            MeshDepthMaterial: FakeShadowMaterial,
            MeshDistanceMaterial: FakeShadowMaterial,
            LinearSRGBColorSpace: 'linear',
            SRGBColorSpace: 'srgb',
            FrontSide: 0,
            RGBADepthPacking: 1,
            Vector2: class FakeVector2 {
                constructor(x, y) {
                    this.x = x;
                    this.y = y;
                }
            },
            Color: class FakeColor {
                constructor(r, g, b) {
                    this.r = r;
                    this.g = g;
                    this.b = b;
                }
            },
        };

        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgb(128, 64, 32)';
        ctx.fillRect(0, 0, 1, 1);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const urls = [URL.createObjectURL(blob), URL.createObjectURL(blob), URL.createObjectURL(blob)];
        labels.set(urls[0], 'T_foo_bar_Diffuse_1.1001.png');
        labels.set(urls[1], 'T_foo_bar_Normal_1.1001.png');
        labels.set(urls[2], 'T_foo_bar_ERM_1.1001.png');

        const baseMaterial = new FakeMaterial('base');
        const mesh = {
            isMesh: true,
            name: 'Mesh',
            userData: {},
            geometry: { getAttribute: () => null },
            material: baseMaterial,
        };
        const root = {
            userData: { _fbxFileName: 'SM_foo_bar.fbx' },
            traverse: (callback) => callback(mesh),
        };
        const loadedModels = [{ obj: root, name: 'SM_foo_bar.fbx', zipKind: 'SM' }];
        const binder = createVPMBinder({
            THREE,
            loadedModels,
            labelFromURL: (url) => labels.get(url) || '',
            toStandard: (material) => material,
            textureLoader: { load: (url) => new FakeTexture(labels.get(url) || url) },
            detectSlotFromMatOrObj: () => 1,
            requestRender: () => disposed.push('requestRender'),
            schedulePanelRefresh: () => disposed.push('panelRefresh'),
            materialsPanel: { markNeedsFullRefresh: () => disposed.push('materialsRefresh') },
        });

        try {
            const vpmIndex = binder.buildVPMIndex([
                { url: urls[0] },
                { url: urls[1] },
                { url: urls[2] },
            ]);
            const bindPromise = binder.autoBindVPMForModel(root, vpmIndex);

            for (let i = 0; i < 50 && !releaseBitmap; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            if (!releaseBitmap) throw new Error('VPM smoke: createImageBitmap was not reached');

            loadedModels.length = 0;
            releaseBitmap();
            await bindPromise;

            return {
                materialStillOriginal: mesh.material === baseMaterial,
                customDepthCleared: mesh.customDepthMaterial == null,
                customDistanceCleared: mesh.customDistanceMaterial == null,
                disposed,
                bitmapClosed,
            };
        } finally {
            globalThis.createImageBitmap = nativeCreateImageBitmap;
            if (nativeClose) globalThis.ImageBitmap.prototype.close = nativeClose;
            urls.forEach((url) => URL.revokeObjectURL(url));
        }
    });

    assert.equal(result.materialStillOriginal, true, 'VPM smoke: stale async bind replaced material after model removal');
    assert.equal(result.customDepthCleared, true, 'VPM smoke: stale async bind leaked custom depth material');
    assert.equal(result.customDistanceCleared, true, 'VPM smoke: stale async bind leaked custom distance material');
    assert.equal(result.bitmapClosed, 1, 'VPM smoke: ERM ImageBitmap was not closed');
    assert.ok(result.disposed.includes('texture:T_foo_bar_Diffuse_1.1001.png'), 'VPM smoke: stale diffuse texture was not disposed');
    assert.ok(result.disposed.includes('texture:T_foo_bar_Normal_1.1001.png'), 'VPM smoke: stale normal texture was not disposed');
    assert.equal(result.disposed.filter((entry) => entry === 'texture:canvas').length, 3, 'VPM smoke: stale ERM channel textures were not disposed');
    assert.equal(result.disposed.filter((entry) => entry === 'shadow').length, 2, 'VPM smoke: stale custom shadow materials were not disposed');
    assert.equal(result.disposed.includes('requestRender'), false, 'VPM smoke: stale async bind requested render after model removal');
    diagnostics.assertNoErrors('VPM autobind lifecycle smoke');
    await page.close();
}

async function runEnvironmentLifecycleSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createEnvironmentManager } = await import('/scripts/modules/render/environment-manager.js');

        const data = new Float32Array([1, 1, 1, 1]);
        const sourceTex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.FloatType);
        sourceTex.mapping = THREE.EquirectangularReflectionMapping;
        sourceTex.needsUpdate = true;

        let sourceDisposed = 0;
        sourceTex.addEventListener('dispose', () => {
            sourceDisposed += 1;
        });

        let releaseLoad = null;
        let loadCount = 0;
        const loadStarted = new Promise((resolve) => {
            const resolveStarted = resolve;
            const loader = async () => {
                loadCount += 1;
                resolveStarted();
                await new Promise((loadResolve) => {
                    releaseLoad = loadResolve;
                });
                return sourceTex;
            };
            globalThis.__smokeLoadEnvironmentTexture = loader;
        });

        const scene = new THREE.Scene();
        const events = [];
        const manager = createEnvironmentManager({
            scene,
            useWebGPU: true,
            enabled: true,
            rendererInitPromise: Promise.resolve(),
            loadEquirectTexture: (...args) => globalThis.__smokeLoadEnvironmentTexture(...args),
            requestRender: () => events.push('render'),
            onEnvironmentUpdated: (event) => events.push(`updated:${event?.type || 'unknown'}`),
        });

        const rebuildPromise = manager.rebuild({ force: true });
        await loadStarted;
        manager.dispose();
        releaseLoad();
        await rebuildPromise;

        delete globalThis.__smokeLoadEnvironmentTexture;
        return {
            sceneEnvironmentCleared: scene.environment == null,
            currentEnvCleared: manager.getCurrentEnv() == null,
            currentBgCleared: manager.getCurrentBg() == null,
            hdrBaseCleared: manager.getHDRBase() == null,
            disabled: manager.isEnabled() === false,
            loadCount,
            sourceDisposed,
            events,
        };
    });

    assert.equal(result.loadCount, 1, 'Environment smoke: HDR loader was not exercised');
    assert.equal(result.sourceDisposed, 1, 'Environment smoke: late HDR texture was not disposed after manager dispose');
    assert.equal(result.sceneEnvironmentCleared, true, 'Environment smoke: disposed manager restored scene.environment');
    assert.equal(result.currentEnvCleared, true, 'Environment smoke: disposed manager retained currentEnv');
    assert.equal(result.currentBgCleared, true, 'Environment smoke: disposed manager retained currentBg');
    assert.equal(result.hdrBaseCleared, true, 'Environment smoke: disposed manager retained hdrBaseTex');
    assert.equal(result.disabled, true, 'Environment smoke: disposed manager stayed enabled');
    assert.deepEqual(result.events, [], 'Environment smoke: disposed manager fired render/update callbacks');
    diagnostics.assertNoErrors('Environment lifecycle smoke');
    await page.close();
}

async function runMaterialsPanelRemovalSmoke(browser, baseUrl) {
    const page = await browser.newPage();
    const diagnostics = attachPageDiagnostics(page);
    await page.goto(`${baseUrl}/__smoke_blank`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const result = await page.evaluate(async () => {
        const THREE = await import('three');
        const { createMaterialsPanelController } = await import('/scripts/modules/ui/materials-panel.js');

        const world = new THREE.Group();
        const loadedModels = [];
        const outEl = document.createElement('div');
        const matSelect = document.createElement('select');
        document.body.append(outEl, matSelect);

        const panel = createMaterialsPanelController({
            world,
            loadedModels,
            outEl,
            matSelect,
            requestRender: () => {},
        });

        const flushPanel = async () => {
            panel.scheduleRefresh();
            await Promise.resolve();
            await Promise.resolve();
        };

        const createModel = (label) => {
            const root = new THREE.Group();
            root.name = `${label}-root`;
            const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(1, 1, 1),
                new THREE.MeshStandardMaterial({ name: `${label}-material` })
            );
            mesh.name = `${label}-mesh`;
            root.add(mesh);
            world.add(root);
            const record = { obj: root, name: `${label}.fbx` };
            loadedModels.push(record);
            return record;
        };

        const first = createModel('first');
        await flushPanel();
        const firstPanelText = outEl.textContent || '';
        const firstOptions = matSelect.options.length;

        loadedModels.splice(0, loadedModels.length);
        world.remove(first.obj);
        panel.markNeedsFullRefresh();
        await flushPanel();
        const afterRemovalText = outEl.textContent || '';
        const afterRemovalOptions = matSelect.options.length;

        createModel('second');
        await flushPanel();
        const secondPanelText = outEl.textContent || '';
        const secondOptions = matSelect.options.length;

        return {
            firstRendered: firstPanelText.includes('first.fbx') && firstPanelText.includes('first-material'),
            firstOptions,
            stalePanelCleared: !afterRemovalText.includes('first.fbx') && !afterRemovalText.includes('first-material'),
            afterRemovalOptions,
            secondRendered: secondPanelText.includes('second.fbx') && secondPanelText.includes('second-material'),
            oldModelStillAbsent: !secondPanelText.includes('first.fbx') && !secondPanelText.includes('first-material'),
            secondOptions,
        };
    });

    assert.equal(result.firstRendered, true, 'Materials panel removal smoke: first model was not rendered');
    assert.equal(result.firstOptions, 2, 'Materials panel removal smoke: first material dropdown not populated');
    assert.equal(result.stalePanelCleared, true, 'Materials panel removal smoke: removed model stayed in panel DOM');
    assert.equal(result.afterRemovalOptions, 1, 'Materials panel removal smoke: removed model stayed in material dropdown');
    assert.equal(result.secondRendered, true, 'Materials panel removal smoke: second model was not rendered');
    assert.equal(result.oldModelStillAbsent, true, 'Materials panel removal smoke: stale model was mixed with new model');
    assert.equal(result.secondOptions, 2, 'Materials panel removal smoke: second material dropdown not populated');
    diagnostics.assertNoErrors('Materials panel removal smoke');
    await page.close();
}

const smokeServer = await createStaticServer();
const browser = await chromium.launch({
    headless: true,
    args: [
        '--use-angle=swiftshader',
        '--use-gl=angle',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
    ],
});

try {
    console.log(`Smoke server: ${smokeServer.baseUrl}`);
    await runBootSmoke(browser, smokeServer.baseUrl);
    console.log('Boot smoke passed.');
    await runRoomEntrySmoke(browser, smokeServer.baseUrl);
    console.log('Room-entry smoke passed.');
    await runDisposeReinitSmoke(browser, smokeServer.baseUrl);
    console.log('Dispose/reinit smoke passed.');
    await runFileFlowFailureSmoke(browser, smokeServer.baseUrl);
    console.log('File-flow failure smoke passed.');
    await runCollabRealtimeDisposeSmoke(browser, smokeServer.baseUrl);
    console.log('Collab realtime dispose smoke passed.');
    await runCollabInitFailureCleanupSmoke(browser, smokeServer.baseUrl);
    console.log('Collab init-failure cleanup smoke passed.');
    await runCameraSyncLifecycleSmoke(browser, smokeServer.baseUrl);
    console.log('Camera sync lifecycle smoke passed.');
    await runRoomModelLoadQueueSmoke(browser, smokeServer.baseUrl);
    console.log('Room model load queue smoke passed.');
    await runDeferredRealtimeReloadSmoke(browser, smokeServer.baseUrl);
    console.log('Deferred realtime reload smoke passed.');
    await runAbortableTusUploadSmoke(browser, smokeServer.baseUrl);
    console.log('Abortable TUS upload smoke passed.');
    await runWorkerLifecycleSmoke(browser, smokeServer.baseUrl);
    console.log('Worker lifecycle smoke passed.');
    await runFBXCleanupLifecycleSmoke(browser, smokeServer.baseUrl);
    console.log('FBX cleanup lifecycle smoke passed.');
    await runVPMAutobindLifecycleSmoke(browser, smokeServer.baseUrl);
    console.log('VPM autobind lifecycle smoke passed.');
    await runEnvironmentLifecycleSmoke(browser, smokeServer.baseUrl);
    console.log('Environment lifecycle smoke passed.');
    await runMaterialsPanelRemovalSmoke(browser, smokeServer.baseUrl);
    console.log('Materials panel removal smoke passed.');
} finally {
    await browser.close();
    await smokeServer.close();
}
