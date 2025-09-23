import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

class ViewerApp {
    constructor() {
        const app = this;

/*
            Полный рефакторинг JS:
            - структурирован по разделам
            - все функции и переменные явно именованы
            - подробные комментарии на русском
            - аккуратные 4-пробельные отступы
        */


        

        // =====================
        // DOM references
        // =====================
        const rootEl          = document.getElementById('viewer');
        const dropEl          = document.getElementById('drop');
        const statusEl        = document.getElementById('status');
        const appbarStatusEl  = document.getElementById('appbarStatus');
        const shadingSel      = document.getElementById('shadingMode');

        

        const sunHourEl  = document.getElementById('sunHour');
        const sunDayEl   = document.getElementById('sunDay');
        const sunMonthEl = document.getElementById('sunMonth');
        const sunNorthEl = document.getElementById('sunNorth');

        const imagesDetails = document.getElementById('imagesDetails');
        const bindLogDetails = document.getElementById('bindLogDetails');
        

        // Москва
        const MOSCOW_LAT = 55.7558;
        const MOSCOW_LON = 37.6173;

        const iblChk          = document.getElementById('hdriChk');
        const hdriPresetSel   = document.getElementById('hdriPreset');
        const iblIntEl        = document.getElementById('iblInt');
        const iblRotEl        = document.getElementById('iblRot');
        const axisSel         = document.getElementById('axisSelect');
        const toggleSideBtn   = document.getElementById('toggleSideBtn');

        const glassOpacityEl  = document.getElementById('glassOpacity');
        const glassReflectEl  = document.getElementById('glassReflect');
        const glassMetalEl    = document.getElementById('glassMetal');

        const outEl           = document.getElementById('out');
        const galleryEl       = document.getElementById('gallery');
        const texCountEl      = document.getElementById('texCount');
        const matSelect       = document.getElementById('matSelect');
        const bindLogEl       = document.getElementById('bindLog');

        const bgAlphaEl       = document.getElementById('bgAlpha');
        bgAlphaEl.addEventListener('input', updateBgVisibility);


        let didInitialRebase = false;
        let currentShadingMode = 'pbr';
        app.dom = {
            rootEl,
            dropEl,
            statusEl,
            appbarStatusEl,
            shadingSel,
            sunHourEl,
            sunDayEl,
            sunMonthEl,
            sunNorthEl,
            imagesDetails,
            bindLogDetails,
            iblChk,
            hdriPresetSel,
            iblIntEl,
            iblRotEl,
            axisSel,
            toggleSideBtn,
            glassOpacityEl,
            glassReflectEl,
            glassMetalEl,
            outEl,
            galleryEl,
            texCountEl,
            matSelect,
            bindLogEl,
            bgAlphaEl,
        };
        app.location = { latitude: MOSCOW_LAT, longitude: MOSCOW_LON };



        // =====================
        // THREE.js scene init
        // =====================
        const scene    = new THREE.Scene();
        scene.background = new THREE.Color(0xf5f5f7);

        const world    = new THREE.Group();
        scene.add(world);

        let bgMesh = null; // background sphere used to show HDRI
        app.bgMesh = bgMesh;

        const camera   = new THREE.PerspectiveCamera(60, 1, 0.01, 5000);
        camera.position.set(2.5, 1.5, 3.5);

        const renderer = new THREE.WebGLRenderer({ antialias: true });

        // ➕ ВКЛЮЧАЕМ ТЕНИ
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap; // можно VSM, если хотите более мягкие

        renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;
        rootEl.appendChild(renderer.domElement);

        
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;

        // Простое освещение и сетка
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0xcfd8dc, 1);

        scene.add(hemiLight);
        const dirLight = new THREE.DirectionalLight(0xffffff, 10.0);
        dirLight.castShadow = true;
        dirLight.shadow.mapSize.set(4096, 4096);
        dirLight.shadow.bias = -0.0005;      // боремся с acne
        dirLight.shadow.normalBias = 0.02;    // боремся с peter-panning
        dirLight.position.set(3, 5, 4);
        scene.add(dirLight);

        let sunEnabled = true;
        const sunDir = new THREE.Vector3(0, 1, 0); // актуальное направление солнца (единичный)



        const grid = new THREE.GridHelper(100, 100, 0x666666, 0x999999);
        grid.material.transparent = true;
        grid.material.opacity = 0.5;
        grid.userData.excludeFromBounds = true; // ← исключать из bbox
        
       scene.add(grid);
        app.scene = scene;
        app.world = world;
        app.camera = camera;
        app.renderer = renderer;
        app.controls = controls;
        app.hemiLight = hemiLight;
        app.dirLight = dirLight;
        app.grid = grid;
        app.sun = { enabled: sunEnabled, direction: sunDir.clone() };



        // ----------------------------
        // DEBUG SHADDOW PANNEL'S LOGIC
        // ----------------------------

        // --- Shadows debug panel (после создания dirLight!) ---
                const $ = (id) => document.getElementById(id);

                const shadowDbgBtn   = $('shadowDbgBtn');
                const shadowDbg      = $('shadowDbg');
                const shadowDbgClose = $('shadowDbgClose');

                const inType   = $('shadowType');
                const inSize   = $('shadowMapSize');
                const inBias   = $('shadowBias');
                const inNBias  = $('shadowNormalBias');
                const inRadius = $('shadowRadius');
                const inNear   = $('shadowNear');
                const inFar    = $('shadowFar');
                const inAuto   = $('shadowAuto');
                const inScale  = $('shadowFrustumScale');

                function openShadowDbg(){ if (shadowDbg) { syncShadowUIFromLight(); shadowDbg.classList.add('show'); } }
                function closeShadowDbg(){ shadowDbg?.classList.remove('show'); }

                document.getElementById('shadowHelpersBtn').addEventListener('click', () => {
                    const next = !(shadowCamHelper?.visible);
                    setShadowDebug(next);
                    fitSunShadowToScene();
                });

                shadowDbgBtn?.addEventListener('click', openShadowDbg);
                shadowDbgClose?.addEventListener('click', closeShadowDbg);

                function syncShadowUIFromLight(){
                if (!dirLight) return;
                const s = dirLight.shadow;
                inBias.value   = String(s.bias ?? -0.00005);
                inNBias.value  = String(s.normalBias ?? 0.02);
                inRadius.value = String(('radius' in s) ? (s.radius ?? 1) : 1);
                inNear.value   = String(s.camera?.near ?? 0.1);
                inFar.value    = String(s.camera?.far  ?? 200);
                inSize.value   = String(s.mapSize?.x ?? 4096);

                // тип теней
                const t = renderer.shadowMap.type;
                inType.value = (t === THREE.VSMShadowMap) ? 'VSM' : (t === THREE.PCFShadowMap ? 'PCF' : 'PCFSoft');

                inAuto.checked = !!shadowAutoFrustum;
                inScale.value  = String(shadowFrustumScale);
                }

                function applyShadowUIToLight(){
                if (!dirLight) return;

                // тип теней
                const typeMap = { PCF: THREE.PCFShadowMap, PCFSoft: THREE.PCFSoftShadowMap, VSM: THREE.VSMShadowMap };
                renderer.shadowMap.type = typeMap[inType.value] ?? THREE.PCFSoftShadowMap;
                renderer.shadowMap.enabled = true;
                dirLight.castShadow = true;

                // размер карты
                const size = Math.max(256, parseInt(inSize.value, 10) || 1024);
                if (dirLight.shadow.mapSize.x !== size || dirLight.shadow.mapSize.y !== size) {
                    dirLight.shadow.mapSize.set(size, size);
                    dirLight.shadow.map?.dispose?.(); // пересоздать рендер-таргет
                }

                // смещения
                dirLight.shadow.bias       = parseFloat(inBias.value)  || 0;
                dirLight.shadow.normalBias = parseFloat(inNBias.value) || 0;

                // радиус (для PCFSoft/VSM)
                if ('radius' in dirLight.shadow) {
                    dirLight.shadow.radius = parseFloat(inRadius.value) || 0;
                }

                // near/far + фрустум
                const cam = dirLight.shadow.camera;
                if (cam) {
                    cam.near = Math.max(0.0001, parseFloat(inNear.value) || 0.1);
                    cam.far  = Math.max(cam.near + 0.01, parseFloat(inFar.value)  || cam.far || 200);
                    cam.updateProjectionMatrix();
                }

                // авто-фрустум от сцены + масштаб
                shadowAutoFrustum = !!inAuto.checked;
                shadowFrustumScale = Math.max(0.01, parseFloat(inScale.value) || 1);
                if (shadowAutoFrustum) fitSunShadowToScene(false);

                dirLight.shadow.needsUpdate = true;
                renderer.render(scene, camera);
                }

                $('shadowApply')?.addEventListener('click', applyShadowUIToLight);
                $('shadowReset')?.addEventListener('click', () => {
                inType.value   = 'PCFSoft';
                inSize.value   = '4096';
                inBias.value   = '-0.00005';
                inNBias.value  = '0.02';
                inRadius.value = '1';
                inNear.value   = '0.1';
                inFar.value    = '200';
                inAuto.checked = true;
                inScale.value  = '1';
                applyShadowUIToLight();
                });

        // ---------------------------------
        // END OF DEBUG SHADDOW PANNEL LOGIC
        // ---------------------------------

       
        // SUN elements
        // ссылки
        const sunEnabledEl  = document.getElementById('sunEnabled');
        const sunControlsEl = document.getElementById('sunControls');

        // якорь для "возврата" панели на то же место
        let sunAnchor = null;
        if (sunControlsEl && sunControlsEl.parentNode) {
            sunAnchor = document.createComment('sun-controls-anchor');
            sunControlsEl.parentNode.insertBefore(sunAnchor, sunControlsEl); // ставим якорь прямо перед блоком
        }

        // функции монтажа/демонтажа
        function mountSunControls() {
            if (!sunControlsEl || !sunAnchor) return;
            if (sunControlsEl.isConnected) return;         // уже на месте
            sunAnchor.replaceWith(sunControlsEl);          // вернуть ровно туда, где стоял якорь
            try { layout(); } catch(_) {}
        }

        function unmountSunControls() {
            if (!sunControlsEl || !sunControlsEl.isConnected) return;
            if (!sunAnchor) return;
            // вернуть якорь перед панелью и убрать панель
            sunControlsEl.parentNode.insertBefore(sunAnchor, sunControlsEl);
            sunControlsEl.remove();
            try { layout(); } catch(_) {}
        }

        // главный переключатель солнца+теней
        function setSunEnabled(on){
            on = !!on;
            sunEnabled = on;
            app.sun.enabled = on;

            // источник и тени
            dirLight.visible = on;
            dirLight.castShadow = on;
            renderer.shadowMap.enabled = on;

            // убираем/возвращаем регуляторы в тулбар
            if (on) {
                mountSunControls();
                updateSun();            // пересчитать позицию солнца
                fitSunShadowToScene();  // обновить объём теней
            } else {
                unmountSunControls();
            }

            renderer.render(scene, camera);
        }

        // инициализация тумблера
        sunEnabledEl?.addEventListener('change', e => setSunEnabled(e.target.checked));
        setSunEnabled(sunEnabledEl?.checked ?? true);


        // =====================
        // Loaders & caches
        // =====================
        const fbxLoader      = new FBXLoader();
        const textureLoader  = new THREE.TextureLoader();
        const texLd          = new THREE.TextureLoader(); // for small helper textures

        let pmremGen     = app.pmremGen     = null;      // PMREM generator (lazy)
        let hdrBaseTex   = app.hdrBaseTex   = null;      // original equirect HDR (DataTexture)
        const HDRI_LIBRARY = [
            { name: "Royal Esplanade", url: "https://threejs.org/examples/textures/equirectangular/royal_esplanade_1k.hdr" },
            { name: "Venice Sunset",   url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/venice_sunset_1k.hdr" },
            { name: "Studio Small",    url: "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_09_1k.hdr" }
        ];
        let currentEnv   = app.currentEnv   = null;      // pmrem result (for scene.environment)
        let currentBg    = app.currentBg    = null;      // shifted equirect (for background sphere)
        let currentRotDeg = app.currentRotDeg = 0;        // rotation slider value

        // =====================
        // State
        // =====================
        const loadedModels = app.loadedModels = []; // { obj, name }
        const allEmbedded  = app.allEmbedded  = []; // embedded images across all models
        const undoStack    = app.undoStack    = [];



        // =====================
        // REBASE
        // =====================      

        const isZUp = () => (axisSel?.value === 'Z'); // если нет селекта — вернёт false

        function computeAutoOffsetHorizontalOnly() {
            const c = computeAutoOffset(); // центр до ребейза (в текущих координатах world)
            if (isZUp()) {
                // Z — вертикаль → не трогаем Z
                c.z = 0;
            } else {
                // Y — вертикаль → не трогаем Y
                c.y = 0;
            }
            return c;
        }



        // ===== Rebase (origin rebasing)
        let worldOffset = new THREE.Vector3(0,0,0); // абсолютный оффсет сцены (куда была унесена модель)

        // применяем/меняем оффсет (ничего в детях не трогаем)

        function setWorldOffset(offset){
            worldOffset.copy(offset);
            world.position.set(-offset.x, -offset.y, -offset.z);
            world.updateMatrixWorld(true);

            if (bgMesh) bgMesh.position.set(0,0,0);
            dirLight.target.position.set(0,0,0);
            dirLight.target.updateMatrixWorld();

            // ВАЖНО: сетку тут не двигаем!

        }

        // посчитать авто-оффсет по центру всех объектов (в абсолютных координатах ДО сдвига)
        function computeAutoOffset() {
            const box = computeSceneBounds();
            if (box.isEmpty()) return new THREE.Vector3(0,0,0);
            return box.getCenter(new THREE.Vector3());
        }

        // удобные конвертеры координат (если нужно где-то показывать «абсолют»)
        function toAbs(v){ return v.clone().add(worldOffset); }   // видовые → абсолютные
        function toView(v){ return v.clone().sub(worldOffset); }  // абсолютные → видовые

        // =====================
        // Layout helper
        // =====================
        function getCssNumber(varName) {
            const v = getComputedStyle(document.body).getPropertyValue(varName).trim();
            const n = parseFloat(v || '0');
            return Number.isFinite(n) ? n : 0;
        }
        // =====================
        // HDRI texture flip Y
        // =====================
        function flipHDRTextureVertically(srcTex) {
            const { data, width, height } = srcTex.image;
            const channels = 4; // RGBA/RGBE
            const flipped = new (data.constructor)(data.length);

            for (let y = 0; y < height; y++) {
                const srcRow = y * width * channels;
                const dstRow = (height - 1 - y) * width * channels;
                flipped.set(data.subarray(srcRow, srcRow + width * channels), dstRow);
            }

            const tex = new THREE.DataTexture(flipped, width, height, srcTex.format, srcTex.type);
            tex.encoding = srcTex.encoding;
            tex.mapping = THREE.EquirectangularReflectionMapping;
            tex.needsUpdate = true;

            return tex;
        }

        function layout() {
            // 1) measure header height and set CSS var
            const appbar = document.querySelector('.appbar');
            const appH = Math.ceil(appbar?.getBoundingClientRect().height || 48);
            document.body.style.setProperty('--appbarH', appH + 'px');

            // 2) compute canvas size (account for side panel)
            const sideW = getCssNumber('--sideW');
            const w = Math.max(1, window.innerWidth - sideW);
            const h = Math.max(1, window.innerHeight - appH);
            renderer.setSize(w, h);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
        }

        window.addEventListener('resize', layout);
        toggleSideBtn.addEventListener('click', () => { document.body.classList.toggle('side-hidden'); layout(); });

   

                // ---------------------------------------
                // DEBUG SHADDOW PANNEL'S LOGIC AUTOUPDATE
                // ---------------------------------------
                    let shadowCamHelper = null;
                    let sunHelper = null;

                    function ensureShadowHelpers() {
                        if (!shadowCamHelper) {
                            shadowCamHelper = new THREE.CameraHelper(dirLight.shadow.camera);
                            shadowCamHelper.visible = false;
                            shadowCamHelper.userData.excludeFromBounds = true; // не учитываем в bbox/fitAll
                            scene.add(shadowCamHelper);
                        }
                        if (!sunHelper) {
                            sunHelper = new THREE.DirectionalLightHelper(dirLight, 1);
                            sunHelper.visible = false;
                            sunHelper.userData.excludeFromBounds = true;
                            scene.add(sunHelper);
                        }
                    }

                    function setShadowDebug(on) {
                        ensureShadowHelpers();
                        shadowCamHelper.visible = !!on;
                        sunHelper.visible = !!on;
                        shadowCamHelper.update();
                        sunHelper.update();
                    }

                    let shadowAutoFrustum = true;
                    let shadowFrustumScale = 1.0;

                    function fitSunShadowToScene(recenterTarget = false, margin = 1.25) {
                        if (!dirLight || !dirLight.shadow || !dirLight.shadow.camera) return;

                        const box = computeSceneBounds();
                        if (box.isEmpty()) return;

                        const center = box.getCenter(new THREE.Vector3());
                        const size   = box.getSize(new THREE.Vector3());
                        const radius = size.length() * 0.5 * margin;
                        const sXY    = Math.max(size.x, size.y) * 0.5 * margin;

                        // По желанию — один раз «поймать» центр
                        if (recenterTarget) {
                            dirLight.target.position.copy(center);
                            dirLight.target.updateMatrixWorld();
                        }

                        const cam = dirLight.shadow.camera; // OrthographicCamera
                        cam.left = -sXY; cam.right = sXY; cam.top = sXY; cam.bottom = -sXY;

                        // near/far вокруг текущей геометрии относительно текущего луча
                        const dist = dirLight.position.distanceTo(dirLight.target.position) || (radius * 1.2);
                        cam.near = Math.max(0.1, dist - radius);
                        cam.far  = dist + radius;

                        cam.updateProjectionMatrix();

                        dirLight.shadow.needsUpdate = true;
                        renderer.shadowMap.needsUpdate = true;

                        shadowCamHelper?.update?.();
                        sunHelper?.update?.();
                    }

                // ----------------------------------------------
                // END OF DEBUG SHADDOW PANNEL'S LOGIC AUTOUPDATE
                // ----------------------------------------------

                
        // === Bounds (без гридов/хелперов) ===
        function expandBoxFiltered(box, obj) {
            if (!obj || !obj.visible) return;

            // исключения: помеченные объекты, стандартные хелперы, фон, источники света и точки
            if (obj.userData?.excludeFromBounds) return;
            if (obj.isGridHelper || obj.isAxesHelper || obj.isPolarGridHelper) return;
            if (obj === bgMesh) return;
            if (obj.isLight || obj.isPoints) return;

            // учитываем только геометрию
            if (obj.isMesh && obj.geometry) {
                obj.updateWorldMatrix(true, false);
                if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
                const bb = obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld);
                if (!bb.isEmpty()) box.union(bb);
            }

            for (const c of obj.children) expandBoxFiltered(box, c);
        }

        function computeSceneBounds(root = world) {
            const box = new THREE.Box3();
            expandBoxFiltered(box, root);
            return box;
        }


        function focusOn(targets, pad = 1.4) {
            // targets may be an object or array of objects
            const box = new THREE.Box3();
            const add = (obj) => obj && box.expandByObject(obj);

            if (Array.isArray(targets)) {
                let any = false;
                targets.forEach(o => { if (o) { add(o); any = true; } });
                if (!any) return;
            } else if (targets) {
                add(targets);
            } else return;

            if (box.isEmpty()) return;

            const size = new THREE.Vector3();
            const center = new THREE.Vector3();
            box.getSize(size);
            box.getCenter(center);
            controls.target.copy(center);

            const fov = THREE.MathUtils.degToRad(camera.fov);
            const canvas = renderer.domElement;
            const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
            const maxDim = Math.max(size.x, size.y, size.z);

            const distForH = (maxDim / (2 * Math.tan(fov / 2)));
            const distForW = (maxDim * aspect / (2 * Math.tan(fov / 2)));
            const dist = Math.max(distForH, distForW) * pad;

            const dirv = new THREE.Vector3(1, 0.6, 1).normalize();
            camera.position.copy(center.clone().add(dirv.multiplyScalar(dist)));
            camera.near = Math.max(dist / 1000, 0.01);
            camera.far = dist * 1000;
            camera.updateProjectionMatrix();
            controls.update();
        }

        function fitAll() {
            const box = computeSceneBounds();
            if (box.isEmpty()) return;
            const size = new THREE.Vector3(), center = new THREE.Vector3();
            box.getSize(size); box.getCenter(center);
            controls.target.copy(center);

            const fov = THREE.MathUtils.degToRad(camera.fov);
            const aspect = renderer.domElement.clientWidth / Math.max(renderer.domElement.clientHeight, 1);
            const max = Math.max(size.x, size.y, size.z);
            const dist = Math.max(max / (2 * Math.tan(fov/2)), (max * aspect) / (2 * Math.tan(fov/2))) * 1.5;

            camera.position.copy(center).add(new THREE.Vector3(1,0.6,1).normalize().multiplyScalar(dist));
            camera.near = Math.max(dist / 1000, 0.01);
            camera.far  = dist * 1000;
            camera.updateProjectionMatrix();
        }

        function computeWorldCenter() {
            const box = computeSceneBounds();
            if (box.isEmpty()) return new THREE.Vector3(0,0,0);
            return box.getCenter(new THREE.Vector3());
        }

        // =====================
        // HDR / IBL handling
        // =====================
        async function loadHDRBase() {
            if (hdrBaseTex) return hdrBaseTex;
            const base = 'https://threejs.org/examples/textures/equirectangular/';
            const file = 'royal_esplanade_1k.hdr';
            hdrBaseTex = await new RGBELoader().setPath(base).loadAsync(file);
            app.hdrBaseTex = hdrBaseTex;
            hdrBaseTex.mapping = THREE.EquirectangularReflectionMapping;
            hdrBaseTex.wrapS = THREE.RepeatWrapping;
            hdrBaseTex.wrapT = THREE.ClampToEdgeWrapping;
            hdrBaseTex.flipY = false;
            hdrBaseTex.flipX = false;
            hdrBaseTex.flipZ = false;
            hdrBaseTex.needsUpdate = true;
            return hdrBaseTex;
        }

        // Функция для вычисления позиции солнца (упрощённая астрономия)
        function sunPosition(date, lat, lon) {
            const rad = Math.PI / 180;
            const day = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);

            const M = (357.5291 + 0.98560028 * day) * rad;
            const L = (280.4665 + 0.98564736 * day) * rad + (1.915 * Math.sin(M) + 0.020 * Math.sin(2*M)) * rad;
            const e = 23.439 * rad;

            const RA = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
            const dec = Math.asin(Math.sin(e) * Math.sin(L));

            const now = date.getUTCHours() + date.getUTCMinutes()/60;
            const lst = (100.46 + 0.985647 * day + lon + 15*now) * rad;
            const H = lst - RA;

            const latRad = lat * rad;
            const alt = Math.asin(Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(H));
            const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(latRad) - Math.sin(latRad) * Math.cos(H));

            return { altitude: alt, azimuth: az };
        }

        // Обновление солнца
        function updateSun() {
            if (!dirLight || !dirLight.visible) return;

            const day   = parseInt(sunDayEl.value, 10) || 1;
            const month = parseInt(sunMonthEl.value, 10) || 6;
            const hour  = parseFloat(sunHourEl.value)   || 12;
            const north = parseFloat(sunNorthEl.value)  || 0;

            const date = new Date();
            date.setUTCMonth(month - 1, day);
            date.setUTCHours(hour, 0, 0, 0);

            const { altitude, azimuth } = sunPosition(date, MOSCOW_LAT, MOSCOW_LON);

            // «Север» — это поворот сцены относительно географического севера.
            // Если крутилка в UI ощущается "наоборот", замените +northRad на -northRad.
            const northRad = THREE.MathUtils.degToRad(north);

            // Единичный вектор направления света (Y — вверх)
            const dir = new THREE.Vector3(
                Math.cos(altitude) * Math.sin(azimuth - northRad), // <— обратите внимание на знак
                Math.sin(altitude),
                Math.cos(altitude) * Math.cos(azimuth - northRad)
            ).normalize();
            app.sun.direction = dir.clone();

            // Центр сцены — куда смотрит солнце (таргет оставляем как есть, если он уже на центре)
            const box = computeSceneBounds();
            if (box.isEmpty()) return;
            const center = box.getCenter(new THREE.Vector3());

            // Если таргет не в центре — один раз подвинем (для согласованности с коробкой теней)
            if (!dirLight.target.position.equals(center)) {
                dirLight.target.position.copy(center);
                dirLight.target.updateMatrixWorld();
            }

            // Дистанция — текущая, чтобы ползунки меняли только направление
            const currDist = dirLight.position.distanceTo(dirLight.target.position) || 50;

            dirLight.position.copy(center).add(dir.multiplyScalar(currDist));
            dirLight.updateMatrixWorld();

            // Подгоняем фрустум (НЕ меняем ни target, ни позицию света)
            fitSunShadowToScene(false); // передаём флажок: не ресентрить таргет
        }


        // shift equirectangular map in U direction by a fraction [0..1)
        function shiftEquirectColumns(srcTex, fracU) {
            const img = srcTex.image;
            const w = img.width, h = img.height;
            const ch = 4; // RGBA / RGBE
            const data = img.data;
            const out = new (data.constructor)(data.length);

            const shift = Math.round(((fracU % 1 + 1) % 1) * w);
            for (let y = 0; y < h; y++) {
                const rowOff = y * w * ch;
                for (let x = 0; x < w; x++) {
                    const sx = (x - shift + w) % w;
                    const si = rowOff + sx * ch;
                    const di = rowOff + x * ch;
                    out[di] = data[si];
                    out[di + 1] = data[si + 1];
                    out[di + 2] = data[si + 2];
                    out[di + 3] = data[si + 3];
                }
            }

            const tex = new THREE.DataTexture(out, w, h, srcTex.format, srcTex.type);
            tex.encoding = srcTex.encoding;
            tex.mapping = THREE.EquirectangularReflectionMapping;
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.needsUpdate = true;
            return tex;
        }

        // build PMREM from rotated HDR and apply to scene.environment
        function buildAndApplyEnvFromRotation(deg) {
            currentRotDeg = deg;
            app.currentRotDeg = currentRotDeg;
            if (!pmremGen) {
                pmremGen = new THREE.PMREMGenerator(renderer);
                app.pmremGen = pmremGen;
            }

            const frac = ((deg % 360) + 360) % 360 / 360;
            if (bgMesh) {
                bgMesh.rotation.y = THREE.MathUtils.degToRad(deg);
            }
            // dispose previous
            if (currentEnv) { currentEnv.dispose?.(); currentEnv = null; app.currentEnv = null; }
            if (currentBg) { currentBg.dispose?.(); currentBg = null; app.currentBg = null; }

            // shift source HDR and generate PMREM
            const shifted = shiftEquirectColumns(hdrBaseTex, frac);
            currentBg = shifted;
            app.currentBg = currentBg;
            const rt = pmremGen.fromEquirectangular(shifted);
            currentEnv = rt.texture;
            app.currentEnv = currentEnv;

            scene.environment = iblChk.checked ? currentEnv : null;
            applyEnvToMaterials(scene.environment, parseFloat(iblIntEl.value));
        }

        async function setEnvironmentEnabled(on) {
            await loadHDRBase();
            if (on) {
                buildAndApplyEnvFromRotation(currentRotDeg || 0);
            } else {
                scene.environment = null;
                applyEnvToMaterials(null, 1.0);
                if (bgMesh) bgMesh.visible = false;
            }
            updateBgVisibility();
            applyGlassControlsToScene();
        }

        function applyEnvToMaterials(env, intensity) {
            world.traverse(o => {
                if (!o.isMesh || !o.material) return;
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach(m => {
                    if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
                        m.envMap = env;
                        m.envMapIntensity = intensity;
                        m.needsUpdate = true;
                    }
                });
            });
        }

        // helper textures
        let _matcapTex = null;
        let _checkerTex = null;

        function getMatcap() {
            if (_matcapTex) return _matcapTex;
            _matcapTex = texLd.load('https://threejs.org/examples/textures/matcaps/matcap-porcelain-white.jpg');
            return _matcapTex;
        }

        function getChecker() {
            if (_checkerTex) return _checkerTex;
            const S = 256, N = 8;
            const c = document.createElement('canvas'); c.width = c.height = S;
            const g = c.getContext('2d');
            for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
                g.fillStyle = ((x + y) & 1) ? '#bbbbbb' : '#222222';
                g.fillRect(x * S / N, y * S / N, S / N, S / N);
            }
            _checkerTex = new THREE.CanvasTexture(c);
            _checkerTex.wrapS = _checkerTex.wrapT = THREE.RepeatWrapping;
            _checkerTex.anisotropy = renderer.capabilities.getMaxAnisotropy?.() || 1;
            return _checkerTex;
        }

        // =====================
        // Points mode (vertices visualization)
        // =====================
        function createPointsForMesh(mesh) {
            // create Points object that shares mesh.geometry but has its own material
            const pm = new THREE.PointsMaterial({
                size: 3.0,
                sizeAttenuation: false,
                color: 0x111111,
                vertexColors: !!mesh.geometry.getAttribute('color'),
                transparent: true,
                opacity: 0.95
            });

            const points = new THREE.Points(mesh.geometry, pm);
            points.name = mesh.name ? `${mesh.name}_points` : 'points';

            const parent = mesh.parent || world;
            parent.add(points);

            points.position.copy(mesh.position);
            points.quaternion.copy(mesh.quaternion);
            points.scale.copy(mesh.scale);

            mesh.userData._points = points;
            return points;
        }

        function destroyPointsForMesh(mesh) {
            const p = mesh.userData._points;
            if (p && p.parent) {
                p.parent.remove(p);
                p.geometry = null; // do not dispose shared geometry
                p.material.dispose?.();
            }
            delete mesh.userData._points;
        }

        function ensurePointsForMesh(mesh, size = 3, color = 0x00aaff) {
            if (!mesh.isMesh || !mesh.geometry || !mesh.parent) return null;

            if (!mesh.userData._pointsObj) {
                const pm = new THREE.PointsMaterial({ size, sizeAttenuation: false, color, depthTest: true, depthWrite: false });
                const pts = new THREE.Points(mesh.geometry, pm);
                pts.name = (mesh.name || mesh.type) + ' (points)';
                pts.renderOrder = (mesh.renderOrder || 0) + 1;
                pts.visible = false;

                mesh.parent.add(pts);
                pts.position.copy(mesh.position);
                pts.quaternion.copy(mesh.quaternion);
                pts.scale.copy(mesh.scale);

                mesh.userData._pointsObj = pts;
                mesh.userData._pointsMat = pm;
            } else {
                const pm = mesh.userData._pointsMat;
                if (pm) { pm.size = size; pm.color = new THREE.Color(color); pm.needsUpdate = true; }
            }
            return mesh.userData._pointsObj;
        }

        function setPointsMode(enabled, { size = 0.5, color = 0x666666 } = {}) {
            world.traverse(o => {
                if (!o.isMesh) return;
                const pts = ensurePointsForMesh(o, size, color);
                if (!pts) return;
                o.visible = !enabled;
                pts.visible = enabled;
            });
        }

        function updatePointSize(newSize) {
            world.traverse(o => {
                if (o.userData?._pointsMat?.isPointsMaterial) {
                    o.userData._pointsMat.size = newSize;
                    o.userData._pointsMat.needsUpdate = true;
                }
            });
        }

        document.getElementById('pointSize').addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            world.traverse(o => {
                if (o.isPoints && o.material?.isPointsMaterial) {
                    o.material.size = val;
                    o.material.needsUpdate = true;
                }
            });
        });



        

        // ================================
        // Edges (wireframe без диагоналей)
        // ================================

        // === Backface debug (2-pass: front white + back red) ===

// Делает MeshBasicMaterial с "угловым" затенением по взгляду.
// power — крутизна кривой, min/max — диапазон яркости,
// invert=true — затемнять к краям, false — подсвечивать к краям (Fresnel-рим).
        function makeViewAngleShadedBasic(params = {}, { power = 2.0, min = 1.4, max = 2.0, invert = false } = {}) {
        const mat = new THREE.MeshBasicMaterial(params);

        mat.onBeforeCompile = (shader) => {
            shader.uniforms.uPower  = { value: power };
            shader.uniforms.uMin    = { value: min };
            shader.uniforms.uMax    = { value: max };
            shader.uniforms.uInvert = { value: invert ? 1 : 0 };

            // Вершинный: пробрасываем нормаль и вектор к камере
            shader.vertexShader =
            /*glsl*/`
            varying vec3 vN;
            varying vec3 vV;
            ` + shader.vertexShader.replace(
                '#include <begin_vertex>',
                /*glsl*/`
                #include <begin_vertex>
                vN = normalize( normalMatrix * normal );
                vec4 mvPos = modelViewMatrix * vec4( transformed, 1.0 );
                vV = -mvPos.xyz;
                `
            );

            // Фрагментный: считаем фактор по углу и умножаем цвет
            shader.fragmentShader =
            /*glsl*/`
            uniform float uPower, uMin, uMax;
            uniform int   uInvert;
            varying vec3  vN;
            varying vec3  vV;
            ` + shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                /*glsl*/`
                float ndv  = clamp( abs( dot( normalize(vN), normalize(vV) ) ), 0.0, 1.0 );
                float fres = pow( 1.0 - ndv, uPower );        // 0 (фронт) → 1 (скользящий взгляд)
                float t    = (uInvert == 1) ? (1.0 - fres) : fres;
                float fac  = mix( uMin, uMax, t );
                gl_FragColor.rgb *= fac;
                #include <dithering_fragment>
                `
            );
        };

        mat.needsUpdate = true;
        return mat;
        }

        function ensureBackfaceOverlay(mesh, origMat) {
        if (!mesh.isMesh || !mesh.geometry) return;
        if (mesh.userData._isBackfaceOverlay) return;
        if (!origMat) origMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;

        if (!mesh.userData._origMaterial) mesh.userData._origMaterial = mesh.material;

        // Общие параметры (уважаем альфу исходника)
        const baseParams = {
            transparent: !!(origMat.transparent || origMat.alphaMap),
            opacity: origMat.opacity ?? 1,
            alphaMap: origMat.alphaMap || null,
            alphaTest: (origMat.alphaMap ? (origMat.alphaTest ?? 0.5) : (origMat.alphaTest ?? 0.0)),
            depthWrite: true,
            depthTest: true
        };

        // FRONT: белый + угловое затенение (рим-подсветка к краям)
        if (!mesh.userData._bfFront) {
            const front = makeViewAngleShadedBasic(
            { ...baseParams, side: THREE.FrontSide, color: 0xffffff },
            { power: 1.2, min: 0.55, max: 1.2, invert: true} // ярче на гранях
            );
            if (front.alphaMap) front.alphaMap.colorSpace = THREE.LinearSRGBColorSpace;
            mesh.userData._bfFront = front;
        }

        // BACK: красный + тоже угловое (можно чуть сильнее)
        if (!mesh.userData._bfBack) {
            const back = makeViewAngleShadedBasic(
            { ...baseParams, side: THREE.BackSide, color: 0xff3333 },
            { power: 1.2, min: 0.55, max: 1.0, invert: false }
            );
            if (back.alphaMap) back.alphaMap.colorSpace = THREE.LinearSRGBColorSpace;
            mesh.userData._bfBack = back;
        }

        // применяем
        mesh.material = mesh.userData._bfFront;

        if (!mesh.userData._bfChild) {
            const child = new THREE.Mesh(mesh.geometry, mesh.userData._bfBack);
            child.renderOrder = (mesh.renderOrder || 0);
            child.userData.excludeFromBounds = true;
            child.userData._isBackfaceOverlay = true;
            mesh.add(child);
            mesh.userData._bfChild = child;
        } else {
            mesh.userData._bfChild.visible = true;
        }
        }

        function removeBackfaceOverlay(mesh) {
        if (!mesh.isMesh) return;
        if (mesh.userData._isBackfaceOverlay) return; // служебный — пропускаем
        // вернуть оригинальный материал
        if (mesh.userData._origMaterial) {
            mesh.material = mesh.userData._origMaterial;
        }
        // убрать/спрятать ребёнка
        if (mesh.userData._bfChild) {
            if (mesh.userData._bfChild.parent) mesh.userData._bfChild.parent.remove(mesh.userData._bfChild);
            mesh.userData._bfChild = null;
        }
        // кэшированные материалы оставим (переиспользуем при повторном включении)
        }

        function setBackfaceMode(on) {
        // Сначала собираем список целевых мешей (не служебных), чтобы
        // не модифицировать дерево прямо во время обхода
        const targets = [];
        world.traverse(o => {
            if (o.isMesh && !o.userData?._isBackfaceOverlay) targets.push(o);
        });

        if (on) {
            targets.forEach(m => ensureBackfaceOverlay(m, Array.isArray(m.material) ? m.material[0] : m.material));
        } else {
            targets.forEach(removeBackfaceOverlay);
        }
        }





        function ensureEdgesForMesh(mesh, { angle=2, color=0x000000, opacity=0.9 } = {}) {
            if (!mesh.isMesh || !mesh.geometry || !mesh.parent) return null;

            if (!mesh.userData._edgesObj) {
                const g   = new THREE.EdgesGeometry(mesh.geometry, angle);
                const mat = new THREE.LineBasicMaterial({
                color, transparent: opacity < 1, opacity,
                depthTest: true, depthWrite: false
                });
                const lines = new THREE.LineSegments(g, mat);
                lines.name = (mesh.name || mesh.type) + ' (edges)';
                lines.renderOrder = (mesh.renderOrder || 0) + 1;
                lines.visible = false;

                mesh.add(lines); // дочерний — наследует трансформы
                mesh.userData._edgesObj   = lines;
                mesh.userData._edgesMat   = mat;
                mesh.userData._edgesAngle = angle;
            } else {
                const mat = mesh.userData._edgesMat;
                if (mat) {
                mat.color.set(color);
                mat.opacity = opacity;
                mat.transparent = opacity < 1;
                mat.needsUpdate = true;
                }
                if (mesh.userData._edgesAngle !== angle) {
                mesh.userData._edgesObj.geometry.dispose?.();
                mesh.userData._edgesObj.geometry = new THREE.EdgesGeometry(mesh.geometry, angle);
                mesh.userData._edgesAngle = angle;
                }
            }
            return mesh.userData._edgesObj;
        }

        function setEdgesMode(enabled, {
            angle = 15,
            color = 0x000000,
            opacity = 0.3,
            overlay = false   // overlay=true — линии поверх заливки; false — «только линии»
            } = {}) {
            world.traverse(o => {
                if (!o.isMesh) return;

                // гарантируем объект линий
                const lines = ensureEdgesForMesh(o, { angle, color, opacity, overlay });
                if (!lines) return;

                // линии показываем/прячем
                lines.visible = !!enabled;

                // НЕ ТРОГАЕМ o.visible, иначе скроем и линии (они ребёнок меша)
                o.visible = true;

                // режим «только линии» — прячем заливку через colorWrite=false
                if (enabled && !overlay) {
                setFillVisible(o, /*show=*/false);
                } else {
                setFillVisible(o, /*show=*/true);
                }
            });
            }

        function setFillVisible(mesh, show) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach(m => {
            if (!m) return;
            m.userData ??= {};
            if (!show) {
            if (m.userData._savedColorWrite === undefined) {
                m.userData._savedColorWrite = (m.colorWrite ?? true);
            }
            m.colorWrite = false;      // не рисуем цвет
            m.transparent = true;      // на всякий случай
            } else {
            if (m.userData._savedColorWrite !== undefined) {
                m.colorWrite = m.userData._savedColorWrite;
                delete m.userData._savedColorWrite;
            } else {
                m.colorWrite = true;
            }
            }
            m.needsUpdate = true;
        });
        }


        // === Beauty wire helpers ===
const BEAUTY_WIRE_ANGLE_DEG = 25;   // угол между нормалями, > исключит мягкие рёбра/диагонали
const BEAUTY_WIRE_COLOR     = 0x111111;
const BEAUTY_WIRE_OPACITY   = 0.9;

function ensureBeautyWire(mesh, angleDeg = BEAUTY_WIRE_ANGLE_DEG) {
    if (!mesh.isMesh || !mesh.geometry) return null;

    // базовая подложка — нейтральный matcap, слегка "утопим" полигоны, чтоб не мерцали с линиями
    if (!mesh.userData._origMaterial) mesh.userData._origMaterial = mesh.material;

    if (!mesh.userData._beautyBase) {
        const base = new THREE.MeshMatcapMaterial({
            color: 0xffffff,
            matcap: getMatcap(), // у тебя уже есть getMatcap()
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
        });
        mesh.userData._beautyBase = base;
    }

    // линии рёбер
    let line = mesh.userData._beautyWire;
    if (!line) {
        const edges = new THREE.EdgesGeometry(mesh.geometry, angleDeg);
        const mat   = new THREE.LineBasicMaterial({ color: BEAUTY_WIRE_COLOR, transparent: true, opacity: BEAUTY_WIRE_OPACITY });
        line = new THREE.LineSegments(edges, mat);
        line.name = (mesh.name || mesh.type) + ' (beautywire)';
        line.renderOrder = (mesh.renderOrder || 0) + 1;
        line.userData.excludeFromBounds = true; // не влияeт на fit/shadows
        mesh.add(line);
        mesh.userData._beautyWire = line;
        line.userData._angle = angleDeg;
    } else if (line.userData._angle !== angleDeg) {
        // обновим геометрию при смене угла
        line.geometry?.dispose?.();
        line.geometry = new THREE.EdgesGeometry(mesh.geometry, angleDeg);
        line.userData._angle = angleDeg;
    }

    // применить базовый материал подложки
    mesh.material = mesh.userData._beautyBase;
    line.visible = true;
    return line;
}

function clearBeautyWire(mesh) {
    if (!mesh.isMesh) return;
    // вернуть исходный материал
    if (mesh.userData._origMaterial) {
        mesh.material = mesh.userData._origMaterial;
    }
    // скрыть (или удалить) линии
    if (mesh.userData._beautyWire) {
        mesh.userData._beautyWire.visible = false; // мягко: прячем
        // если хочется удалять:
        // mesh.remove(mesh.userData._beautyWire);
        // mesh.userData._beautyWire.geometry?.dispose?.();
        // mesh.userData._beautyWire.material?.dispose?.();
        // delete mesh.userData._beautyWire;
    }
    // подложку можно оставить кешированной
}
        // =====================
        // Shading modes
        // =====================

        function makeVariantFrom(orig, mode) {
            // Общие параметры, включая поддержку альфа
            const common = {
                
                side: THREE.FrontSide,
                transparent: orig.transparent || !!orig.alphaMap,
                alphaTest: 0.3,
                // depthWrite: false,
                opacity: orig.opacity ?? 1,
                alphaMap: orig.alphaMap || null
            };

            const color = (orig.color && orig.color.isColor)
                ? orig.color.clone()
                : new THREE.Color(0xffffff);

            const map = orig.map || null;

            switch (mode) {
                case 'lambert':
                    return new THREE.MeshLambertMaterial({ ...common, color, map });

                case 'phong':
                    return new THREE.MeshPhongMaterial({
                        ...common,
                        color,
                        map,
                        shininess: 50,
                        specular: new THREE.Color(0x111111)
                    });

                case 'toon':
                    return new THREE.MeshToonMaterial({ ...common, color, map });

                case 'normal':
                    // у NormalMaterial нет alphaMap, но можно сохранить прозрачность
                    return new THREE.MeshNormalMaterial({
                        side: common.side,
                        transparent: common.transparent,
                        opacity: common.opacity,
                        flatShading: false
                    });

                case 'basic':
                    return new THREE.MeshBasicMaterial({
                        ...common,
                        color: map ? 0xffffff : color,
                        map
                    });

                case 'wire':
                    return new THREE.MeshBasicMaterial({
                        ...common,
                        color: 0x666666,
                        wireframe: true,
                        transparent: true,
                        opacity: 0.3,
                    });

                

                case 'matcap':
                    return new THREE.MeshMatcapMaterial({
                        ...common,
                        color: 0xffffff,
                        matcap: getMatcap()
                    });

                case 'xray':
                    return new THREE.MeshBasicMaterial({
                        ...common,
                        color: 0x8844ff,
                        transparent: true,
                        opacity: 0.5,
                        depthWrite: false
                    });

                case 'uv':
                    return new THREE.MeshBasicMaterial({
                        ...common,
                        color: 0xffffff,
                        map: getChecker()
                    });

                case 'depth':
                    return new THREE.MeshDepthMaterial({
                        depthPacking: THREE.RGBADepthPacking
                        // alphaMap тут не поддерживается
                    });

                case 'vcol':
                    return new THREE.MeshBasicMaterial({
                        ...common,
                        vertexColors: true
                    });

                case 'roughOnly': {
                    const tex = orig.roughnessMap || null;
                    if (tex) return new THREE.MeshBasicMaterial({ ...common, color: 0xffffff, map: tex });
                    const v = Math.max(0, Math.min(1, Number(orig.roughness ?? 0.5)));
                    const c = new THREE.Color().setScalar(v);
                    return new THREE.MeshBasicMaterial({ ...common, color: c });
                }

                case 'metalOnly': {
                    const tex = orig.metalnessMap || null;
                    if (tex) return new THREE.MeshBasicMaterial({ ...common, color: 0xffffff, map: tex });
                    const v = Math.max(0, Math.min(1, Number(orig.metalness ?? 0.0)));
                    const c = new THREE.Color().setScalar(v);
                    return new THREE.MeshBasicMaterial({ ...common, color: c });
                }

                default:
                    return orig; // режим PBR оставляем без изменений


            }
        }

        function applyShading(mode) {
            currentShadingMode = mode;

            // выключаем точки, если были
            if (mode !== 'points') setPointsMode(false);

            // backface — отдельный режим (двухпроходный), его не делаем через makeVariantFrom
            if (mode === 'backface') {
                setPointsMode(false);
                setBackfaceMode(true);
                renderMaterialsPanel();
                return;
            } else {
                // выходим из backface при любом другом режиме
                setBackfaceMode(false);
            }

            if (mode === 'points') {
                setPointsMode(true, { size: 3, color: 0x00aaff });
                return;
            } else {
                setPointsMode(false);
            }
                if (mode === 'beautywire') {
                    // включаем beautywire у всех мешей
                    world.traverse(o => {
                        if (o.userData?.isCollision) return; // не переписывать материал коллизий
                        if (!o.isMesh) return;
                        ensureBeautyWire(o, BEAUTY_WIRE_ANGLE_DEG);
                    });
                    renderMaterialsPanel();
                    return;
                } else {
                    // выходим из beautywire, если он был включён
                    world.traverse(o => { if (o.isMesh) clearBeautyWire(o); });
                }
            world.traverse(obj => {
                if (obj.userData?.isCollision) return; // не переписывать материал коллизий
                if (!obj.isMesh || !obj.material) return;
                if (!obj.userData._origMaterial) obj.userData._origMaterial = obj.material;
                const origArray = Array.isArray(obj.userData._origMaterial) ? obj.userData._origMaterial : [obj.userData._origMaterial];
                if (mode === 'pbr') {
                    obj.material = obj.userData._origMaterial;
                } else {
                    const variants = origArray.map(m => makeVariantFrom(m, mode));
                    obj.material = variants.length === 1 ? variants[0] : variants;
                }
            });

            if (mode === 'pbr') {
                applyEnvToMaterials(scene.environment, parseFloat(iblIntEl.value));
                applyGlassControlsToScene();
            }
            renderMaterialsPanel();
        }

        shadingSel.addEventListener('change', () => applyShading(shadingSel.value));

        // =====================
        // Objects visibility
        // =====================


        function handleEyeToggle(el) {
            const uuid = el.dataset.uuid;
            const matIndexAttr = el.dataset.matIndex;
            const matIndex = matIndexAttr !== undefined ? Number(matIndexAttr) : null;
            if (uuid) {
                toggleObjectVisibility(uuid, Number.isNaN(matIndex) ? null : matIndex);
                return;
            }
            const id = el.dataset.target;
            toggleVisibilityById(id, el);
        }

        function setEyeIcon(el, visible) {
            if (!el) return;
            const iconOn = el.dataset.iconOn || '👁';
            const iconOff = el.dataset.iconOff || '🚫';
            el.textContent = visible ? iconOn : iconOff;
        }

        function updateEyeButtonsForTarget(target, visible) {
            if (!outEl) return;
            outEl.querySelectorAll(`.eye[data-target="${target}"]`).forEach(btn => setEyeIcon(btn, visible));
        }

        function setMeshAndMaterialsVisibility(target, visible) {
            const materials = Array.isArray(target.material) ? target.material : [target.material];
            materials.forEach(mat => { if (mat) mat.visible = visible; });
            target.visible = visible;
        }

        function updateMeshVisibilityFromMaterials(target) {
            const materials = Array.isArray(target.material) ? target.material : [target.material];
            const anyVisible = materials.some(mat => mat ? mat.visible !== false : false);
            target.visible = anyVisible;
        }

        function toggleObjectVisibility(uuid, matIndex = null) {
            const target = world.getObjectByProperty('uuid', uuid);
            if (!target) return;

            if (matIndex !== null && Array.isArray(target.material)) {
                const materials = target.material;
                const mat = materials[matIndex];
                if (!mat) return;
                const nextVisible = !(mat.visible !== false);
                mat.visible = nextVisible;
                updateMeshVisibilityFromMaterials(target);
                syncEyeIconsForObject(uuid, nextVisible, matIndex);
                return;
            }

            const nextVisible = !target.visible;
            setMeshAndMaterialsVisibility(target, nextVisible);
            syncEyeIconsForObject(uuid, nextVisible);
        }

        function syncEyeIconsForObject(uuid, visible, matIndex = null) {
            if (!outEl) return;
            const baseSelector = `.eye[data-uuid="${uuid}"]`;
            if (matIndex !== null) {
                outEl.querySelectorAll(`${baseSelector}[data-mat-index="${matIndex}"]`).forEach(icon => {
                    setEyeIcon(icon, visible);
                });
                const mesh = world.getObjectByProperty('uuid', uuid);
                if (mesh) {
                    const meshVisible = mesh.visible !== false;
                    outEl.querySelectorAll(`${baseSelector}:not([data-mat-index])`).forEach(icon => {
                        setEyeIcon(icon, meshVisible);
                    });
                }
                return;
            }
            outEl.querySelectorAll(baseSelector).forEach(icon => {
                setEyeIcon(icon, visible);
            });
        }

        function toggleVisibilityById(id, el) {
        // Группа: id формата "group|<zipName>"
            if (id.startsWith('group|')) {
                const groupName = id.slice(6);
                const items = loadedModels.filter(m => m.group === groupName);
                if (!items.length) return;

                // если в группе есть что-то видимое — скрываем всё; иначе показываем всё
                const anyVisible = items.some(m => m.obj.visible !== false);
                const newVisible = !anyVisible;
                items.forEach(m => {
                    if (!m?.obj) return;
                    setMeshAndMaterialsVisibility(m.obj, newVisible);
                    syncEyeIconsForObject(m.obj.uuid, newVisible);
                });
                updateEyeButtonsForTarget(id, newVisible);
                return;
            }

            if (id.startsWith('zipcoll|')) {
                const groupName = id.slice(8);
                const items = loadedModels.filter(m => m.group === groupName);
                if (!items.length) { updateEyeButtonsForTarget(id, true); return; }

                const allColl = [];
                const perFileIds = new Map();
                items.forEach(m => {
                    if (!m?.obj) return;
                    const perId = `colgrp|${m.obj.uuid}`;
                    const list = [];
                    m.obj.traverse(o => {
                        if (o.isMesh && o.userData?.isCollision) {
                            allColl.push(o);
                            list.push(o);
                        }
                    });
                    if (list.length) perFileIds.set(perId, list);
                });

                if (!allColl.length) { updateEyeButtonsForTarget(id, true); return; }

                const anyVisible = allColl.some(o => o.visible !== false);
                const newVis = !anyVisible;
                allColl.forEach(o => {
                    setMeshAndMaterialsVisibility(o, newVis);
                    syncEyeIconsForObject(o.uuid, newVis);
                });
                perFileIds.forEach((_, perId) => updateEyeButtonsForTarget(perId, newVis));
                updateEyeButtonsForTarget(id, newVis);
                return;
            }

            // Группа коллизий внутри конкретного FBX
            if (id.startsWith('colgrp|')) {
                const fileUuid = id.slice(7);
                let root = null;
                world.traverse(o => { if (!root && o.uuid === fileUuid) root = o; });
                if (!root) return;
                const coll = [];
                root.traverse(o => { if (o.isMesh && o.userData?.isCollision) coll.push(o); });
                const anyVisible = coll.some(o => o.visible !== false);
                const newVis = !anyVisible;
                coll.forEach(o => {
                    setMeshAndMaterialsVisibility(o, newVis);
                    syncEyeIconsForObject(o.uuid, newVis);
                });
                updateEyeButtonsForTarget(id, newVis);

                const hostModel = loadedModels.find(m => m.obj?.uuid === fileUuid);
                if (hostModel?.group) {
                    const groupName = hostModel.group;
                    let groupHasAny = false;
                    let groupHasVisible = false;
                    loadedModels.forEach(m => {
                        if (m.group !== groupName || !m.obj) return;
                        m.obj.traverse(o => {
                            if (!o.isMesh || !o.userData?.isCollision) return;
                            groupHasAny = true;
                            if (o.visible !== false) groupHasVisible = true;
                        });
                    });
                    if (groupHasAny) updateEyeButtonsForTarget(`zipcoll|${groupName}`, groupHasVisible);
                }
                return;
            }

            // Обычный объект: ищем по userData._panelId
            let target = null;
            world.traverse(o => { if ((o.userData?._panelId) === id) target = o; });
            if (!target) return;

            if (target.userData?._panelKind === 'file-root') {
                const renderables = [];
                target.traverse(o => {
                    if (o === target) return;
                    if (o.userData?.isCollision) return;
                    if (o.isMesh || o.isLine || o.isPoints) renderables.push(o);
                });
                if (!renderables.length) {
                    setEyeIcon(el, true);
                    return;
                }
                const anyVisible = renderables.some(o => o.visible !== false);
                const newVisible = !anyVisible;
                renderables.forEach(o => {
                    setMeshAndMaterialsVisibility(o, newVisible);
                    syncEyeIconsForObject(o.uuid, newVisible);
                });
                setEyeIcon(el, newVisible);
                return;
            }

            const nextVisible = !target.visible;
            setMeshAndMaterialsVisibility(target, nextVisible);
            syncEyeIconsForObject(target.uuid, nextVisible);
            setEyeIcon(el, nextVisible);
        }


        // =====================
        // Background sphere helpers
        // =====================
        function ensureBgMesh() {
            if (bgMesh) return bgMesh;
            const geo = new THREE.SphereGeometry(100000, 64, 32);
            const mat = new THREE.MeshBasicMaterial({
                map: null, side: THREE.BackSide, depthWrite: false, toneMapped: false,
                transparent: true, opacity: parseFloat(bgAlphaEl.value || '1')
            });
            bgMesh = new THREE.Mesh(geo, mat);
            app.bgMesh = bgMesh;
            bgMesh.userData.excludeFromBounds = true;   // ⬅️ добавь
            scene.add(camera);      // гарантируем, что камера в сцене
            camera.add(bgMesh);     // фон “следует” за камерой
            bgMesh.position.set(0,0,0);
            return bgMesh;
        }

        function updateBgVisibility() {
            if (!bgMesh) return;
            bgMesh.visible = !!iblChk.checked;
            bgMesh.material.opacity = parseFloat(bgAlphaEl.value || '1');
            bgMesh.material.transparent = bgMesh.material.opacity < 0.999;
            bgMesh.material.needsUpdate = true;
        }

        // Привязываем обработчики ghliodon
        [sunHourEl, sunDayEl, sunMonthEl, sunNorthEl].forEach(el =>
            el.addEventListener('input', updateSun)
        );
        updateSun();


        iblChk.addEventListener('change', () => setEnvironmentEnabled(iblChk.checked));
        iblIntEl.addEventListener('input', () => { if (iblChk.checked) applyEnvToMaterials(scene.environment, parseFloat(iblIntEl.value)); });
        iblRotEl.addEventListener('input', async () => { if (!iblChk.checked) return; await loadHDRBase(); buildAndApplyEnvFromRotation(parseFloat(iblRotEl.value) || 0); });
        hdriPresetSel.addEventListener('change', async (e) => {
            const idx = parseInt(e.target.value, 10);
            if (isNaN(idx)) return;
            const entry = HDRI_LIBRARY[idx];
            if (!entry) return;

            hdrBaseTex = await new RGBELoader().loadAsync(entry.url);
            app.hdrBaseTex = hdrBaseTex;
            hdrBaseTex = flipHDRTextureVertically(hdrBaseTex);
            app.hdrBaseTex = hdrBaseTex;
            hdrBaseTex.mapping = THREE.EquirectangularReflectionMapping;
            hdrBaseTex.wrapS = THREE.RepeatWrapping;
            hdrBaseTex.wrapT = THREE.ClampToEdgeWrapping;
            
            hdrBaseTex.needsUpdate = true;

            buildAndApplyEnvFromRotation(parseFloat(iblRotEl.value) || 0);
            ensureBgMesh();
            bgMesh.material.map = currentBg;
            bgMesh.material.needsUpdate = true;
        });
        // =====================
        // Axis toggle
        // =====================
        function setAxisUp(up = 'Y') {
            if (up === 'Z') {
                camera.up.set(0, 0, 1);
                world.rotation.set(Math.PI / 2, 0, 0);
            } else {
                camera.up.set(0, 1, 0);
                world.rotation.set(0, 0, 0);
            }
            controls.update();
            fitAll();
            fitSunShadowToScene()
        }

        axisSel.addEventListener('change', () => setAxisUp(axisSel.value));
        setAxisUp('Y');

        // =====================
        // Utilities
        // =====================



        function toggleGeoTab(hostDetailsEl, meta){
        // если вкладка уже открыта в этом FBX → закрыть
        const existing = hostDetailsEl.querySelector('.geo-tab');
        if (existing) { existing.remove(); return; }

        // красивый JSON (если парсится)
        let pretty = '';
        try {
            const obj = meta.parsed ?? JSON.parse(meta.text);
            pretty = JSON.stringify(obj, null, 2);
        } catch {
            pretty = meta.text || '';
        }

        const title = meta.entryName || 'geo.json';

        const tab = document.createElement('div');
        tab.className = 'geo-tab';
        tab.innerHTML = `
            <div class="head">
            <div><b>${title}</b>${meta.featureCount!=null ? ` <span class="tag">features: ${meta.featureCount}</span>` : ''}</div>
            <div class="row">
                <a class="btn" href="${meta.url}" download="${title}">Скачать</a>
                <button class="btn geo-close" title="Закрыть">×</button>
            </div>
            </div>
            <pre></pre>
        `;
        tab.querySelector('pre').textContent = pretty;

        // вставим вкладку внутрь <details id="${modelId}">
        hostDetailsEl.appendChild(tab);

        // закрыть крестиком
        tab.querySelector('.geo-close').addEventListener('click', () => tab.remove());
        }


        function disableShadowsOnImportedLights(root){
            let cnt = 0;
            root.traverse(o => {
                if (!o || !o.isLight) return;
                // castShadow есть у Directional/Spot/Point; проверяем безопасно
                if ('castShadow' in o && o.castShadow) {
                    o.castShadow = false;
                    cnt++;
                }
            });
            if (cnt && typeof logBind === 'function') {
                logBind(`Lights: отключены тени у ${cnt} импортированных источников`, 'ok');
            }
        }


        const AXIS_VECTORS = {
            X: new THREE.Vector3(1, 0, 0),
            Y: new THREE.Vector3(0, 1, 0),
            Z: new THREE.Vector3(0, 0, 1)
        };

        function vectorFromPart(part) {
            if (!part || !part.axis) return null;
            const base = AXIS_VECTORS[part.axis];
            if (!base) return null;
            return base.clone().multiplyScalar(part.sign >= 0 ? 1 : -1);
        }

        function readFBXOrientationFromBuffer(arrayBuffer) {
            if (!arrayBuffer) return null;
            try {
                const view = new Uint8Array(arrayBuffer);
                const encoder = new TextEncoder();
                const cache = new Map();
                const getBytes = (prop) => {
                    if (!cache.has(prop)) cache.set(prop, encoder.encode(prop));
                    return cache.get(prop);
                };

                const readIntProperty = (prop) => {
                    const bytes = getBytes(prop);
                    const end = view.length - bytes.length;
                    let base = -1;
                    outer: for (let i = 0; i <= end; i++) {
                        for (let j = 0; j < bytes.length; j++) {
                            if (view[i + j] !== bytes[j]) continue outer;
                        }
                        base = i + bytes.length;
                        break;
                    }
                    if (base === -1) return null;

                    let pos = base;
                    const dv = new DataView(arrayBuffer);

                    // пропускаем возможные разделители и служебные байты (пробелы/табуляция/переводы строк)
                    while (pos < view.length && view[pos] <= 0x20) pos++;

                    const nextString = () => {
                        if (pos >= view.length || view[pos] !== 0x53) return false; // 'S'
                        const len = dv.getUint32(pos + 1, true);
                        pos += 5 + len;
                        return true;
                    };

                    for (let i = 0; i < 4; i++) {
                        if (!nextString()) break;
                    }

                    if (pos >= view.length) return null;
                    const typeCode = view[pos];
                    pos += 1;

                    switch (typeCode) {
                        case 0x49: return dv.getInt32(pos, true); // 'I'
                        case 0x4C: return Number(dv.getBigInt64(pos, true)); // 'L'
                        case 0x44: return dv.getFloat64(pos, true); // 'D'
                        case 0x46: return dv.getFloat32(pos, true); // 'F'
                        default: return null;
                    }
                };

                const axisNames = ['X', 'Y', 'Z'];
                const makePart = (index, sign) => {
                    if (index == null) return null;
                    const axis = axisNames[index] ?? `Axis${index}`;
                    const signValue = Number.isFinite(sign) ? Number(sign) : 1;
                    const normalizedSign = signValue >= 0 ? 1 : -1;
                    return { index, axis, sign: normalizedSign, symbol: normalizedSign >= 0 ? '+' : '-' };
                };

                const upAxis = readIntProperty('UpAxis');
                const upSign = readIntProperty('UpAxisSign');
                const frontAxis = readIntProperty('FrontAxis');
                const frontSign = readIntProperty('FrontAxisSign');
                const coordAxis = readIntProperty('CoordAxis');
                const coordSign = readIntProperty('CoordAxisSign');

                if ([upAxis, frontAxis, coordAxis].every(v => !Number.isFinite(v))) return null;

                return {
                    up: makePart(upAxis, upSign),
                    front: makePart(frontAxis, frontSign),
                    coord: makePart(coordAxis, coordSign),
                    raw: {
                        UpAxis: upAxis,
                        UpAxisSign: upSign,
                        FrontAxis: frontAxis,
                        FrontAxisSign: frontSign,
                        CoordAxis: coordAxis,
                        CoordAxisSign: coordSign,
                    },
                    source: 'binary'
                };
            } catch {
                return null;
            }
        }

                        function parseOrientationFromNode(root) {
            if (!root) return null;
            const axes = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) };
            const result = { up: null, front: null, coord: null, source: 'geometry' };
            const tempMatrix = new THREE.Matrix4();
            const tempNormal = new THREE.Vector3();
            const tempTangent = new THREE.Vector3();

            root.traverse(node => {
                if (!node?.isMesh) return;
                node.updateWorldMatrix(true, false);
                tempMatrix.copy(node.matrixWorld).extractRotation(tempMatrix);
                tempNormal.set(0, 0, 1).applyMatrix4(tempMatrix).normalize();
                tempTangent.set(1, 0, 0).applyMatrix4(tempMatrix).normalize();
                assignFromVector('up', tempNormal);
                assignFromVector('front', tempTangent);
            });

            if (!result.up && root.up) {
                assignFromVector('up', root.up.clone().normalize());
            }

            if (!result.front && root.children?.length) {
                const firstMesh = root.children.find(c => c?.isMesh);
                if (firstMesh) {
                    firstMesh.updateWorldMatrix(true, false);
                    tempMatrix.copy(firstMesh.matrixWorld).extractRotation(tempMatrix);
                    tempTangent.set(1, 0, 0).applyMatrix4(tempMatrix).normalize();
                    assignFromVector('front', tempTangent);
                }
            }

            if (!result.coord && result.up && result.front) {
                const upVec = toVector(result.up);
                const frontVec = toVector(result.front);
                const rightVec = new THREE.Vector3().crossVectors(upVec, frontVec).normalize();
                assignFromVector('coord', rightVec);
            }

            if (!result.up && !result.front) return null;
            return result;

            function assignFromVector(type, vec) {
                if (!vec || !vec.lengthSq() || result[type]) return;
                let bestAxis = null;
                let bestSign = 1;
                let bestDot = -Infinity;
                Object.entries(axes).forEach(([axisName, axisVec]) => {
                    const dot = vec.dot(axisVec);
                    const absDot = Math.abs(dot);
                    if (absDot > bestDot) {
                        bestDot = absDot;
                        bestAxis = axisName;
                        bestSign = dot >= 0 ? 1 : -1;
                    }
                });
                if (!bestAxis) return;
                result[type] = { axis: bestAxis, symbol: bestSign >= 0 ? '+' : '-', sign: bestSign };
            }

            function toVector(data) {
                if (!data) return new THREE.Vector3();
                const axis = axes[data.axis];
                if (!axis) return new THREE.Vector3();
                return axis.clone().multiplyScalar(data.sign >= 0 ? 1 : -1);
            }
        }

        function describeFBXOrientation(info) {
            if (!info) return 'не найдена';
            const part = (label, data) => {
                if (!data) return `${label}: ?`;
                return `${label}: ${data.symbol}${data.axis}`;
            };
            return [
                part('Up', info.up),
                part('Front', info.front),
                part('Coord', info.coord)
            ].join(' · ');
        }

        function determineOrientationType(info) {
            const TYPE_UNKNOWN = 5;
            const result = { type: TYPE_UNKNOWN, handedness: 'unknown', upAxis: null };
            if (!info) return result;

            const upVec = vectorFromPart(info.up);
            const frontVec = vectorFromPart(info.front);
            const coordVec = vectorFromPart(info.coord);

            if (!upVec || !frontVec || !coordVec) return result;

            const handedness = coordVec.clone().cross(upVec).dot(frontVec) >= 0 ? 'right' : 'left';
            result.handedness = handedness;
            result.upAxis = info.up?.axis || null;

            if (info.up?.axis === 'Y') {
                result.type = handedness === 'right' ? 1 : 4;
            } else if (info.up?.axis === 'Z') {
                result.type = handedness === 'right' ? 2 : 3;
            }

            return result;
        }

        function describeOrientationType(type) {
            switch (type) {
                case 1: return 'Y-up · правосторонняя';
                case 2: return 'Z-up · правосторонняя';
                case 3: return 'Z-up · левосторонняя';
                case 4: return 'Y-up · левосторонняя';
                default: return 'неизвестно';
            }
        }

        function normalizeObjectOrientation(obj, orientationType) {
            if (!obj) return;
            obj.rotation.set(0, 0, 0);
            switch (orientationType) {
                case 1: // Y-up right-handed
                    break;
                case 2: // Z-up right-handed
                    obj.rotateX(-Math.PI / 2);
                    break;
                case 3: // Z-up left-handed
                    obj.rotateX(-Math.PI / 2);
                    obj.rotateY(Math.PI);
                    break;
                case 4: // Y-up left-handed
                    obj.rotateY(Math.PI);
                    break;
                default:
                    obj.rotateX(-Math.PI / 2);
                    break;
            }
        }

        function applyGeoOffsetByOrientation(obj, orientationType, coords = {}) {
            if (!obj) return;
            const { x = 0, y = 0, z = 0 } = coords;
            obj.position.x = x;
            obj.position.y = z;
            obj.position.z = -y;
        }

        function readFBXOrientationFromTree(tree) {
            if (!tree) return null;
            const targetKeys = ['UpAxis', 'UpAxisSign', 'FrontAxis', 'FrontAxisSign', 'CoordAxis', 'CoordAxisSign'];
            const found = {};

            const extractNumeric = (value) => {
                if (value == null) return null;
                if (typeof value === 'number') return value;
                if (typeof value === 'string') {
                    const parsed = parseInt(value, 10);
                    return Number.isFinite(parsed) ? parsed : null;
                }
                if (Array.isArray(value)) {
                    for (const item of value) {
                        const extracted = extractNumeric(item);
                        if (extracted != null) return extracted;
                    }
                    return null;
                }
                if (typeof value === 'object') {
                    if ('value' in value) return extractNumeric(value.value);
                    for (const k of Object.keys(value)) {
                        if (k === 'type' || k === 'name') continue;
                        const extracted = extractNumeric(value[k]);
                        if (extracted != null) return extracted;
                    }
                }
                return null;
            };

            const visit = (node) => {
                if (!node || typeof node !== 'object') return;
                if (Array.isArray(node)) {
                    node.forEach(visit);
                    return;
                }
                for (const key of targetKeys) {
                    if (found[key] == null && key in node) {
                        const value = extractNumeric(node[key]);
                        if (value != null) found[key] = value;
                    }
                }
                for (const value of Object.values(node)) {
                    visit(value);
                }
            };

            visit(tree);

            if (targetKeys.every(key => found[key] == null)) return null;

            const axisNames = ['X', 'Y', 'Z'];
            const makePart = (index, sign) => {
                if (index == null) return null;
                const axis = axisNames[index] ?? `Axis${index}`;
                const signValue = Number.isFinite(sign) ? sign : 1;
                const signSymbol = signValue >= 0 ? '+' : '-';
                return { index, axis, sign: signValue, symbol: signSymbol };
            };

            return {
                up: makePart(found.UpAxis, found.UpAxisSign),
                front: makePart(found.FrontAxis, found.FrontAxisSign),
                coord: makePart(found.CoordAxis, found.CoordAxisSign),
                raw: found,
                source: 'tree'
            };
        }


        // =====================
        // UDIM split (для ВПМ/SM)
        // =====================

        function udimTile(ud) {
            const i = ud - 1001;
            return { tu: i % 10, tv: Math.floor(i / 10) };
        }

        // UDIM для треугольника по средним UV
        function triUDIM(u1,v1, u2,v2, u3,v3){
            const u = (u1+u2+u3)/3, v = (v1+v2+v3)/3;
            const tu = Math.max(0, Math.floor(u));   // не уходим в отрицательные тайлы
            const tv = Math.max(0, Math.floor(v));
            return 1001 + tu + tv*10;
        }

        // Разбить МЕШ на подподузлы по UDIM; вернёт true, если реально был сплит
        function splitMeshByUDIM(mesh){
            const g0 = mesh.geometry;
            if (!g0 || !g0.getAttribute?.('uv')) return false;

            // UCX/коллизии не трогаем
            const nm = (mesh.name || '').toLowerCase();
            if (/^ucx/.test(nm)) return false;

            // Разворачиваем индексы — так проще резать по треугольникам
            const g = g0.index ? g0.toNonIndexed() : g0.clone();
            const pos = g.getAttribute('position').array;
            const uv  = g.getAttribute('uv').array;
            const nrmAttr = g.getAttribute('normal');

            // Разложим треугольники по «ведёркам» UDIM
            const buckets = new Map(); // udim -> {pos:[], uv:[], nrm:[], tu, tv}
            const ensure = (ud) => {
                let b = buckets.get(ud);
                if (!b) {
                    const {tu,tv} = udimTile(ud);
                    b = { pos:[], uv:[], nrm:[], tu, tv };
                    buckets.set(ud, b);
                }
                return b;
            };

            const triCount = pos.length / 9;
            for (let t=0; t<triCount; t++){
                const pBase = t*9, uBase = t*6;
                const ud = triUDIM(
                    uv[uBase], uv[uBase+1],
                    uv[uBase+2], uv[uBase+3],
                    uv[uBase+4], uv[uBase+5]
                );
                const b = ensure(ud);

                // копируем 3 вершины
                for (let k=0;k<9;k++) b.pos.push(pos[pBase+k]);
                // for (let k=0;k<6;k++) b.uv.push(uv[uBase+k]);

                // UV: «сдвигаем» тайл к [0..1] вычитая целую часть
                b.uv.push(
                    uv[uBase]   - b.tu, uv[uBase+1] - b.tv,
                    uv[uBase+2] - b.tu, uv[uBase+3] - b.tv,
                    uv[uBase+4] - b.tu, uv[uBase+5] - b.tv
                );

                if (nrmAttr){
                    const nrm = nrmAttr.array;
                    for (let k=0;k<9;k++) b.nrm.push(nrm[pBase+k]);
                }
            }

            if (buckets.size <= 1) return false; // весь меш в одном UDIM — нечего делить

            // Контейнер на месте старого меша
            const holder = new THREE.Group();
            holder.name = 'UDIM';
            holder.userData.udimHolder = true;

            // переносим трансформ меша на holder; дети — с единичными трансформами
            holder.position.copy(mesh.position);
            holder.quaternion.copy(mesh.quaternion);
            holder.scale.copy(mesh.scale);

            // На каждый UDIM — свой узел с дочерним Mesh
            for (const [ud, b] of buckets){
                const gg = new THREE.BufferGeometry();
                gg.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
                gg.setAttribute('uv',       new THREE.Float32BufferAttribute(b.uv,  2));
                if (b.nrm.length) gg.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
                else gg.computeVertexNormals();

                const tileGroup = new THREE.Group();
                tileGroup.name = `UDIM ${ud}`;
                tileGroup.userData.udim = ud;

                // ✅ делаем уникальный материал для КАЖДОГО UDIM
                let childMat;
                const srcMat = mesh.material;
                if (Array.isArray(srcMat)) {
                    childMat = srcMat.map((m, i) => {
                        const c = m.clone();
                        c.name = (m.name || mesh.name || 'Material') +
                                ` · UDIM ${ud}` +
                                (srcMat.length > 1 ? `_${i+1}` : '');
                        return c;
                    });
                } else {
                    childMat = srcMat.clone();
                    childMat.name = (srcMat.name || mesh.name || 'Material') + ` · UDIM ${ud}`;
                }

                const child = new THREE.Mesh(gg, childMat);
                child.name = `${mesh.name || mesh.type} · UDIM ${ud}`;
                child.castShadow = mesh.castShadow;
                child.receiveShadow = mesh.receiveShadow;
                child.userData.udim = ud;

                tileGroup.add(child);
                holder.add(tileGroup);
            }

            // Подменяем меш на holder у того же родителя (сохраним местоположение в списке детей)
            const parent = mesh.parent;
            const i = parent.children.indexOf(mesh);
            parent.remove(mesh);
            parent.children.splice(i, 0, holder);
            holder.parent = parent;

            // Чистим исходную геометрию, если она нам больше не нужна
            g0.dispose?.();

            return true;
        }

        // Запустить сплит по всему FBX-объекту (только для ВПМ/SM)
        function splitAllMeshesByUDIM_SM(root){
            const list = [];
            root.traverse(o => {
                if (o.isMesh && o.geometry?.getAttribute?.('uv')) list.push(o);
            });
            // важнo: менять дерево после обхода
            list.forEach(m => splitMeshByUDIM(m));
        }

        function getSelectedMaterialLink() {
            if (!matSelect) return null;
            const val = matSelect.value;
            if (val === '' || val == null) return null;

            let map = [];
            try { map = JSON.parse(matSelect.dataset._map || '[]'); } catch {}

            const entry = map.find(e => String(e.idx) === String(val));
            if (!entry) return null;

            const [uuid, idxStr] = String(entry.path).split(':');
            const targetIndex = parseInt(idxStr, 10) || 0;

            let link = null;
            world.traverse(o => {
                if (link || !o.isMesh) return;
                if (o.uuid !== uuid) return;
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                link = { obj: o, index: targetIndex, mat: mats[targetIndex] || null };
            });
            return link;
        }

        // На каждый UDIM свой материал

        function uniquifyUDIMMaterials(root = world) {
            const targets = [];
            root.traverse(o => { if (o.isMesh && o.userData?.udim) targets.push(o); });
            targets.forEach(o => {
                const ud = o.userData.udim;
                if (Array.isArray(o.material)) {
                    o.material = o.material.map((m, i) => {
                        if (m.userData && m.userData._uniqueForUDIM === ud) return m;
                        const c = m.clone();
                        c.name = (m.name || o.name || 'Material') + ` · UDIM ${ud}` + (o.material.length > 1 ? `_${i+1}` : '');
                        (c.userData ||= {})._uniqueForUDIM = ud;
                        return c;
                    });
                    cacheOriginalMaterialFor(o, true);
                } else {
                    const m = o.material;
                    if (!(m.userData && m.userData._uniqueForUDIM === ud)) {
                        const c = m.clone();
                        c.name = (m.name || o.name || 'Material') + ` · UDIM ${ud}`;
                        (c.userData ||= {})._uniqueForUDIM = ud;
                        o.material = c;
                        cacheOriginalMaterialFor(o, true);
                    }
                }
            });
            renderMaterialsPanel();
            rebuildMaterialsDropdown();
        }


        // --- ПОДПИСАТЬ МАТЕРИАЛЫ ПО ИМЕНИ ОБЪЕКТА/UCX ---
        function renameMaterialsByFBXObject(root){
        const RX_DEFAULT = /^_*default(?:_?material)?\s*$/i;  // __DEFAULT / Default / DefaultMaterial / "" и т.п.
        const RX_UCX = /^ucx\b/i;

        const nearestUCX = (o) => {
            for (let p = o; p; p = p.parent){
            if (RX_UCX.test(p.name || '')) return p.name;
            if (p.geometry?.name && RX_UCX.test(p.geometry.name)) return p.geometry.name;
            }
            return null;
        };

        let renamed = 0;
        root.traverse(mesh => {
            if (!mesh.isMesh || !mesh.material) return;

            const ucx = nearestUCX(mesh);
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            let changed = false;
            for (let i = 0; i < mats.length; i++){
            const m = mats[i]; if (!m) continue;

            const isDefault = RX_DEFAULT.test(m.name || '') || !(m.name || '').trim();
            const mustRename = isDefault || !!ucx;               // все UCX получат имя по объекту

            if (!mustRename) continue;

            const base = (ucx || mesh.name || mesh.parent?.name || 'MATERIAL').trim();
            const cloned = m.clone();                            // свой инстанс для этого меша
            cloned.name = mats.length > 1 ? `${base}_${i+1}` : base;

            if (Array.isArray(mesh.material)) mesh.material[i] = cloned;
            else mesh.material = cloned;

            renamed++;
            changed = true;
            }
            if (changed) cacheOriginalMaterialFor(mesh, true);
        });

        if (typeof logBind === 'function') {
            logBind(`UCX rename: переименовано материалов — ${renamed}`, renamed ? 'ok' : 'warn');
        }
        }

        // вернёт созданную/найденную группу "КОЛЛИЗИИ" или null, если UCX не найден
        function normalizeMatBaseName(n){
            if (!n) return '';
            return String(n).split('::').pop().trim(); // убираем префикс "Material::"
        }
        function isDefaultMatName(n){
            const base = normalizeMatBaseName(n);
            return (
                base === '' ||
                /^_*\s*default(?:_material)?\s*$/i.test(base) ||
                /^no\s*material$/i.test(base) ||
                /^lambert\d+$/i.test(base) // частый дефолт у DCC
            );
        }

        // Собираем UCX-ноды в "КОЛЛИЗИИ" и подписываем материалы по ИМЕНИ ОБЪЕКТА.
        // ВАЖНО: каждому UCX-объекту — свой клон материала, чтобы имена не конфликтовали.
        function groupUCXUnderCollisions(root){
            const rx = /^ucx\b/i;

            // найдём все UCX-узлы
            const ucxNodes = [];
            root.traverse(o => {
                const n1 = o?.name || '';
                const n2 = o?.geometry?.name || '';
                if (rx.test(n1) || rx.test(n2)) ucxNodes.push(o);
            });

            // оставим только верхнеуровневые UCX (чтобы не дублировать дочерние)
            const tops = ucxNodes.filter(n => {
                let p = n.parent;
                while (p) {
                const pn = p?.name || '';
                const pg = p?.geometry?.name || '';
                if (rx.test(pn) || rx.test(pg)) return false;
                p = p.parent;
                }
                return true;
            });
            if (!tops.length) return null;

            // создаём/находим группу «КОЛЛИЗИИ»
            let col = root.getObjectByName('КОЛЛИЗИИ');
            if (!col) {
                col = new THREE.Group();
                col.name = 'КОЛЛИЗИИ';
                root.add(col);
            }

            // для каждого UCX-узла: переименуем материалы во всех мешах-потомках и перенесём под группу
            tops.forEach(node => {
                const base = (node.name || node.geometry?.name || 'UCX').trim();

                node.traverse(m => {
                if (!m.isMesh || !m.material) return;
                const mats = Array.isArray(m.material) ? m.material : [m.material];
                for (let i = 0; i < mats.length; i++) {
                    const cloned = mats[i].clone();                 // свой инстанс на меш
                    cloned.name = mats.length > 1 ? `${base}_${i+1}` : base; // имя по объекту
                    if (Array.isArray(m.material)) m.material[i] = cloned;
                    else m.material = cloned;
                }
                });

                if (node.parent !== col) col.attach(node);
            });

            return col;
            }

        function classifyZipKind(zipName) {
            const base = basename(zipName);
            if (/^SM/i.test(base)) return 'SM';
            if (/^\d/.test(base))  return 'NPM';   // «НПМ» в UI
            return null;
        }

        function basename(p) { return (p || '').split(/[\\\/]/).pop(); }
        

        // helper: формируем метаданные GeoJSON (url для скачивания, prettified текст, подсчёт features)
        function makeGeoJsonMeta(zipName, entryName, text){
            let parsed = null, featureCount = null;
            try {
                parsed = JSON.parse(text);
                if (parsed?.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
                    featureCount = parsed.features.length;
                }
            } catch(_) {}

            const blob = new Blob([text], { type: 'application/geo+json' });
            const url  = URL.createObjectURL(blob);

            return {
                zipName,
                entryName: basename(entryName),
                text,           // исходный JSON-текст
                parsed,         // распарсенный объект (если получилось)
                featureCount,   // число features (если это FeatureCollection)
                url             // blob-url для кнопки "Скачать"
            };
        }

        function parseGeoNumber(value, fallback = null) {
            if (value == null) return fallback;
            if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
            if (typeof value === 'string') {
                const cleaned = value.trim().replace(/\s+/g, '').replace(',', '.');
                const num = parseFloat(cleaned);
                if (Number.isFinite(num)) return num;
            }
            return fallback;
        }

        function clamp01(v) {
            const num = Number.isFinite(v) ? v : 0;
            return Math.min(1, Math.max(0, num));
        }

        function normalizeGlassKey(name) {
            if (!name) return null;
            return String(name).trim().toLowerCase();
        }

        function ensureGeoGlassIndex(meta) {
            if (!meta) return null;
            if (meta._glassIndex) return meta._glassIndex;
            const index = new Map();
            const parsed = meta.parsed;
            const features = parsed?.type === 'FeatureCollection' && Array.isArray(parsed.features)
                ? parsed.features
                : Array.isArray(parsed?.features) ? parsed.features : [];

            features.forEach(feature => {
                const glasses = feature?.Glasses;
                if (!Array.isArray(glasses)) return;
                glasses.forEach(entry => {
                    if (!entry || typeof entry !== 'object') return;
                    Object.entries(entry).forEach(([matName, params]) => {
                        const key = normalizeGlassKey(matName);
                        if (!key || index.has(key) || !params || typeof params !== 'object') return;

                        const color = params.color_RGB || params.color_rgb || null;
                        let colorData = null;
                        if (color && typeof color === 'object') {
                            const toChan = v => {
                                const val = parseGeoNumber(v);
                                return Number.isFinite(val) ? clamp01(val / 255) : null;
                            };
                            const r = toChan(color.Red ?? color.red ?? color.R ?? color.r);
                            const g = toChan(color.Green ?? color.green ?? color.G ?? color.g);
                            const b = toChan(color.Blue ?? color.blue ?? color.B ?? color.b);
                            if (r != null || g != null || b != null) {
                                colorData = {
                                    r: r ?? 0,
                                    g: g ?? 0,
                                    b: b ?? 0,
                                };
                            }
                        }

                        const transparency = parseGeoNumber(params.transparency);
                        const refraction = parseGeoNumber(params.refraction ?? params.ior ?? params.n);
                        const roughness = parseGeoNumber(params.roughness);
                        const metallicity = parseGeoNumber(params.metallicity ?? params.metalness);

                        const transparencyClamped = transparency != null ? clamp01(transparency) : null;
                        index.set(key, {
                            color: colorData,
                            transparency: transparencyClamped,
                            opacity: transparencyClamped,
                            refraction,
                            roughness: roughness != null ? clamp01(roughness) : null,
                            metalness: metallicity != null ? clamp01(metallicity) : null,
                        });
                    });
                });
            });

            meta._glassIndex = index;
            return index;
        }

        function findGeoGlassParams(meta, nameCandidates) {
            if (!meta) return null;
            const index = ensureGeoGlassIndex(meta);
            if (!index || !index.size) return null;
            for (const candidate of nameCandidates) {
                const key = normalizeGlassKey(candidate);
                if (!key) continue;
                const hit = index.get(key);
                if (hit) return hit;
            }
            return null;
        }
    
        function openGeoModal(meta, title = 'GeoJSON') {
        let geoModal = document.getElementById('geoModal');
        if (!geoModal) {
            geoModal = document.createElement('div');
            geoModal.id = 'geoModal';
            geoModal.className = 'modal';
            geoModal.innerHTML = `
            <div class="sheet">
                <div class="head">
                <div class="row" style="gap:8px; align-items:center">
                    <b id="geoTitle"></b>
                    <span class="muted" id="geoInfo" style="font-size:12px"></span>
                </div>
                <button id="geoClose" class="btn" title="Закрыть">×</button>
                </div>
                <div class="body" style="grid-template-columns: 1fr">
                <div class="side" style="max-height:70vh; overflow:auto">
                    <pre id="geoPre" style="margin:0; white-space:pre; font-size:12px; line-height:1.35; tab-size:2"></pre>
                    <div class="row" style="margin-top:8px">
                    <a id="geoDl" class="btn" download>Скачать GeoJSON</a>
                    </div>
                </div>
                </div>
            </div>
            `;
            document.body.appendChild(geoModal);

            // закрытия
            geoModal.querySelector('#geoClose').addEventListener('click', () => geoModal.classList.remove('show'));
            geoModal.addEventListener('click', (e) => { if (e.target === geoModal) geoModal.classList.remove('show'); });
        }

        const pre   = geoModal.querySelector('#geoPre');
        const h     = geoModal.querySelector('#geoTitle');
        const info  = geoModal.querySelector('#geoInfo');
        const dl    = geoModal.querySelector('#geoDl');

        h.textContent = title;
        info.textContent = meta.entryName ? ` · ${meta.entryName}${Number.isFinite(meta.featureCount) ? ` · features: ${meta.featureCount}` : ''}` : '';
        dl.href = meta.url || '#';
        if (meta.entryName) dl.download = meta.entryName;

        // красивый вывод
        const pretty = meta.parsed ? JSON.stringify(meta.parsed, null, 2) : (meta.text || '');
        pre.textContent = pretty;

        geoModal.classList.add('show');
        }

        function guessKindFromName(name) {
            const n = (name || '').toLowerCase();
            if (/(rough|rgh|_rough|\br_)/.test(n)) return 'roughness';
            if (/gloss/.test(n)) return 'gloss';
            if (/(metal|mtl|\b_m\b)/.test(n)) return 'metalness';
            if (/(normal|_nrm|_nor)\b/.test(n)) return 'normal';
            if (/ao|ambient[_-]?occ/i.test(n)) return 'ao';
            if (/opacity|alpha|transp/i.test(n)) return 'alpha';
            if (/basecolor|albedo|diff(use)?/i.test(n)) return 'base';
            if (/spec(ular)?/i.test(n)) return 'spec';
            return 'other';
        }

        function texInfo(tex) {
            if (!tex) return '<span class="muted">—</span>';
            const human = tex.name || tex.userData?.origName || null;
            let rawSrc = '';
            const img = tex.image;
            if (img) rawSrc = img.currentSrc || img.src || img.url || '';
            const fallback = basename(decodeURIComponent(String(rawSrc || '')).split('?')[0] || '');
            const pretty = human || fallback || '(texture)';
            const cs = tex?.colorSpace === THREE.SRGBColorSpace ? 'srgb' : tex?.colorSpace === THREE.LinearSRGBColorSpace ? 'srgb-linear' : (tex?.colorSpace ?? '—');
            return `${pretty}  ·  ${cs}`;
        }

        function logBind(message, level = 'info') {
            if (!bindLogEl) return;
            const prefix = level === 'warn' ? '⚠️ ' : level === 'ok' ? '✅ ' : '';
            if (bindLogEl.textContent.trim() === '— пока пусто —') { bindLogEl.textContent = ''; }
            bindLogEl.textContent += prefix + message + '\n';
        }

        function logSessionHeader(title) {
            if (!bindLogEl) return;
            const ts = new Date().toLocaleTimeString();
            if (bindLogEl.textContent.trim() !== '— пока пусто —') { bindLogEl.textContent += '\n'; }
            bindLogEl.textContent += `——— ${title} @ ${ts} ———\n`;
        }

        
        // =====================
        // FBX embedded images extraction
        // =====================
        function isBinaryFBX(arrayBuffer) {
            const sig = new Uint8Array(arrayBuffer, 0, 23);
            const magic = 'Kaydara FBX Binary  \0';
            for (let i = 0; i < magic.length; i++) { if (sig[i] !== magic.charCodeAt(i)) return false; }
            return true;
        }

        function sniffImage(u8) {
            let mime = 'application/octet-stream';
            if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) mime = 'image/png';
            else if (u8[0] === 0xFF && u8[1] === 0xD8) mime = 'image/jpeg';
            else if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) mime = 'image/gif';
            else if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45) mime = 'image/webp';
            return { mime };
        }

        async function extractImagesFromFBX(arrayBuffer) {
            return isBinaryFBX(arrayBuffer) ? extractEmbeddedImagesFromFBX_binary(arrayBuffer) : extractEmbeddedImagesFromFBX_ascii(arrayBuffer);
        }

        async function extractEmbeddedImagesFromFBX_ascii(arrayBuffer) {
            const text = new TextDecoder('latin1').decode(new Uint8Array(arrayBuffer));
            const videos = [];
            const rxVideo = /Video::([^,\"\s]+)[^{]*?(?:FileName|RelativeFilename)\s*:\s*\"([^\"]+)\"/gi;
            let mv;
            while ((mv = rxVideo.exec(text))) videos.push({ nameInFbx: mv[1], filePath: mv[2] });

            const out = [];
            const rxContent = /Content\s*:\s*,/g;
            let mc, idx = 0;
            while ((mc = rxContent.exec(text))) {
                const start = mc.index + mc[0].length;
                const chunk = text.slice(start, start + 8_000_000);
                const b64m = chunk.match(/([A-Za-z0-9+\/=\r\n]{800,})/);
                if (!b64m) continue;
                const b64 = b64m[1].replace(/\s+/g, '');
                try {
                    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                    const { mime } = sniffImage(bin);
                    const url = URL.createObjectURL(new Blob([bin], { type: mime }));
                    const vid = videos[idx++] || {};
                    const filePath = vid.filePath || `embedded_${out.length}.${(mime.split('/')[1] || 'img')}`;
                    const short = basename(filePath).toLowerCase();
                    out.push({ short, url, full: filePath, mime, source: 'embedded' });
                } catch (__) { /* ignore decode errors */ }
            }
            return out;
        }

        function extractEmbeddedImagesFromFBX_binary(arrayBuffer) {
            const view = new DataView(arrayBuffer);
            const version = view.getUint32(23, true);
            const is64 = version >= 7500;
            const u8 = new Uint8Array(arrayBuffer);
            const td = new TextDecoder('utf-8');

            const u32 = (o) => view.getUint32(o, true);
            const u64 = (o) => { const low = view.getUint32(o, true), high = view.getUint32(o + 4, true); return high * 0x100000000 + low; };
            const readLen = (o) => is64 ? u64(o) : u32(o);

            function readNode(offset) {
                const endOffset = readLen(offset); offset += is64 ? 8 : 4;
                const numProps = readLen(offset); offset += is64 ? 8 : 4;
                const propsLen = readLen(offset); offset += is64 ? 8 : 4;
                const nameLen = view.getUint8(offset); offset += 1;
                if (endOffset === 0) return { nextOffset: endOffset, nullRecord: true };

                const name = td.decode(u8.subarray(offset, offset + nameLen)); offset += nameLen;
                const props = [];

                for (let i = 0; i < numProps; i++) {
                    const t = String.fromCharCode(view.getUint8(offset)); offset += 1;
                    if (t === 'S' || t === 'R') {
                        const len = u32(offset); offset += 4;
                        const data = u8.subarray(offset, offset + len); offset += len;
                        props.push({ type: t, data });
                    } else if (t === 'Y') { offset += 2; props.push({ type: t }); }
                    else if (t === 'C') { offset += 1; props.push({ type: t }); }
                    else if (t === 'I') { offset += 4; props.push({ type: t }); }
                    else if (t === 'F') { offset += 4; props.push({ type: t }); }
                    else if (t === 'D') { offset += 8; props.push({ type: t }); }
                    else if (t === 'L') { offset += 8; props.push({ type: t }); }
                    else if ('bcdfil'.includes(t)) {
                        const arrayLen = u32(offset); offset += 4;
                        const encoding = u32(offset); offset += 4;
                        const compLen = u32(offset); offset += 4;
                        if (encoding === 0) {
                            const elemSize = (t === 'd' || t === 'D') ? 8 : (t === 'l' || t === 'L' || t === 'i' || t === 'I') ? 4 : (t === 'f' || t === 'F') ? 4 : 1;
                            offset += arrayLen * elemSize;
                        } else {
                            offset += compLen;
                        }
                        props.push({ type: t, array: true });
                    } else {
                        return { name, props, children: [], nextOffset: endOffset };
                    }
                }

                const children = [];
                while (offset < endOffset) {
                    const child = readNode(offset);
                    if (child.nullRecord) { offset = is64 ? offset + 25 : offset + 13; break; }
                    children.push(child);
                    offset = child.nextOffset;
                }
                return { name, props, children, nextOffset: endOffset };
            }

            let offset = 27;
            const top = [];
            while (offset < arrayBuffer.byteLength) {
                const node = readNode(offset);
                if (!node || node.nullRecord) break;
                top.push(node);
                offset = node.nextOffset || (offset + 1);
            }

            const videos = [];
            (function visit(n) { if (!n) return; if (Array.isArray(n)) return n.forEach(visit); if (n.name === 'Video') videos.push(n); if (n.children) n.children.forEach(visit); })(top);

            const out = [];
            for (const vid of videos) {
                let filePath = null, content = null;
                const stack = [...(vid.children || [])];
                while (stack.length) {
                    const c = stack.shift();
                    if (!c) continue;
                    if (c.name === 'FileName' || c.name === 'RelativeFilename') {
                        const p = c.props?.[0];
                        if (p && p.type === 'S') filePath = new TextDecoder('utf-8').decode(p.data).replace(/\0/g, '');
                    }
                    if (c.name === 'Content') {
                        const p = c.props?.[0];
                        if (p && p.type === 'R') content = p.data;
                    }
                    if (c.children) stack.push(...c.children);
                }
                if (content) {
                    const { mime } = sniffImage(content);
                    const url = URL.createObjectURL(new Blob([content], { type: mime }));
                    const short = basename(filePath || `embedded_${out.length}.${(mime.split('/')[1] || 'img')}`).toLowerCase();
                    out.push({ short, url, full: filePath || short, mime, source: 'embedded' });
                }
            }
            return out;
        }

        // =====================
        // Material helpers
        // =====================


        // === COLLISIONS (UCX) =========================================
        const COLLISION_MAT_BASE = new THREE.MeshBasicMaterial({
            color: 0xff3333,
            transparent: true,
            opacity: 0.25,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false
        });

        function isUCXName(s){ return /^ucx/i.test(String(s||'')); }

        function getNearestUCXName(obj){
            for (let p = obj; p; p = p.parent){
                if (isUCXName(p.name)) return p.name;
                if (p.geometry && isUCXName(p.geometry.name)) return p.geometry.name;
            }
            return null;
        }

        /**
         * Помечает UCX-меши, задаёт им красный прозрачный материал (с именем UCX-объекта)
         * и отключает тени у коллизий.
         */
        function markCollisionMeshes(root){
            root.traverse(o => {
                if (!o.isMesh) return;
                const ucxBase = getNearestUCXName(o);
                if (!ucxBase) return;

                o.userData.isCollision = true;
                o.castShadow = false;
                o.receiveShadow = false;

                const nm = ucxBase || o.name || o.geometry?.name || '__COLLISION__';
                const m = COLLISION_MAT_BASE.clone();
                m.name = nm;

                if (Array.isArray(o.material)) {
                    o.material = o.material.map(() => m);
                } else {
                    o.material = m;
                }

                // Чтобы рисовались поверх, но без мерцания
                o.renderOrder = Math.max(o.renderOrder || 0, 999);
                o.visible = false;
                o.userData._origMaterial = o.material;
            });
        }


        function toStandard(m) {
            if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) return m;
            const std = new THREE.MeshStandardMaterial({
                side: THREE.DoubleSide,
                color: m.color?.clone?.() ?? new THREE.Color(0xffffff),
                map: m.map ?? null,
                normalMap: m.normalMap ?? null,
                aoMap: m.aoMap ?? null,
                emissive: m.emissive?.clone?.() ?? new THREE.Color(0x000000),
                emissiveMap: m.emissiveMap ?? null,
                emissiveIntensity: m.emissiveIntensity ?? 1.0,
                transparent: !!m.transparent,
                opacity: m.opacity ?? 1.0,
                metalness: 0.0,
                roughness: Math.max(0.04, 1 - (m.shininess ?? 30) / 100)
            });

            // НЕ ТЕРЯЕМ ИМЯ
            std.name = m.name || std.name;

            if (std.map) std.map.colorSpace = THREE.SRGBColorSpace;
            if (std.emissiveMap) std.emissiveMap.colorSpace = THREE.SRGBColorSpace;
            if (std.normalMap) std.normalMap.colorSpace = THREE.LinearSRGBColorSpace;
            if (std.aoMap) std.aoMap.colorSpace = THREE.LinearSRGBColorSpace;
            if (m.alphaMap) { std.alphaMap = m.alphaMap; std.alphaMap.colorSpace = THREE.LinearSRGBColorSpace; std.alphaTest = 0.5; std.transparent = false; std.depthWrite = true; }
            if (scene.environment) { std.envMap = scene.environment; std.envMapIntensity = parseFloat(iblIntEl.value); }
            return std;
        }

        function copyTextureSettings(src, dst) {
            if (!src || !dst || src === dst) return;
            if (src.wrapS != null) dst.wrapS = src.wrapS;
            if (src.wrapT != null) dst.wrapT = src.wrapT;
            if ('wrapR' in src && 'wrapR' in dst && src.wrapR != null) dst.wrapR = src.wrapR;
            if (src.offset?.isVector2 && dst.offset?.copy) dst.offset.copy(src.offset);
            if (src.repeat?.isVector2 && dst.repeat?.copy) dst.repeat.copy(src.repeat);
            if (src.center?.isVector2 && dst.center?.copy) dst.center.copy(src.center);
            if (typeof src.rotation === 'number') dst.rotation = src.rotation;
            if (typeof src.matrixAutoUpdate === 'boolean') {
                dst.matrixAutoUpdate = src.matrixAutoUpdate;
                if (!dst.matrixAutoUpdate && src.matrix && dst.matrix?.copy) {
                    dst.matrix.copy(src.matrix);
                }
            }
            if (typeof src.flipY === 'boolean') dst.flipY = src.flipY;
            if (typeof src.anisotropy === 'number') dst.anisotropy = src.anisotropy;
            if (typeof src.generateMipmaps === 'boolean') dst.generateMipmaps = src.generateMipmaps;
            if (dst.image && (dst.image.width || dst.image.height || dst.image.data)) {
                dst.needsUpdate = true;
            }
        }

        const GEOM_SUFFIXES = ['mainglass', 'main', 'groundglass', 'groundelglass', 'groundel', 'ground', 'flora'];

        function findGeomSuffix(label) {
            const s = (label || '').toLowerCase();
            for (const g of GEOM_SUFFIXES) {
                const re = new RegExp(`(?:^|[^a-z0-9])${g}(?:[^a-z0-9]|$)`, 'i');
                if (re.test(s)) return g;
            }
            return null;
        }

        // Определяем номер слота из имени материала/объекта.
        // Ищем паттерн вида "..._Main_1" / "..._MainGlass_2" / "..._Ground_3" и пр.
        function detectSlotFromMaterialName(name) {
            if (!name) return null;
            const s = String(name);

            // Явный случай: _<GeomSuffix>_<slot> в конце
            // GEOM_SUFFIXES = ['mainglass','main','groundglass','groundelglass','groundel','ground','flora']
            const rx = new RegExp(`_(?:${GEOM_SUFFIXES.join('|')})_(\\d{1,3})(?!\\d)\\s*$`, 'i');
            const m1 = s.match(rx);
            if (m1) return parseInt(m1[1], 10);

            // Защита: не трогаем имена, заканчивающиеся на "UDIM 1005" и т.п.
            if (/UDIM\s*\d{4}\s*$/i.test(s)) return null;

            // Бэкап: если в самом конце просто "_<число>", берём его (например "M_..._1")
            const m2 = s.match(/_(\d{1,3})\s*$/);
            if (m2) return parseInt(m2[1], 10);

            return null;
        }

        // Используем её и для объекта, и для материала
        function detectSlotFromMatOrObj(obj, mat){
            const byMat = detectSlotFromMaterialName(mat?.name);
            if (byMat != null) return byMat;
            const byObj = detectSlotFromMaterialName(obj?.name);
            if (byObj != null) return byObj;
            return 1; // запасной вариант
        }


        function isGlassGeomSuffix(geomSuffix) { return /^(mainglass|groundglass|groundelglass)$/.test((geomSuffix || '').toLowerCase()); }
        function isGlassByName(name) { return /\b(mainglass|groundglass|groundelglass)\b/.test((name || '').toLowerCase()); }



        
        // ----------------------------------
        // OFFSET FROM GEOJSON UTILS FOR VPNS
        // ----------------------------------


        function centroidXY(coords){
        // рекурсивно берём все [x,y] пары и считаем центр
        let sumX = 0, sumY = 0, n = 0;
        (function walk(a){
            if (!a) return;
            if (Array.isArray(a[0])) { a.forEach(walk); return; }
            // a — точка? [x,y] или [x,y,z]
            if (Array.isArray(a) && a.length >= 2 && Number.isFinite(a[0]) && Number.isFinite(a[1])){
            sumX += +a[0]; sumY += +a[1]; n++;
            }
        })(coords);
        return n ? [sumX/n, sumY/n] : [0,0];
        }

        // === getSMOffset(meta) с логированием входа и решений ===
function getSMOffset(meta) {
    function log(msg, level){ try{ typeof logBind==='function'?logBind(msg,level||'info'):console.log(msg); }catch(_){ console.log(msg); } }
    const src = meta?.parsed ?? meta?.json ?? meta?.text ?? meta;
    let data = null;
    try { data = (typeof src === 'string') ? JSON.parse(src) : src; }
    catch(e){ log(`GeoJSON parse error: ${e?.message||e} → Δ=0`, 'warn'); return {x:0,y:0,z:0}; }
    if (!data || typeof data!=='object'){ log('GeoJSON: empty → Δ=0','warn'); return {x:0,y:0,z:0}; }

    // ищем первый узел с geometry.type === 'Point'
    let node = null;
    (function find(o){
        if (node || !o || typeof o!=='object') return;
        if (o.geometry && o.geometry.type==='Point' && Array.isArray(o.geometry.coordinates)) { node = o; return; }
        for (const k in o){ const v=o[k]; if (v && typeof v==='object') find(v); if (node) break; }
    })(data);
    if (!node){ log('GeoJSON: Point not found → Δ=0','warn'); return {x:0,y:0,z:0}; }

    const c = node.geometry.coordinates;
    const toNum = v => (typeof v==='number'&&isFinite(v))?v: (typeof v==='string'? parseFloat(v.replace(/\s+/g,'').replace(',','.')):NaN);
    const X = toNum(c[0]) || 0;
    const Y = toNum(c[1]) || 0;
    let Z = 0;
    if (node.properties && node.properties.h_relief != null) {
        const hr = toNum(node.properties.h_relief);
        if (isFinite(hr)) Z = hr;
    }
    log(`VPM: GeoJSON offset → Δx=${X} Δy=${Y} Δz=${Z}`,'ok');
    return { x:X, y:Y, z:Z };
}






        // =====================
        // Materials panel
        // =====================



        function renderOneModel(model, chunksArr) {
            function glassInfoRow(obj, material, matIndex) {
                const info = material?.userData?.glassInfo;
                if (!info) return '';
                const overrides = material?.userData?.glassOverrides || {};
                const alphaVal = clamp01(overrides.opacity ?? info.opacity ?? material.opacity ?? 1);
                const roughVal = clamp01(overrides.roughness ?? info.roughness ?? material.roughness ?? 0.1);
                const metalVal = clamp01(overrides.metalness ?? info.metalness ?? material.metalness ?? 0);
                const rawColor = overrides.color || info.colorHex || (material.color?.isColor ? `#${material.color.getHexString()}` : '#ffffff');
                const colorHex = (rawColor.startsWith ? rawColor : `#${rawColor}`).toUpperCase();
                const sourceLabel = info.source === 'override' ? 'Custom' : (info.source === 'geojson' ? 'GeoJSON' : 'UI');
                return `
                <tr class="glass-row">
                    <td class="k">Glass</td>
                    <td>
                        <div class="glass-controls" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                            <label>α
                                <input type="range" min="0" max="1" step="0.01" value="${alphaVal}" class="glass-slider" data-prop="opacity" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                <span class="glass-value" data-prop="opacity">${alphaVal.toFixed(2)}</span>
                            </label>
                            <label>rough
                                <input type="range" min="0" max="1" step="0.01" value="${roughVal}" class="glass-slider" data-prop="roughness" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                <span class="glass-value" data-prop="roughness">${roughVal.toFixed(2)}</span>
                            </label>
                            <label>metal
                                <input type="range" min="0" max="1" step="0.01" value="${metalVal}" class="glass-slider" data-prop="metalness" data-uuid="${obj.uuid}" data-mat-index="${matIndex}">
                                <span class="glass-value" data-prop="metalness">${metalVal.toFixed(2)}</span>
                            </label>
                            <label>color
                                <input type="color" class="glass-color-input" data-prop="color" data-uuid="${obj.uuid}" data-mat-index="${matIndex}" value="${colorHex}">
                            </label>
                            <span class="glass-source" data-role="glass-source">${sourceLabel}</span>
                        </div>
                    </td>
                </tr>`;
            }

            const modelId = `file-${model.obj.uuid}`;
            const kindBadge =
                model.zipKind === 'NPM' ? '<span class="pill">НПМ</span>' :
                model.zipKind === 'SM'  ? '<span class="pill">ВПМ</span>'  : '';

            const hasGeo = !!(model.geojson || model.obj.userData?.geojson);
            const collisions = [];
            model.obj.traverse(o => { if (o.isMesh && o.userData?.isCollision) collisions.push(o); });

            // заголовок файла FBX
            const fileControls = `${hasGeo ? `<button type="button" class="doc" data-uuid="${model.obj.uuid}" title="Показать GeoJSON">📄</button>` : ''}<button type="button" class="eye" data-target="${modelId}" title="Показать/скрыть файл">👁</button>`;
            const fileTitlePieces = [];
            if (kindBadge) fileTitlePieces.push(kindBadge);
            fileTitlePieces.push(`<span>${model.name}</span>`);
            const fileTitle = fileTitlePieces.join('');
            chunksArr.push(`
                <div class="collapsible" data-level="file">
                    <details data-level="file">
                        <summary>
                            <span class="sumline">${fileTitle}</span>
                        </summary>
            `);
            model.obj.userData._panelId = modelId;
            model.obj.userData._panelKind = 'file-root';

            // ---- СЕКЦИЯ КОЛЛИЗИЙ (UCX) ВНУТРИ ЭТОГО FBX ----
            if (collisions.length) {
                const colGroupId = `colgrp|${model.obj.uuid}`;
                const colControls = `<button type="button" class="eye" data-target="${colGroupId}" data-icon-on="🧱" data-icon-off="🚫" title="Показать/скрыть все коллизии файла">🧱</button>`;
                chunksArr.push(`
                    <div class="collapsible" data-level="collisions">
                        <details open data-level="collisions">
                            <summary>
                                <span class="sumline">
                                    <span>🧱 КОЛЛИЗИИ</span>
                                </span>
                            </summary>
                `);

                collisions.forEach(o => {
                    const mats = Array.isArray(o.material) ? o.material : [o.material];
                    mats.forEach((m, idx) => {
                        const objId = `collision-${o.uuid}-${idx}`;
                        o.userData._panelId = objId;
                        const humanIdx = mats.length > 1 ? ` [${idx+1}]` : '';
                        const title = (m?.name || o.name || o.geometry?.name || '__COLLISION__') + humanIdx;

                        const present = [];
                        ['map','alphaMap','normalMap','aoMap','roughnessMap','metalnessMap']
                            .forEach(k => { if (m?.[k]) present.push(`<span class="tag">${k}</span>`); });

                        const colEntryControls = `<button type="button" class="eye" data-target="${objId}" data-uuid="${o.uuid}" data-mat-index="${idx}" title="Показать/скрыть">👁</button>`;
                        chunksArr.push(`
                            <div class="collapsible" data-level="collision-mesh">
                                <details>
                                    <summary>
                                        <span class="sumline"><span>${title}</span></span>
                                    </summary>
                                <table>
                                    <tr><td class="k">Тип</td><td>${m?.type || '—'}</td></tr>
                                    <tr><td class="k">Цвет/α</td><td>#ff3333 · α=${(m?.opacity ?? 1).toFixed(2)}</td></tr>
                                    <tr><td class="k">Карты</td><td>${present.length ? present.join(' ') : '<span class="muted">—</span>'}</td></tr>
                                    ${glassInfoRow(o, m, idx)}
                                </table>
                                </details>
                                <div class="collapsible-controls">${colEntryControls}</div>
                            </div>
                        `);
                    });
                });

                chunksArr.push(`</details><div class="collapsible-controls">${colControls}</div></div>`);
            }

            // ---- ОСТАЛЬНЫЕ МЕШИ (ИСКЛЮЧАЕМ КОЛЛИЗИИ) ----
            model.obj.traverse((obj) => {
                if (!obj.isMesh || !obj.material) return;
                if (obj.userData?.isCollision) return; // 👈 не мешаем коллизиям

                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];

                mats.forEach((m, idx) => {
                    const humanIdx = idx + 1;
                    const matName = m.name || obj.name || `${m.type}`;
                    const title = `${matName}${mats.length > 1 ? ` [${humanIdx}]` : ''}`;
                    const present = [];
                    ['map','alphaMap','normalMap','bumpMap','aoMap','emissiveMap','specularMap','roughnessMap','metalnessMap']
                        .forEach(k => { if (m[k]) present.push(`<span class="tag">${k}</span>`); });

                    const objId = `${modelId}-mesh-${obj.uuid}-${idx}`;
                    obj.userData._panelId = objId;

                    const meshControls = `<button type="button" class="eye" data-target="${objId}" data-uuid="${obj.uuid}" data-mat-index="${idx}" title="Показать/скрыть">👁</button>`;
                    chunksArr.push(`
                        <div class="collapsible" data-level="mesh">
                            <details>
                                <summary>
                                    <span class="sumline"><span>${title}</span></span>
                                </summary>
                            <table>
                                <tr><td class="k">Карты</td><td>${present.length ? present.join(' ') : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Diffuse</td><td>${m.map ? texInfo(m.map) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Alpha</td><td>${m.alphaMap ? texInfo(m.alphaMap) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Normal</td><td>${m.normalMap ? texInfo(m.normalMap) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">AO</td><td>${m.aoMap ? texInfo(m.aoMap) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Roughness</td><td>${m.roughnessMap ? texInfo(m.roughnessMap) : '<span class="muted">—</span>'}</td></tr>
                                <tr><td class="k">Metalness</td><td>${m.metalnessMap ? texInfo(m.metalnessMap) : '<span class="muted">—</span>'}</td></tr>
                                ${glassInfoRow(obj, m, idx)}
                            </table>
                            </details>
                            <div class="collapsible-controls">${meshControls}</div>
                        </div>
                    `);
                });
            });

            chunksArr.push(`</details><div class="collapsible-controls">${fileControls}</div></div>`);
        }     

        function renderMaterialsPanel() {
            const chunks = [];
            chunks.push('<details open><summary>Объекты</summary>');

            // Собираем модели по имени ZIP (group) + те, что без ZIP
            const groupsMap = new Map();   // ← вместо "groups"
            const ungrouped = [];

            loadedModels.forEach(m => {
                if (m.group) {
                    if (!groupsMap.has(m.group)) groupsMap.set(m.group, []);
                    groupsMap.get(m.group).push(m);
                } else {
                    ungrouped.push(m);
                }
            });

            // Рендерим ZIP-группы
            for (const [groupName, models] of groupsMap.entries()) {
                const groupKind = models[0]?.zipKind || '';
                const gBadge = groupKind === 'NPM' ? 'НПМ' : groupKind === 'SM' ? 'ВПМ' : '';
                const groupId = `group|${groupName}`;
                const groupCollId = `zipcoll|${groupName}`;

                let groupHasCollisions = false;
                models.forEach(model => {
                    if (groupHasCollisions) return;
                    model.obj?.traverse(o => { if (!groupHasCollisions && o.isMesh && o.userData?.isCollision) groupHasCollisions = true; });
                });

                const groupCollBtn = groupHasCollisions
                    ? `<button type="button" class="eye" data-target="${groupCollId}" data-icon-on="🧱" data-icon-off="🚫" title="Показать/скрыть коллизии группы">🧱</button>`
                    : '';

                chunks.push(`
                <div class="collapsible" data-level="group">
                    <details data-level="group">
                        <summary>
                            <span class="sumline">
                                ${gBadge ? `<span class="pill" style="margin-right:6px">${gBadge}</span>` : ''}
                                <span>📦 ${groupName}</span>
                            </span>
                        </summary>
                `);

                models.forEach(model => renderOneModel(model, chunks));
                chunks.push(`</details><div class="collapsible-controls">${groupCollBtn}<button type="button" class="eye" data-target="${groupId}" title="Показать/скрыть группу">👁</button></div></div>`);
            }

            // Модели без ZIP-группы
            ungrouped.forEach(model => renderOneModel(model, chunks));

            chunks.push('</details>');
            outEl.innerHTML = chunks.join('\n');
            rebuildMaterialsDropdown();

            // клики по «глазам»
            outEl.querySelectorAll('.eye').forEach(el => {
                el.style.cursor = 'pointer';
                el.addEventListener('click', () => handleEyeToggle(el));
            });

            // клики по «бумажке» (GeoJSON)
            outEl.querySelectorAll('.doc').forEach(el => {
            el.style.cursor = 'pointer';
            el.addEventListener('click', (ev) => {
                ev.preventDefault();       // не даём <summary> схлопнуться/раскрыться
                ev.stopPropagation();      // гасим всплытие
                const uuid = el.dataset.uuid;
                const mdl = loadedModels.find(m => m.obj.uuid === uuid);
                const meta = mdl?.geojson || mdl?.obj?.userData?.geojson;
                if (!meta) { alert('GeoJSON не найден для этого FBX'); return; }
                openGeoModal(meta, mdl?.name || 'GeoJSON');
            });
            });

            bindGlassControls();
            syncCollisionButtons();
        }

        function resolveGlassMaterial(uuid, matIndex) {
            if (!uuid) return null;
            const mesh = world.getObjectByProperty('uuid', uuid);
            if (!mesh || !mesh.material) return null;
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            const index = Number.isInteger(matIndex) ? matIndex : (Number.isFinite(matIndex) ? matIndex : 0);
            const safeIndex = (index >= 0 && index < mats.length) ? index : 0;
            const mat = mats[safeIndex];
            if (!mat) return null;
            return { mesh, mat, index: safeIndex };
        }

        function bindGlassControls() {
            outEl.querySelectorAll('.glass-slider').forEach(input => {
                input.addEventListener('input', handleGlassSliderInput);
            });
            outEl.querySelectorAll('.glass-color-input').forEach(input => {
                input.addEventListener('input', handleGlassColorInput);
                input.addEventListener('change', handleGlassColorInput);
            });
        }

        function syncCollisionButtons() {
            if (!outEl) return;

            loadedModels.forEach(model => {
                const root = model.obj;
                if (!root) return;
                let hasAny = false;
                let anyVisible = false;
                root.traverse(o => {
                    if (o.userData?.isCollision) {
                        hasAny = true;
                        if (o.visible !== false) anyVisible = true;
                    }
                });
                if (hasAny) updateEyeButtonsForTarget(`colgrp|${root.uuid}`, anyVisible);
            });

            const grouped = new Map();
            loadedModels.forEach(model => {
                if (!model.group) return;
                if (!grouped.has(model.group)) grouped.set(model.group, []);
                grouped.get(model.group).push(model);
            });

            grouped.forEach((models, groupName) => {
                let hasAny = false;
                let anyVisible = false;
                models.forEach(model => {
                    const root = model.obj;
                    if (!root) return;
                    root.traverse(o => {
                        if (o.userData?.isCollision) {
                            hasAny = true;
                            if (o.visible !== false) anyVisible = true;
                        }
                    });
                });
                if (hasAny) updateEyeButtonsForTarget(`zipcoll|${groupName}`, anyVisible);
            });
        }

        function handleGlassSliderInput(ev) {
            const input = ev.currentTarget;
            if (!input) return;
            const prop = input.dataset.prop;
            const uuid = input.dataset.uuid;
            const matIndex = Number.parseInt(input.dataset.matIndex ?? '0', 10) || 0;
            const resolved = resolveGlassMaterial(uuid, matIndex);
            if (!resolved) return;
            const { mat } = resolved;
            const value = clamp01(parseFloat(input.value));
            input.value = String(value);

            const overrides = (mat.userData ||= {}).glassOverrides ||= {};
            overrides[prop] = value;

            applyGlassControlsToScene();

            const container = input.closest('.glass-controls');
            if (container) {
                const span = container.querySelector(`.glass-value[data-prop="${prop}"]`);
                if (span) span.textContent = value.toFixed(2);
                updateGlassSourceLabel(container, mat);
            }

            renderer.render(scene, camera);
        }

        function handleGlassColorInput(ev) {
            const input = ev.currentTarget;
            if (!input) return;
            const uuid = input.dataset.uuid;
            const matIndex = Number.parseInt(input.dataset.matIndex ?? '0', 10) || 0;
            const resolved = resolveGlassMaterial(uuid, matIndex);
            if (!resolved) return;
            const { mat } = resolved;
            let hex = (input.value || '#FFFFFF').toUpperCase();
            if (!hex.startsWith('#')) hex = `#${hex}`;
            input.value = hex;

            const overrides = (mat.userData ||= {}).glassOverrides ||= {};
            overrides.color = hex;

            applyGlassControlsToScene();

            const container = input.closest('.glass-controls');
            if (container) updateGlassSourceLabel(container, mat);

            renderer.render(scene, camera);
        }

        function updateGlassSourceLabel(container, mat) {
            if (!container || !mat) return;
            const label = container.querySelector('.glass-source');
            if (!label) return;
            const info = mat.userData?.glassInfo;
            let text = 'UI';
            if (info?.source === 'geojson') text = 'GeoJSON';
            else if (info?.source === 'override') text = 'Custom';
            label.textContent = text;
        }

        // =====================
        // Gallery / modal
        // =====================
        function renderGallery(listAll) {
            galleryEl.innerHTML = '';
            const total = Array.isArray(listAll) ? listAll.length : 0;

            (listAll || []).forEach((e, i) => {
                const div = document.createElement('div'); div.className = 'thumb';
                const nm = document.createElement('div'); nm.className = 'nm';
                nm.title = (e.full || e.short || '') + (e.fileName ? ` — ${e.fileName}` : '');
                nm.textContent = (e.short || `(entry ${i})`);
                const pill = document.createElement('span'); pill.className = 'pill';
                pill.textContent = guessKindFromName(e.short) + (e.fileName ? ` · ${basename(e.fileName)}` : '');

                const imgWrap = document.createElement('div');
                if (e && e.url) {
                    const img = document.createElement('img'); img.loading = 'lazy'; img.decoding = 'async'; img.alt = e.short || ''; img.src = e.url;
                    img.onerror = () => { div.classList.add('broken'); img.replaceWith(makePlaceholder(e)); };
                    imgWrap.appendChild(img);
                } else { div.classList.add('broken'); imgWrap.appendChild(makePlaceholder(e)); }

                div.appendChild(imgWrap); div.appendChild(nm); div.appendChild(pill);
                div.addEventListener('click', () => openTexModal(e));
                galleryEl.appendChild(div);

                function makePlaceholder(entry) { const ph = document.createElement('div'); ph.className = 'ph'; ph.textContent = entry?.mime ? entry.mime : 'preview error'; return ph; }
            });

            const spacer = document.createElement('div'); spacer.className = 'gallery-spacer'; galleryEl.appendChild(spacer);
            texCountEl.textContent = String(total);
        }

        const texModal = document.getElementById('texModal');
        const mClose = document.getElementById('mClose');
        const mImg = document.getElementById('mImg');
        const mTitle = document.getElementById('mTitle');
        const mFile = document.getElementById('mFile');
        const mKind = document.getElementById('mKind');
        const mMime = document.getElementById('mMime');
        const dlLink = document.getElementById('dlLink');
        const bindBtn = document.getElementById('bindBtn');
        const slotSelect = document.getElementById('slotSelect');

        let modalTex = null;
        function openTexModal(entry) {
            modalTex = entry;
            mImg.src = entry.url;
            mTitle.textContent = (entry.full || entry.short) + (entry.fileName ? ` — ${entry.fileName}` : '');
            mFile.textContent = entry.short;
            mKind.textContent = guessKindFromName(entry.short);
            mMime.textContent = entry.mime || '';
            dlLink.href = entry.url; dlLink.download = basename(entry.short);
            texModal.classList.add('show');

            if (matSelect && (matSelect.value === '' || matSelect.selectedIndex <= 0) && matSelect.options.length > 1) { matSelect.selectedIndex = 1; }

            const k = guessKindFromName(entry.short);
            slotSelect.value = k === 'base' ? 'map' : k === 'alpha' ? 'alphaMap' : k === 'normal' ? 'normalMap' : k === 'ao' ? 'aoMap' : (k === 'roughness' || k === 'gloss') ? 'roughnessMap' : k === 'metalness' ? 'metalnessMap' : 'map';
        }

        mClose.addEventListener('click', () => texModal.classList.remove('show'));
        texModal.addEventListener('click', (e) => { if (e.target === texModal) texModal.classList.remove('show'); });

        bindBtn.addEventListener('click', () => {
            if (!modalTex) return;

            const link = getSelectedMaterialLink();
            if (!link || !link.mat) { alert('Выберите материал в списке'); return; }

            const { obj, index } = link;
            const slot   = slotSelect.value;
            const linear = !(slot === 'map' || slot === 'emissiveMap');

            const t = textureLoader.load(modalTex.url);
            const humanName = basename(modalTex.full || modalTex.short);
            t.name = humanName; (t.userData ||= {}).origName = humanName;
            t.colorSpace = linear ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;

            // делаем PBR-эквивалент и назначаем карту на НОВЫЙ материал
            let std = toStandard(link.mat);

            let prevTex = null;
            if (slot === 'roughnessMap') { prevTex = std.roughnessMap || null; std.roughnessMap = t; std.roughness = 0.6; }
            else if (slot === 'metalnessMap') { prevTex = std.metalnessMap || null; std.metalnessMap = t; std.metalness = 1.0; }
            else if (slot === 'alphaMap') { prevTex = std.alphaMap || null; std.alphaMap = t; std.alphaTest = 0.5; std.transparent = false; std.depthWrite = true; }
            else { prevTex = std[slot] || null; std[slot] = t; }

            copyTextureSettings(prevTex, t);

            if (scene.environment) {
                std.envMap = scene.environment;
                std.envMapIntensity = parseFloat(iblIntEl.value);
            }
            std.needsUpdate = true;

            // ВАЖНО: подменяем материал у меша
            if (Array.isArray(obj.material)) {
                obj.material[index] = std;
            } else {
                obj.material = std;
            }
            cacheOriginalMaterialFor(obj, true);

            applyGlassControlsToScene();  // опционально
            renderMaterialsPanel();
            logBind(`${modalTex.short} → ${std.name || 'материал'}.${slot}`, 'ok');
        });

        // =====================
        // Glass controls
        // =====================
        function cacheOriginalMaterialFor(obj, force = false) {
            if (!obj) return;
            if (!force && currentShadingMode !== 'pbr') return;
            obj.userData._origMaterial = obj.material;
        }

        function applyGlassControlsToScene() {
            const op = parseFloat(glassOpacityEl?.value ?? 0.2);
            const refl = parseFloat(glassReflectEl?.value ?? 1.0);
            const metal = parseFloat(glassMetalEl?.value ?? 1.0);

            function findGeoMetaForObject(obj) {
                let node = obj;
                while (node) {
                    const meta = node.userData?._geojsonMeta || node.userData?.geojson;
                    if (meta) return meta;
                    node = node.parent || null;
                }
                return null;
            }

            world.traverse(o => {
                if (o.userData?.isCollision) return;
                if (!o.isMesh || !o.material) return;
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m, i) => {
                    const nameStr = `${m.name || ''} ${o.name || ''}`;
                    const geomSuffix = findGeomSuffix(nameStr);
                    const glass = isGlassByName(nameStr) || isGlassGeomSuffix(geomSuffix);
                    if (!glass) return;

                    const std = toStandard(m);
                    std.transparent = true;
                    std.envMap = scene.environment || std.envMap;
                    std.envMapIntensity = refl;

                    const geoMeta = findGeoMetaForObject(o);
                    const glassParams = geoMeta ? findGeoGlassParams(geoMeta, [m.name, o.name, nameStr]) : null;
                    std.userData ||= {};
                    const overrides = std.userData.glassOverrides || null;

                    let targetOpacity = clamp01(op);
                    let targetMetalness = metal;
                    let targetRoughness = Math.min(std.roughness ?? 0.12, 0.05);
                    let targetRefraction = null;

                    if (glassParams) {
                        if (glassParams.transparency != null) {
                            targetOpacity = clamp01(glassParams.transparency);
                        } else if (glassParams.opacity != null) {
                            targetOpacity = clamp01(glassParams.opacity);
                        }
                        if (glassParams.color) {
                            std.color.setRGB(glassParams.color.r, glassParams.color.g, glassParams.color.b);
                        }
                        if (glassParams.roughness != null) targetRoughness = clamp01(glassParams.roughness);
                        if (glassParams.metalness != null) targetMetalness = clamp01(glassParams.metalness);
                        if (glassParams.refraction != null) {
                            targetRefraction = glassParams.refraction;
                            if ('ior' in std) std.ior = glassParams.refraction;
                            std.userData.refraction = glassParams.refraction;
                        }
                    }

                    if (overrides) {
                        if (overrides.opacity != null) targetOpacity = clamp01(overrides.opacity);
                        if (overrides.roughness != null) targetRoughness = clamp01(overrides.roughness);
                        if (overrides.metalness != null) targetMetalness = clamp01(overrides.metalness);
                        if (overrides.color) {
                            try { std.color.set(overrides.color); } catch (_) {}
                        }
                        if (overrides.refraction != null && 'ior' in std) {
                            targetRefraction = overrides.refraction;
                            std.ior = overrides.refraction;
                            std.userData.refraction = overrides.refraction;
                        }
                    }

                    std.opacity = clamp01(targetOpacity);
                    if (!std.metalnessMap) std.metalness = clamp01(targetMetalness);
                    if (!std.roughnessMap) std.roughness = clamp01(targetRoughness);

                    const usingOverrides = overrides && Object.keys(overrides).length > 0;
                    const infoSource = usingOverrides ? 'override' : (glassParams ? 'geojson' : 'ui');
                    const info = {
                        opacity: std.opacity,
                        transparency: std.opacity,
                        roughness: std.roughness,
                        metalness: std.metalness,
                        envIntensity: std.envMapIntensity,
                        source: infoSource,
                        colorHex: std.color?.isColor ? `#${std.color.getHexString().toUpperCase()}` : null,
                    };
                    if (targetRefraction != null) info.refraction = targetRefraction;
                    std.userData.glassInfo = info;

                    std.needsUpdate = true;

                    if (Array.isArray(o.material)) { o.material[i] = std; } else { o.material = std; }
                    cacheOriginalMaterialFor(o, true);
                });
            });
        }

        [glassOpacityEl, glassReflectEl, glassMetalEl].forEach(el => {
            el?.addEventListener('input', () => { applyGlassControlsToScene(); renderer.render(scene, camera); });
        });

        // =====================
        // Auto-bind based on filenames
        // =====================

        function findTexEntryByURL(url) {
        return (allEmbedded || []).find(e => e && e.url === url) || null;
        }

        function labelFromURL(url) {
        const e = findTexEntryByURL(url);
        // отдаём настоящее имя файла (full или short), иначе хоть basename(url)
        const s = e?.full || e?.short || '';
        if (s) return s.split(/[\\/]/).pop();
        // blob: ссылки имён не содержат — вернём хоть последний сегмент
        try {
            const u = new URL(url);
            return u.pathname.split('/').pop() || '(texture)';
        } catch {
            return '(texture)';
        }
        }
        // =====================
        // VPM (SM_) — индексация текстур и привязка по UDIM+Slot
        // =====================

                    // // …_Vl_35_Ground.fbx → "35_ground"
                    // function vpmKeyFromFbxName(fbxFilename){
                    //     const base = basename(fbxFilename).replace(/\.[^.]+$/,'');
                    //     const parts = base.split('_').filter(Boolean);
                    //     if (parts.length < 3) return null;
                    //     return parts.slice(-2).join('_').toLowerCase();
                    // }

                    // // …_Vl_35_Ground_Diffuse_1.1002.png → "35_ground"
                    // const VPM_CHANNEL_RX = /^(diffuse|normal|erm|ao|alpha|opacity)$/i;
                    // function vpmKeyFromTexName(texFilename){
                    //     const base = basename(texFilename).replace(/\.[^.]+$/,'');
                    //     const parts = base.split('_').filter(Boolean);
                    //     const chanIdx = parts.findIndex(p => VPM_CHANNEL_RX.test(p));
                    //     if (chanIdx > 1) return parts.slice(chanIdx - 2, chanIdx).join('_').toLowerCase();
                    //     return null;
                    // }

        function vpmKeyFromFbxName(fbxName){
            const base = basename(fbxName).replace(/\.[^.]+$/,'');
            const parts = base.split('_');
            return parts.slice(-2).join('_').toLowerCase();   // напр. "Vl_35" или "35_Ground"
        }

            function vpmKeyFromTexName(texLabel){
            const base = texLabel.replace(/\.[^.]+$/,'').replace(/\.(10\d{2})$/,''); // убрать .1001
            const tokens = base.split('_');
            const chIdx = tokens.findIndex(t => /^(diffuse|normal|erm)$/i.test(t));
            if (chIdx >= 2) return (tokens[chIdx-2] + '_' + tokens[chIdx-1]).toLowerCase();
            return tokens.slice(-2).join('_').toLowerCase();
        }

            function parseVpmParts(label){
            const m = /_(Diffuse|Normal|ERM)_(\d+)\.(10\d{2})\b/i.exec(label);
            if (!m) return null;
            return {
                channel: m[1],               // 'Diffuse' | 'Normal' | 'ERM'
                slot: parseInt(m[2],10),     // число до точки
                udim: parseInt(m[3],10)      // 1001..1040
            };
        }

            // строим: Map<fbxKey, Map<`${slot}.${udim}`, {Diffuse,Normal,ERM}>>
            function buildVPMIndex(allImages){
            const byFBX = new Map();
            for (const e of allImages){
                if (!e?.url) continue;
                const label = labelFromURL(e.url);
                const parts = parseVpmParts(label);
                if (!parts) continue;
                const fbxKey = vpmKeyFromTexName(label);
                const key2 = `${parts.slot}.${parts.udim}`;

                let sub = byFBX.get(fbxKey);
                if (!sub){ sub = new Map(); byFBX.set(fbxKey, sub); }

                let rec = sub.get(key2);
                if (!rec){ rec = {}; sub.set(key2, rec); }

                rec[parts.channel] = e.url; // Diffuse/Normal/ERM → URL
            }
            return byFBX;
        }

        // T_Адрес_(Diffuse|ERM|Normal)_<slot>.<udim>.(png|jpg|jpeg|webp)
        const RX_VPM_TEX = /(?:^|\/)T_.+_(Diffuse|ERM|Normal)_(\d+)\.(\d{4})\.(?:png|jpe?g|webp)$/i;

        function parseVPMTexEntry(entry){
            const nm = String(entry?.full || entry?.short || '');
            const m = nm.match(RX_VPM_TEX);
            if (!m) return null;
            const kind = m[1];                    // Diffuse | ERM | Normal
            const slot = parseInt(m[2], 10);
            const udim = parseInt(m[3], 10);
            if (!Number.isFinite(slot) || !Number.isFinite(udim)) return null;
            return { kind, slot, udim, url: entry.url };
        }

        // Собираем индекс: key = `${slot}.${udim}` → { Diffuse?, ERM?, Normal? }
        function buildVPMIndexFromImages(images){
            const map = new Map(); // key -> {Diffuse,ERM,Normal}
            (images || []).forEach(e => {
                const p = parseVPMTexEntry(e);
                if (!p) return;
                const key = `${p.slot}.${p.udim}`;
                if (!map.has(key)) map.set(key, {});
                map.get(key)[p.kind] = p.url;
            });
            return map;
        }

        // Из ERM (R=Emissive, G=Roughness, B=Metalness) делаем 3 CanvasTexture (линейные)
        async function splitERMtoThreeMaps(url){
            const img = await createImageBitmap(await (await fetch(url)).blob());
            const w = img.width, h = img.height;

            const base = document.createElement('canvas'); base.width=w; base.height=h;
            const bctx = base.getContext('2d', { willReadFrequently:true }); 
            bctx.drawImage(img, 0, 0);

            function chanToTex(ci){
                const c = document.createElement('canvas'); c.width=w; c.height=h;
                const ctx = c.getContext('2d');
                const src = bctx.getImageData(0,0,w,h);
                const dst = ctx.createImageData(w,h);
                for (let i=0;i<src.data.length;i+=4){
                    const v = src.data[i+ci];
                    dst.data[i]=dst.data[i+1]=dst.data[i+2]=v; dst.data[i+3]=255;
                }
                ctx.putImageData(dst,0,0);
                const t = new THREE.CanvasTexture(c);
                t.colorSpace = THREE.LinearSRGBColorSpace; // линейные для rough/metal/emissiveMap
                t.flipY = false;
                return t;
            }
            return {
                emissiveMap:  chanToTex(0), // R
                roughnessMap: chanToTex(1), // G
                metalnessMap: chanToTex(2)  // B
            };
        }

        // function detectSlotFromMatOrObj(o, m){
        //     // у тебя уже есть detectSlotFromMaterialName(name), переиспользуем:
        //     const byMat = detectSlotFromMaterialName(m?.name);
        //     if (byMat) return byMat;
        //     const byObj = detectSlotFromMaterialName(o?.name);
        //     if (byObj) return byObj;
        //     return 1; // запасной вариант
        // }

        function detectUDIMfromGeo(geo){
            const uv = geo?.getAttribute?.('uv');
            if (!uv) return 1001;
            let uMin=+Infinity, vMin=+Infinity, uMax=-Infinity, vMax=-Infinity;
            for (let i=0;i<uv.count;i++){
                const u=uv.getX(i), v=uv.getY(i);
                uMin=Math.min(uMin,u); vMin=Math.min(vMin,v);
                uMax=Math.max(uMax,u); vMax=Math.max(vMax,v);
            }
            const tileU = Math.floor((uMin+uMax)*0.5);
            const tileV = Math.floor((vMin+vMax)*0.5);
            return 1001 + tileU + tileV*10;
        }

        // Привязка Diffuse/ERM/Normal к каждому UDIM-сабмешу (отдельный материал на сабмеш)
        async function autoBindVPMForModel(root, vpmIndex){
            const env = scene.environment;
            const envInt = parseFloat(iblIntEl.value);

            // 1) имя FBX и ключ набора (двойной хвост)
            const fileName =
                root?.userData?._fbxFileName ||
                (loadedModels.find(m => m.obj === root)?.name) ||
                null;

            if (!fileName) {
                logBind(`VPM: не удалось вычислить имя FBX — привязываю без фильтра`, 'warn');
            }

            const fbxKey = fileName ? vpmKeyFromFbxName(fileName) : null;
            const sub = fbxKey ? vpmIndex.get(fbxKey) : null;
            if (!sub) {
                logBind(`VPM: для набора ${fbxKey || '(unknown)'} нет индекса — пропускаю модель`, 'info');
                return;
            }

            const bindOps = []; // промисы (для ERM)

            root.traverse(o => {
                if (!o.isMesh || !o.geometry) return;
                if (o.userData?.isCollision) return;

                // 2) UDIM и SLOT для текущего меша
                const udim = o.userData?.udim || detectUDIMfromGeo(o.geometry);
                const slot = detectSlotFromMatOrObj(o, Array.isArray(o.material) ? o.material[0] : o.material);

                const primaryMat = Array.isArray(o.material) ? o.material[0] : o.material;
                const label = `${primaryMat?.name || ''} ${o.name || ''}`;
                const geomSuffix = findGeomSuffix(label);
                if (isGlassByName(label) || isGlassGeomSuffix(geomSuffix)) {
                    logBind(`VPM: пропущен стеклянный меш "${o.name}" (slot ${slot}, udim ${udim})`, 'info');
                    return;
                }

                logBind(`VPM: mesh="${o.name}" → slot=${slot}, udim=${udim}`, 'info');

                // 3) Берём набор карт для ЭТОГО FBX по ключу slot.udim
                const key = `${slot}.${udim}`;
                const set = sub.get(key);
                if (!set) {
                    logBind(`VPM: нет карт для slot=${slot}, udim=${udim}`, 'info');
                    return;
                }

                // (опция) двойная проверка хвоста: карта действительно от этого FBX?
                if (fbxKey) {
                    const anyUrl = set.Diffuse || set.Normal || set.ERM;
                    const texKey = anyUrl ? vpmKeyFromTexName(labelFromURL(anyUrl)) : null;
                    if (texKey && texKey !== fbxKey) {
                        logBind(`VPM: "${labelFromURL(anyUrl)}" → ключ ${texKey} ≠ ${fbxKey} — пропускаю`, 'info');
                        return;
                    }
                }

                // 4) Базовый материал → Standard-клон
                const base = toStandard(Array.isArray(o.material) ? o.material[0] : o.material);
                const mat = base.clone();
                const fallbackName = base.name || `M · UDIM ${udim}`;
                mat.name = base.name ? base.name : fallbackName;
                (mat.userData ||= {}).vpm = { key, slot, udim };

                // Diffuse
                if (set.Diffuse) {
                    const prevMap = mat.map || null;
                    const map = textureLoader.load(set.Diffuse);
                    const nm = labelFromURL(set.Diffuse);
                    map.name = nm;
                    map.userData ||= {};
                    map.userData.origName = nm;
                    map.colorSpace = THREE.SRGBColorSpace;
                    // map.flipY = false;
                    copyTextureSettings(prevMap, map);
                    mat.map = map;

                    // не для стекла — маска по альфа-каналу диффуза
                    const label = `${mat.name || ''} ${o.name || ''}`.toLowerCase();
                    const isGlass = /mainglass|groundglass|groundelglass/.test(label);
                    if (!isGlass) {
                        mat.transparent = false;             // маска, не блендинг
                        mat.depthWrite = true;
                        mat.alphaTest = Math.max(0.001, mat.alphaTest || 0.4);
                        if (renderer.capabilities.isWebGL2) mat.alphaToCoverage = true;

                        const common = { map: mat.map, alphaTest: mat.alphaTest, side: THREE.FrontSide };
                        o.customDepthMaterial    = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, ...common });
                        o.customDistanceMaterial = new THREE.MeshDistanceMaterial(common);
                    }
                }

                // Normal
                if (set.Normal) {
                    const prevNormal = mat.normalMap || null;
                    const n = textureLoader.load(set.Normal);
                    const nm = labelFromURL(set.Normal);
                    n.name = nm;
                    n.userData ||= {};
                    n.userData.origName = nm;
                    n.colorSpace = THREE.LinearSRGBColorSpace; // нормали в линейном
                    // n.flipY = false;
                    copyTextureSettings(prevNormal, n);
                    mat.normalMap = n;
                    mat.normalScale = new THREE.Vector2(1,1);
                }

                // ERM (асинхронно распакуем каналы)
                if (set.ERM) {
                    const p = (async () => {
                        const maps = await splitERMtoThreeMaps(set.ERM);
                        const baseNm = labelFromURL(set.ERM);

                        if (maps.emissiveMap) {
                            maps.emissiveMap.name = `${baseNm} [R]`;
                            maps.emissiveMap.userData ||= {};
                            maps.emissiveMap.userData.origName = maps.emissiveMap.name;
                        }
                        if (maps.roughnessMap) {
                            maps.roughnessMap.name = `${baseNm} [G]`;
                            maps.roughnessMap.userData ||= {};
                            maps.roughnessMap.userData.origName = maps.roughnessMap.name;
                        }
                        if (maps.metalnessMap) {
                            maps.metalnessMap.name = `${baseNm} [B]`;
                            maps.metalnessMap.userData ||= {};
                            maps.metalnessMap.userData.origName = maps.metalnessMap.name;
                        }

                        mat.emissive = new THREE.Color(1,1,1);
                        mat.emissiveIntensity = 1.0;
                        mat.emissiveMap  = maps.emissiveMap;   // R
                        mat.roughnessMap = maps.roughnessMap;  // G
                        mat.metalnessMap = maps.metalnessMap;  // B
                        mat.metalness = 1.0;                   // карта задаёт финальное значение
                        mat.needsUpdate = true;

                        if (env) { mat.envMap = env; mat.envMapIntensity = envInt; }
                        o.material = mat;
                        cacheOriginalMaterialFor(o, true);
                        logBind(`VPM: Slot ${slot}, UDIM ${udim} → ${mat.name}`, 'ok');
                    })();
                    bindOps.push(p);
                } else {
                    if (env) { mat.envMap = env; mat.envMapIntensity = envInt; }
                    o.material = mat;
                    cacheOriginalMaterialFor(o, true);
                    logBind(`VPM: Slot ${slot}, UDIM ${udim} (без ERM) → ${mat.name}`, 'ok');
                }
            });

            await Promise.all(bindOps);
        }






        function parseTexName(filename){
            const rawBase = basename(filename).replace(/\.[a-z0-9]+$/i, '');
            const base = rawBase.toLowerCase();
            const parts = rawBase.split('_');
            const lowerParts = base.split('_');

            // id в конце опционален → по умолчанию 1
            let id = 1;
            const last = lowerParts[lowerParts.length-1];
            if (/^\d+$/.test(last)) {
                id = parseInt(parts.pop(), 10);
                lowerParts.pop();
            }

            // поддерживаем оба порядка: ..._<geom>_<map>_[id] И ..._<map>_<geom>_[id]
            const a = lowerParts.slice(-2);
            if (a.length < 2) return null;
            let [p1,p2] = a;

            let geom, map;
            if (GEOM_SUFFIXES.includes(p1)) { geom = p1; map = p2; }
            else if (GEOM_SUFFIXES.includes(p2)) { geom = p2; map = p1; }
            else return null;

            const kindMap = { d:'base', n:'normal', o:'alpha', m:'metalness', r:'roughness' };
            const kind = kindMap[map] || guessKindFromName(filename);

            let code3 = null;
            const lowerGeomIndex = lowerParts.lastIndexOf(geom);
            if (lowerGeomIndex > 0) {
                const candidate = parts[lowerGeomIndex - 1];
                if (/^\d{3}$/i.test(candidate)) {
                    code3 = candidate.padStart(3, '0');
                }
            }

            return { id, geomSuffix: geom, mapSuffix: map, code3, kind };
        }

        function kindToSlot(kind) {
            switch (kind) {
                case 'base': return 'map';
                case 'normal': return 'normalMap';
                case 'alpha': return 'alphaMap';
                case 'metalness': return 'metalnessMap';
                case 'roughness': return 'roughnessMap';
                case 'ao': return 'aoMap';
                default: return null;
            }
        }

        function indexModelMaterials(root) {
            const idx = new Map();
            root.traverse(o => {
                if (!o.isMesh || !o.material) return;
                if (o.userData?.isCollision) return;
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m, i) => {
                    const materialId = i + 1;
                    const label = `${m.name || ''} ${o.name || ''}`.toLowerCase();
                    const code3Match = label.match(/(^|[_\W])(\d{3})([_\W]|$)/);
                    const code3 = code3Match ? code3Match[2] : null;
                    const geom = findGeomSuffix(label);
                    const keys = [];
                    if (geom) { keys.push(`${code3 || '—'}|${geom}|${materialId}`); keys.push(`—|${geom}|${materialId}`); }
                    keys.push(`${code3 || '—'}|—|${materialId}`); keys.push(`—|—|${materialId}`);
                    keys.forEach(k => { if (!idx.has(k)) idx.set(k, { obj: o, material: m, slotIndex: i, materialId, geom, code3 }); });
                });
            });
            return idx;
        }

        function autoBindByNamesForModel(root, fileName, embeddedList) {
            const history = [];
            const matIndex = indexModelMaterials(root);
            embeddedList.forEach(tex => {
                const p = parseTexName(tex.short);
                if (!p) { logBind(`⚠️ ${tex.short} — не распознан шаблон имени`, 'warn'); return; }
                const { id, geomSuffix, code3, kind } = p;
                const slot = kindToSlot(kind);
                if (!slot) { logBind(`⚠️ ${tex.short} — нераспознан тип карты`, 'warn'); return; }
                const keyWith = `${code3 || '—'}|${geomSuffix}|${id}`;
                const keyNoC3 = `—|${geomSuffix}|${id}`;
                let target = matIndex.get(keyWith) || matIndex.get(keyNoC3);

                if (!target && code3) {
                    for (const entry of matIndex.values()) {
                        if (!entry) continue;
                        if (entry.geom === geomSuffix && entry.code3 === code3 && entry.materialId === id) {
                            target = entry;
                            break;
                        }
                    }
                }

                if (!target && code3) {
                    for (const entry of matIndex.values()) {
                        if (!entry) continue;
                        if (entry.geom === geomSuffix && entry.code3 === code3) {
                            target = entry;
                            break;
                        }
                    }
                }

                if (!target) { logBind(`⚠️ ${tex.short} — нет материала по «${code3 || '—'} / ${geomSuffix} / id:${id}»`, 'warn'); return; }

                const mats = Array.isArray(target.obj.material) ? target.obj.material : [target.obj.material];
                let m = mats[target.slotIndex];
                m = toStandard(m);
                mats[target.slotIndex] = m; target.obj.material = Array.isArray(target.obj.material) ? mats : m;
                cacheOriginalMaterialFor(target.obj, true);

                const currentTexture = m[slot] || null;
                const t = textureLoader.load(tex.url);
                const humanName = basename(tex.full || tex.short);
                t.name = humanName; (t.userData ||= {}).origName = humanName;
                t.colorSpace = (slot === 'map' || slot === 'emissiveMap') ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
                t.userData.autoBound = true;

                const existingName = currentTexture && (currentTexture.userData?.origName || currentTexture.name || '').toLowerCase();
                const newName = humanName.toLowerCase();
                const sameTexture = currentTexture && existingName && existingName === newName;

                if (currentTexture && !sameTexture) {
                    logBind(`ℹ️ ${tex.short} — слот ${slot} будет перезаписан`, 'info');
                }

                if (currentTexture && sameTexture) {
                    logBind(`ℹ️ ${tex.short} — слот ${slot} уже содержит эту карту`, 'info');
                    return;
                }

                copyTextureSettings(currentTexture, t);

                if (currentTexture && !sameTexture) {
                    currentTexture.dispose?.();
                }

                if (slot === 'roughnessMap') { m.roughnessMap = t; m.roughness = 0.6; }
                else if (slot === 'metalnessMap') { m.metalnessMap = t; m.metalness = 1.0; }
                else if (slot === 'alphaMap') { m.alphaMap = t; m.alphaTest = 0.5; m.transparent = false; m.depthWrite = true; }
                else { m[slot] = t; }

                if (scene.environment) { m.envMap = scene.environment; m.envMapIntensity = parseFloat(iblIntEl.value); }
                m.needsUpdate = true;
                history.push({ obj: target.obj, matIndex: target.slotIndex, slot, prev: currentTexture || null, url: tex.url, tex: t });
                logBind(`✅ ${tex.short} → ${m.name || 'материал'}.${slot}`, 'ok');
            });
            if (history.length) undoStack.push({ fileName, bindings: history });
        }

        // =====================
        // Dropdown & material collection
        // =====================
        function rebuildMaterialsDropdown() {
            const items = collectMaterialsFromWorld();
            matSelect.innerHTML = '<option value="">— выберите материал —</option>';
            items.forEach((it, i) => {
                const opt = document.createElement('option'); opt.value = String(i); opt.textContent = it.label; matSelect.appendChild(opt);
            });
            matSelect.dataset._map = JSON.stringify(items.map((x, idx) => ({ idx, path: x.path })));
        }

        function collectMaterialsFromWorld() {
            const out = [];
            world.traverse(o => {
                if (!o.isMesh || !o.material) return;
                if (o.userData?.isCollision) return; // 👈 не показываем UCX в выпадающем списке
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m, i) => {
                    const humanIdx = i + 1;
                    const label = `${o.name || o.type} · ${m.type}${m.name ? ` (${m.name})` : ''}${mats.length > 1 ? ` [${humanIdx}]` : ''}`;
                    out.push({ obj: o, index: i, label, path: `${o.uuid}:${i}` });
                });
            });
            return out;
        }

        function getSelectedMaterial() {
            if (matSelect && (matSelect.value === '' || matSelect.selectedIndex <= 0) && matSelect.options.length > 1) { matSelect.selectedIndex = 1; }
            const val = matSelect?.value; if (val === '' || val == null) return null;
            let map = [];
            try { map = JSON.parse(matSelect.dataset._map || '[]'); } catch { map = []; }
            const entry = map.find(e => String(e.idx) === String(val)); if (!entry || !entry.path) return null;
            const [uuid, idxStr] = String(entry.path).split(':'); const targetIndex = parseInt(idxStr, 10) || 0;
            let found = null;
            world.traverse(o => { if (found || !o.isMesh) return; if (o.uuid !== uuid) return; const mats = Array.isArray(o.material) ? o.material : [o.material]; found = mats[targetIndex] || null; });
            return found;
        }

        // =====================
        // File flow
        // =====================
        const fileInput = document.getElementById('fileInput');
        const openBtn = document.getElementById('openBtn');

        // =====================
        // LIGHT CONTROLL
        // =====================
        document.getElementById('hemiInt').addEventListener('input', e => {
            hemiLight.intensity = parseFloat(e.target.value);
        });

        document.getElementById('hemiSky').addEventListener('input', e => {
            hemiLight.color.set(e.target.value);
        });

        document.getElementById('hemiGround').addEventListener('input', e => {
            hemiLight.groundColor.set(e.target.value);
        });


        openBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async (e) => {
            const files = [...(e.target.files || [])];
            for (const f of files) {
                if (/\.fbx$/i.test(f.name)) {
                    await handleFBXFile(f);
                } else if (/\.zip$/i.test(f.name)) {
                    await handleZIPFile(f);
                }
            }
            await finalizeBatchAfterAllFiles();
        });

        ['dragenter','dragover'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.add('show'); }));
        ['dragleave','drop'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop') return; dropEl.classList.remove('show'); }));

        window.addEventListener('drop', async e => {
            e.preventDefault(); dropEl.classList.remove('show');
            const files = [...(e.dataTransfer?.files || [])];
            for (const f of files) {
                if (/\.fbx$/i.test(f.name)) {
                    await handleFBXFile(f);
                } else if (/\.zip$/i.test(f.name)) {
                    await handleZIPFile(f);
                }
            }
            await finalizeBatchAfterAllFiles();
        });

        async function handleFBXFile(file, groupName = null, zipKind = null, zipMeta = null) {
        logSessionHeader(`FBX: ${file.name}`);

        // если zipKind не передали из handleZIPFile — определим по имени ZIP здесь
        if (!zipKind && groupName) {
            zipKind = /^\d/.test(groupName) ? 'NPM' : (/^SM/i.test(groupName) ? 'SM' : null);
        }

        const ab = await file.arrayBuffer();
        let orientationInfo = readFBXOrientationFromBuffer(ab);
        let orientationSource = orientationInfo?.source || null;
        let orientationMeta = determineOrientationType(orientationInfo);
        let orientationType = orientationMeta.type;

        const embedded = await extractImagesFromFBX(ab);
        embedded.forEach(e => e.fileName = file.name);
        allEmbedded.push(...embedded);
        renderGallery(allEmbedded);

        const url = URL.createObjectURL(new Blob([ab], { type: 'model/fbx' }));

        await new Promise((resolve, reject) => {
            fbxLoader.load(url, async obj => {
            URL.revokeObjectURL(url);

            // ★ NEW: имя FBX на объект
            obj.userData._fbxFileName = file.name;
            if (!orientationInfo && obj.userData?.fbxTree) {
                const infoFromTree = readFBXOrientationFromTree(obj.userData.fbxTree);
                if (infoFromTree) {
                    orientationInfo = infoFromTree;
                    orientationSource = infoFromTree.source || 'tree';
                    orientationMeta = determineOrientationType(orientationInfo);
                    orientationType = orientationMeta.type;
                }
            }
            if (!orientationInfo) {
                const infoFromGeom = parseOrientationFromNode(obj);
                if (infoFromGeom) {
                    orientationInfo = infoFromGeom;
                    orientationSource = infoFromGeom.source || 'geometry';
                    orientationMeta = determineOrientationType(orientationInfo);
                    orientationType = orientationMeta.type;
                }
            }

            if (orientationInfo) {
                orientationInfo.type = orientationType;
                orientationInfo.handedness = orientationMeta.handedness;
                orientationInfo.upAxisResolved = orientationMeta.upAxis;
                obj.userData.orientation = orientationInfo;
                const sourceLabels = { binary: 'GlobalSettings', tree: 'fbxTree' };
                const src = sourceLabels[orientationSource] || orientationSource || 'unknown';
                logBind(`FBX: ориентация (${src}; ${describeOrientationType(orientationType)}) — ${describeFBXOrientation(orientationInfo)}`, 'info');
            } else {
                logBind(`FBX: ориентация — не найдена (тип: ${describeOrientationType(orientationType)})`, 'warn');
            }

            obj.userData.orientationType = orientationType;
            obj.userData.orientationHandedness = orientationMeta.handedness;
            obj.userData.orientationUpAxis = orientationMeta.upAxis;

            normalizeObjectOrientation(obj, orientationType);

            // ★ NEW: если это ВПМ и есть geojson — сохраним мету и применим смещение
            if ((zipKind || '').toUpperCase() === 'SM' && zipMeta) {
                // иконка 📄 в панели смотрит на _geojsonMeta
                obj.userData._geojsonMeta = zipMeta;

                const fbxBase = file.name.replace(/\.[^.]+$/, '');
                const { x, y, z } = getSMOffset(zipMeta);

                // XY из GeoJSON → XZ в сцене (Y = up), h_relief → Y
                applyGeoOffsetByOrientation(obj, orientationType, { x, y, z });

                logBind(`VPM: смещение для ${file.name} из GeoJSON → Δx=${x} Δy=${y} Δz=${z}`, 'ok');
            }

            world.add(obj);

          
            // Отключаем тени у всех светильников из этого FBX
            disableShadowsOnImportedLights(obj);
    

            renameMaterialsByFBXObject(obj);

            obj.traverse(o => {
                if (!o.isMesh) return;
                const mats = Array.isArray(o.material) ? o.material : [o.material];

                let willCast = false;
                mats.forEach(m => {
                if (m.side === THREE.DoubleSide) m.shadowSide = THREE.FrontSide;

                const hasMask = !!m.alphaMap || (m.alphaTest > 0);
                const trulyTransparent = m.transparent && !hasMask;

                if (hasMask) {
                    m.transparent = false;
                    m.alphaTest = Math.max(0.001, m.alphaTest || 0.5);
                    m.depthWrite = true;
                    willCast = true;
                } else if (!trulyTransparent) {
                    willCast = true;
                }
                });

                o.castShadow = willCast;
                o.receiveShadow = true;
            });

            // // сгруппировать UCX в "КОЛЛИЗИИ" и подписать материалы по имени объекта
            // const col = groupUCXUnderCollisions(obj);
            // if (col) logBind(`Найдены UCX → собраны в «КОЛЛИЗИИ» и материалы переименованы по объекту`, 'ok');

            // ← назначим материалы/флаги коллизиям
            markCollisionMeshes(obj);

            // если это ВПМ/SM — разрезаем геометрию по UDIM
    if ((zipKind || '').toUpperCase() === 'SM' || (obj.userData?.zipKind || '').toUpperCase() === 'SM') {
        splitAllMeshesByUDIM_SM(obj);
    }
            // сохраняем метаданные для группировки и бейджа
            loadedModels.push({
                obj,
                name: file.name,
                group: groupName || null,  // имя ZIP (если есть)
                zipKind: zipKind || null,   // 'NPM' | 'SM' | null
                geojson: zipMeta || null,
                orientation: orientationInfo || null,
                orientationType
            });
            // (опционально дублируем на сам объект)
            obj.userData.zipGroup = groupName || null;
            obj.userData.zipKind  = zipKind || null;

            if ((zipKind || '').toUpperCase() === 'SM' || /^SM_/i.test(file.name)) {
                // Для ВПМ (SM) автопривязку делаем ПОЗЖЕ (когда картинки из ZIP уже добавлены)
                logBind(`VPM: отложенная автопривязка для ${file.name}`, 'info');
            } else {
                // НПМ/прочее — как раньше
                autoBindByNamesForModel(obj, file.name, embedded);
            }
            applyGlassControlsToScene();

            renderMaterialsPanel();
            applyShading(shadingSel.value);
            resolve();
            }, undefined, err => {
            URL.revokeObjectURL(url);
            statusEl.textContent = `Ошибка загрузки: ${file.name}`;
            appbarStatusEl.textContent = statusEl.textContent;
            logBind(`⚠️ Ошибка загрузки ${file.name}: ${err?.message || String(err)}`, 'warn');
            reject(err);
            });
        });
        }
        async function handleZIPFile(file) {
            logSessionHeader(`ZIP: ${file.name}`);
            statusEl.textContent = `Чтение ZIP: ${file.name}…`;
            appbarStatusEl.textContent = statusEl.textContent;

            const zipKind = /^\d/.test(file.name) ? 'NPM' : /^SM/i.test(file.name) ? 'SM' : null;
            const zip = await JSZip.loadAsync(file);
            const entries = Object.values(zip.files);

            // 1) прочитаем geojson (если есть) — один на ZIP
            // let zipGeoMeta = null;
            // const geoEntry = entries.find(e => !e.dir && /\.geojson$/i.test(e.name));
            // if (geoEntry) {
            //     const geoText = await geoEntry.async('string');
            //     zipGeoMeta = makeGeoJsonMeta(file.name, geoEntry.name, geoText);
            // }


            // ↓↓↓ ТОЛЬКО ДЛЯ ВПМ
            let zipGeoMeta = null;
            if (zipKind === 'SM') {
                const geoEntries = entries.filter(e => !e.dir && /\.geojson$/i.test(e.name));
                if (geoEntries.length) {
                const bytes = await geoEntries[0].async('uint8array');
                let geoText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                // снять BOM, если есть
                geoText = geoText.replace(/^\uFEFF/, '');
                
                zipGeoMeta = makeGeoJsonMeta(file.name, geoEntries[0].name, geoText);
                logBind(`GeoJSON: найден в «${file.name}» → ${geoEntries[0].name}`, 'ok');
                } else {
                logBind(`GeoJSON: в «${file.name}» не найден (ВПМ без меты)`, 'info');
                }
            }


           // Сначала FBX — каждому передаём zipGeoMeta (для SM) или null (для NPM/прочих)
            for (const entry of entries) {
                if (entry.dir) continue;
                if (/\.fbx$/i.test(entry.name)) {
                const ab = await entry.async("arraybuffer");
                const fbxFile = new File([ab], basename(entry.name), { type: "model/fbx" });
                await handleFBXFile(fbxFile, file.name, zipKind, zipGeoMeta);
                }
            }

            // Затем картинки как было
            for (const entry of entries) {
                if (entry.dir) continue;
                if (/\.(png|jpe?g|webp)$/i.test(entry.name)) {
                const blob = await entry.async("blob");
                const url = URL.createObjectURL(blob);
                const short = basename(entry.name).toLowerCase();
                allEmbedded.push({ short, url, full: entry.name, mime: blob.type || "image/png", source: "zip" });
                }
            }

            renderGallery(allEmbedded);

            // 4) если в ZIP был geojson — прикрепим его ко ВСЕМ FBX из этого ZIP
            if (zipGeoMeta) {
                let attached = 0;
                loadedModels
                    .filter(m => m.group === file.name)      // модели, загруженные из этого же архива
                    .forEach(m => {
                        m.geojson = zipGeoMeta;              // для рендера в панели
                        (m.obj.userData ||= {}).geojson = zipGeoMeta; // на сам объект — если удобно обращаться из дерева
                        attached++;
                    });

                if (attached) {
                    logBind(`GeoJSON: прикреплён к ${attached} FBX из «${file.name}» (${zipGeoMeta.entryName}${zipGeoMeta.featureCount!=null ? `, features: ${zipGeoMeta.featureCount}` : ''})`, 'ok');
                    renderMaterialsPanel(); // перерисуем, чтобы появилась 📄
                } else {
                    logBind(`GeoJSON: файл найден в «${file.name}», но FBX из этого ZIP не обнаружены`, 'warn');
                }
            }

            // statusEl/appbarStatus — по желанию
            // statusEl.textContent = `Готово: ${file.name}`;
            // appbarStatusEl.textContent = statusEl.textContent;
        }

            async function finalizeBatchAfterAllFiles() {
                if (!loadedModels.length) return;

                // — ребейз только один раз —
                let firstTime = false;
                if (!didInitialRebase) {
                    const off = computeAutoOffsetHorizontalOnly(); // только XZ (при Y-up) или XY (при Z-up)
                    setWorldOffset(off);                            // высоту не трогаем
                    didInitialRebase = true;
                    firstTime = true;
                }

                // IBL / фон — всегда
                if (iblChk.checked) {
                    await loadHDRBase();
                    buildAndApplyEnvFromRotation(parseFloat(iblRotEl.value) || 0);
                }

                ensureBgMesh();
                bgMesh.material.map = currentBg || null;
                bgMesh.material.needsUpdate = true;
                updateBgVisibility();

                // материалы/стекло — всегда
                applyGlassControlsToScene();

                // тени/солнце — всегда
                fitSunShadowToScene(true);
                updateSun();


                // --- VPM (SM) автопривязка ПОСЛЕ того как все картинки добавлены ---
                try {
                    const smModels = loadedModels.filter(m => (m.zipKind || '').toUpperCase() === 'SM');
                    if (smModels.length) {
                        const vpmIndex = buildVPMIndexFromImages(allEmbedded); // парсим T_..._Diffuse/ERM/Normal_Slot.UDIM.png
                        for (const m of smModels) {
                            await autoBindVPMForModel(m.obj, vpmIndex);
                        }
                    }
                } catch (e) {
                    logBind(`⚠️ VPM: ошибка автопривязки — ${e?.message || e}`, 'warn');
                }

                // камеру кадрируем только в самый первый раз, чтобы дальше не «прыгала»
                if (firstTime) {
                    fitAll();
                    focusOn(loadedModels.map(m => m.obj));
                }

                const vpmIndex = buildVPMIndex(allEmbedded);
                for (const m of loadedModels) {
                if ((m.zipKind || '').toUpperCase() === 'SM') {
                    await autoBindVPMForModel(m.obj, vpmIndex);
                }
                }

                renderMaterialsPanel();
                outEl.querySelectorAll('details[data-level="group"], details[data-level="file"]').forEach(d => d.open = false);
                // Картинки + лог: свернуть после первой загрузки,
                // чтобы потом не мешать пользователю, если он раскроет вручную.
                if (firstTime) {
                    if (imagesDetails) imagesDetails.open = false;
                    if (bindLogDetails) bindLogDetails.open = false;
                }
            }

        
        app.api = Object.freeze({
            applyShading,
            setEnvironmentEnabled,
            updateSun,
            focusOn,
            fitAll,
            computeSceneBounds,
            layout,
            updateBgVisibility,
            computeWorldCenter,
        });
// =====================
        // Animation loop & init
        // =====================
        (function animate() { requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); })();
        layout();
        HDRI_LIBRARY.forEach((h, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = h.name;
            hdriPresetSel.appendChild(opt);
        });
        // IBL не запускаем автоматически — управляется чекбоксом
    }
}

const viewerApp = new ViewerApp();
if (typeof globalThis !== "undefined") {
    globalThis.viewerApp = viewerApp;
}

export default viewerApp;
