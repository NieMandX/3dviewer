# LPMVIEW Viewer: production audit after Three.js r184

Дата: 2026-05-23
Ветка: `gh-pages`
Область: vanilla ES modules viewer, Three.js `0.184.0`, WebGL/WebGPU, FBX/ZIP import, Web Workers, Supabase collab/realtime, Playwright smoke.

## Executive summary

Критичные классы runtime-регрессий после перехода на r184 сейчас закрыты или покрыты smoke-тестами:

- demand-render race после загрузки текстур и материалов;
- WebGPU/HDRI disable crash из-за `envMap = null`;
- stale room/model loads после reconnect, room switch и удаления модели;
- cleanup GPU-ресурсов при failed/aborted FBX/ZIP import;
- worker abort/dispose/stale message races;
- Supabase realtime init/dispose/timeout/late status races;
- CDN/import-map consistency для `three@0.184.0` и addons.

Текущий `npm run ci:verify` зеленый. В финальном проходе новых незакрытых P0/P1 runtime-багов не найдено.

## Top issues by severity

### P0. WebGPU падал при выключении HDRI

Симптом: при отключении HDRI render loop останавливался:

`TypeError: Cannot read properties of null (reading 'isTexture')` внутри `three.webgpu.js`.

Root cause:
в r184 WebGPU `NodeMaterialObserver` не переживает переход уже наблюдаемого material texture slot в `null`. Для WebGPU нельзя просто чистить `material.envMap`, если материал уже видел текстуру.

Reproduction:

1. Запустить WebGPU renderer.
2. Загрузить сцену с PBR/Physical материалами.
3. Выключить HDRI в боковой панели.
4. Следующий render падает в `NodeMaterialObserver.equals`.

Minimal patch:

- Для WebGPU при выключении HDRI сохранять texture reference и гасить IBL через `envMapIntensity = 0`.
- Полностью чистить `envMap` только на dispose с `forceClear`.

Refactor path:

- Разделить "environment texture ownership" и "environment visible/enabled state" как отдельные состояния.
- Прогонять WebGL/WebGPU matrix на все material toggles.

Coverage:

- `runEnvironmentLifecycleSmoke`: WebGPU disable не чистит `envMap`, dispose чистит.

### P1. UV/Matcap/texture display modes проявлялись только после вращения

Симптом: после переключения в `UV`, `Matcap` и некоторые texture-backed режимы текстура появлялась на одном меше, а остальные "одевались" при вращении камеры или повторном переключении режима.

Root cause:
r184/WebGPU загружает/обновляет текстуры и node/material state не всегда за один demand-render кадр. Viewer давал один кадр после массовой замены материалов, и часть upload/update выполнялась только при следующем dirty кадре от OrbitControls.

Reproduction:

1. Загрузить модель с несколькими мешами.
2. Переключиться в `UV` или `Matcap`.
3. Не двигать камеру: часть мешей остается без ожидаемой текстуры.
4. Повернуть сцену: материалы постепенно становятся корректными.

Minimal patch:

- Для texture-backed shading modes делать короткий render burst.
- Помечать generated materials/textures dirty.

Refactor path:

- Сделать единый `requestMaterialUploadBurst(reason)` для всех async texture/material paths.
- Добавить счетчик burst-кадров в debug diagnostics.

Coverage:

- `runShadingControllersLifecycleSmoke`
- `runTextureReplacementLifecycleSmoke`
- Коммит: `905a890 Refresh textured shading modes`

### P1. PBR import мог выглядеть неполностью материализованным до движения камеры

Симптом: после первой загрузки модели часть PBR-материалов/текстур могла стать видимой только после orbit/режимного переключения.

Root cause:
после batch finalize в PBR viewer оставался в demand-render режиме и не давал r184/WebGPU достаточно кадров для upload/material refresh.

Reproduction:

1. Открыть комнату или импортировать модель.
2. Дождаться завершения загрузки.
3. Не трогать камеру: часть материалов выглядит пустой/невидимой.
4. Повернуть сцену: состояние исправляется.

Minimal patch:

- После успешного batch finalize новой модели в PBR запросить короткий post-import render burst.
- Не делать burst для non-PBR режимов.

Refactor path:

- Перенести post-import render scheduling в общий import lifecycle event.

Coverage:

- `runBatchFinalizerDisposeSmoke`
- Коммит: `4081d1f Stabilize PBR import rendering`

### P1. Targeted cleanup room model мог abort'ить unrelated sync upload

Симптом: при удалении/очистке одной комнатной модели могла сорваться синхронизация другой локальной модели.

Root cause:
remote import abort controllers и local sync upload abort controllers жили в одной коллекции. Targeted cleanup вызывал общий abort и затрагивал не тот тип операции.

Reproduction:

1. В комнате идет sync upload локальной модели.
2. Одновременно приходит realtime delete/cleanup другой room model.
3. Cleanup абортит не только remote import, но и local upload.

Minimal patch:

- Развести import controllers и sync controllers в `room-load-abort-registry`.
- Targeted cleanup абортит только remote imports.
- Full room/session reset абортит imports + syncs.

Refactor path:

- Протащить operation identity через все long-running async flows.
- Логировать abort reason/source в diagnostics.

Coverage:

- `runRoomLoadAbortRegistrySmoke`
- `runRoomModelLoadQueueSmoke`
- Коммит: `9e0dde5 Isolate room model abort scopes`

### P1. Realtime reconnect мог очищать сцену после sleep/network break

Симптом: после закрытия крышки ноутбука или потери связи приложение могло начать заново подгружать комнату и убирать уже загруженные модели.

Root cause:
reconnect трактовался как новый room load lifecycle, а cleanup не различал manual disconnect и auto-resume. Также Supabase websocket timeouts могли запускать повторные init/dispose циклы.

Reproduction:

1. Авторизоваться, зайти в проект и комнату.
2. Дождаться загрузки моделей.
3. Увести ноутбук в sleep или оборвать сеть.
4. Вернуть сеть: старые каналы пересоздаются, но модель не должна исчезать.

Minimal patch:

- Auto-resume вызывает teardown с `preserveAutoResume`.
- Room assets не чистятся при reconnect.
- Failed realtime init чистит открытые channels и не оживляется late status callback.

Refactor path:

- Отделить "collab session transport reconnect" от "room content generation".
- Добавить state machine для collab: `disconnected`, `connecting`, `connected`, `reconnecting`, `closing`.

Coverage:

- `runCollabAutoResumeKeepsModelsSmoke`
- `runCollabRealtimeDisposeSmoke`
- `runCollab init-failure cleanup smoke`

### P1. Worker stale messages and abort races

Симптом: после rapid model switching старый FBX/ZIP worker мог прислать late success/error, который не должен менять текущую сцену.

Root cause:
worker операции асинхронные, браузер не гарантирует порядок доставки cancel относительно тяжелого parse. Клиент должен считать worker responses stale по worker instance + request id + disposed/abort signal.

Reproduction:

1. Начать загрузку тяжелого FBX/ZIP.
2. Быстро переключить комнату или удалить модель.
3. Старый worker завершает parse и отправляет success/error.

Minimal patch:

- Проверять `workerInstance === worker` и `pending.has(id)`.
- На abort последнего задания terminate worker.
- После parse response проверять disposed/signal перед возвратом Object3D.
- На parse failure dispose восстановленный Object3D.

Refactor path:

- Ввести worker job generation и structured diagnostics для каждого job.
- Рассмотреть dedicated worker per active import для тяжелых FBX, чтобы cancel не стоял за уже выполняющимся parse.

Coverage:

- `runWorkerLifecycleSmoke`
- `runWorkerClientDisposeSmoke`

### P1. FBX/ZIP partial import leaks

Симптом: при ошибке/abort в середине FBX/ZIP pipeline могли остаться Object3D, blob URL, geometry/material/texture/skeleton или stale gallery entries.

Root cause:
pipeline многошаговый: worker/main parse, embedded extraction, orientation normalization, world add, UDIM split, autobind. Ошибка после частичного добавления должна откатывать все ресурсы, включая embedded entries.

Reproduction:

1. FBX parse успешен.
2. Ошибка происходит в embedded extraction, normalize, post-add обработке или autobind.
3. Проверить `loadedModels`, `allEmbedded`, scene children и dispose counts.

Minimal patch:

- `cleanupImportedRange` для batch/import scope.
- `disposeObjectResources`/`disposeImportedObjectTree` проходят geometry/material/textures/uniform textures/skeleton.
- Blob URLs revoke на rollback.

Refactor path:

- Явный `ImportTransaction` с `commit()/rollback()`.
- Единый resource tracker для Object3D subtree.

Coverage:

- `runFBXCleanupLifecycleSmoke`
- `runZIPFallbackCleanupSmoke`
- `runImportPipelineQueueSmoke`

### P2. CDN/import-map version drift

Симптом: часть модулей могла подтянуть другой Three.js/addons build, что особенно опасно после r184.

Root cause:
vanilla ES modules + workers используют CDN URL в нескольких местах: `index.html`, smoke import map, `fbx-worker.js`.

Reproduction:

1. Обновить import map до одной версии.
2. Забыть worker CDN URL или smoke import map.
3. Loader/addons могут оказаться несовместимы с core renderer.

Minimal patch:

- `ci:versions` проверяет точный `three@0.184.0`, `three/webgpu`, `three/tsl`, `three/addons/`, FBX worker и smoke import map.

Refactor path:

- Генерировать import map и worker CDN constants из одного runtime manifest.

Coverage:

- `npm run ci:versions`

## Quick wins на 1 день

- Добавить ручной чек-лист "30 минут long-session": WebGPU/WebGL, room reconnect, rapid model switch, UV/Matcap/PBR toggles, HDRI on/off.
- Включить в debug overlay счетчики: `loadedModels.length`, `allEmbedded.length`, active workers, active realtime channels, `renderer.info.memory`.
- Добавить Playwright smoke на rapid sequence: загрузка комнаты -> active model switch -> delete -> reconnect -> повторная загрузка.
- Добавить smoke на WebGL и WebGPU URL variants: `?renderer=webgl` и `?renderer=webgpu`.
- Зафиксировать искусственный свет как отдельный performance epic, не смешивать с lifecycle-аудитом.

## План на 1 неделю

1. Сделать runtime diagnostics panel для production debug:
   `models`, `embedded`, `blobUrls`, `workers`, `realtimeChannels`, `renderer.memory`, `renderBursts`.

2. Вынести import lifecycle в явную transaction-модель:
   `beginImport`, `registerObject`, `registerBlobUrl`, `commit`, `rollback`.

3. Ввести long-session CI mode:
   50-100 циклов load/delete/switch/toggle shading на synthetic scene без реального Supabase.

4. Добавить Supabase fake-realtime stress:
   late `SUBSCRIBED`, `TIMED_OUT`, `CHANNEL_ERROR`, delete/insert reorder, reconnect while model load is active.

5. Свести CDN/runtime versions в один manifest и генерировать из него:
   import map, worker constants, smoke import map, CI assertions.

6. Для WebGPU отдельно протестировать:
   HDRI toggle, material replacement, glass controls, debug texture modes, post-import bursts.

## Missing CI/smoke coverage

- Настоящий GPU memory plateau в браузере после 30-60 минут: текущий smoke проверяет dispose counts, но не доказывает отсутствие драйверных GPU утечек.
- Реальный Supabase websocket под плохой сетью: smoke имитирует статусы, но не покрывает Cloudflare/Supabase транспортные особенности.
- Большие production FBX/ZIP с 50+ материалов/UDIM: synthetic smoke не заменяет реальные heavy assets.
- Performance baseline для 50 spotlights без теней: это отдельный renderer/performance трек.
- Mobile Safari/WebKit и sleep/wake: текущие проверки в основном Chromium/Playwright.
- WebGPU backend differences: локальный Chrome может вести себя иначе на разных GPU/драйверах.

## Current verification

Команда:

```bash
npm run ci:verify
```

Результат на 2026-05-23:

- syntax checks: passed;
- runtime CDN versions: passed (`three@0.184.0`);
- Playwright smoke suite: passed.
