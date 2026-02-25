# LPMVIEW: Архитектурная память проекта

Дата фиксации: 2026-02-25
Ветка анализа: `feature/extended-glass-controls`
Область: только viewer (`LPMVIEW/app`), без `IMA_Landing`.

## 1. Краткий профиль кода

- Точка входа: `index.html` -> `scripts/viewer-app.js` -> `scripts/modules/app/viewer-app-main.js`.
- Всего модулей: `97` файлов в `scripts/modules`.
- Оценочный объем модулей: `~22k LOC`.
- Композиционный центр: `scripts/modules/app/viewer-app-main.js` (`3806` строк).

Крупные подсистемы по размеру:

- `scripts/modules/app/viewer-app-main.js` — оркестрация всего приложения.
- `scripts/modules/annotations/annotations-3d.js` — 3D-аннотации и их lifecycle.
- `scripts/modules/ui/camera-presets.js` — пресеты камер, переходы, UI.
- `scripts/modules/ui/materials-panel.js` — инспектор моделей/материалов.
- `scripts/modules/collab/collab-controller.js` — Supabase, presence, realtime.

## 2. Основная архитектура (как реально устроено)

Модель — controller-based orchestration:

1. `viewer-app-main.js` создает ядро сцены и далее "прошивает" контроллеры.
2. Большинство модулей чисто функциональные (`createXxxController(...)`), без глобальных singleton.
3. Общий runtime state хранится в замыканиях `ViewerApp` и частично в `app`.
4. Важные коллекции состояния:
- `app.loadedModels` — список всех загруженных FBX-объектов с мета.
- `app.allEmbedded` — текстуры/изображения из FBX/ZIP.
- `app.undoStack` — стек undo для ручных операций в материалах.

Критичный факт: в проекте нет «жесткого DI-контейнера», но `viewer-app-main.js` фактически им является.

## 3. Границы подсистем

### 3.1 Render/Scene

- `scripts/modules/render/renderer-mode.js`
- `scripts/modules/render/renderer-init.js`
- `scripts/modules/scene/scene-core.js`
- `scripts/modules/render/render-loop.js`
- `scripts/modules/render/environment-manager.js`
- `scripts/modules/render/environment-wiring.js`

Роль:

- Определение режима `webgl/webgpu`.
- Инициализация renderer и readiness-гейтинг для WebGPU.
- Сцена/камера/свет/Orbit+WASD.
- Demand-driven рендер-петля через `requestRender()`.
- HDRI/PMREM/rotation/intensity/background sync.

### 3.2 Import/IO

- `scripts/modules/io/asset-loaders.js`
- `scripts/modules/io/import-handlers.js`
- `scripts/modules/io/fbx-file.js`
- `scripts/modules/io/zip-file.js`
- `scripts/modules/io/batch-finalizer.js`
- `scripts/modules/workers/fbx-worker-client.js`
- `scripts/modules/workers/zip-worker-client.js`

Роль:

- Worker-first парсинг FBX/ZIP c fallback на main thread.
- Нормализация ориентации, mark collisions, UDIM split (для SM), авто-привязка текстур.
- Финализация пачки: HDRI, VPM autobind, initial framing, UI refresh.

### 3.3 Materials/Naming

- `scripts/modules/material/naming.js`
- `scripts/modules/material/autobind-pipeline.js`
- `scripts/modules/material/vpm-autobind.js`
- `scripts/modules/material/glass-controller.js`
- `scripts/modules/material/rename-materials.js`

Роль:

- Нейминг-семантика suffix/slot/glass.
- Автобиндинг по имени файлов и отдельный VPM UDIM-пайплайн.
- Применение/override стекол в сцене и панели.

### 3.4 UI/Inspector

- `scripts/modules/ui/viewer-dom.js`
- `scripts/modules/ui/inspector-panels.js`
- `scripts/modules/ui/materials-panel.js`
- `scripts/modules/ui/visibility-collisions.js`
- `scripts/modules/ui/appbar-*.js`

Роль:

- Сбор DOM ссылок и wiring событий.
- Инспектор объектов, материалов, коллизий, GeoJSON.
- Глобальные visibility-toggle режимы (включая отдельно VPM/NPM).

### 3.5 Collab + Camera Sync

- `scripts/modules/collab/collab-controller.js`
- `scripts/modules/collab/camera-sync.js`

Роль:

- Auth/guest, project-room lifecycle, realtime каналы.
- Синхронизация камеры с owner-моделью и idle-follow.
- Синхронизация аннотаций, сообщений, комнатных моделей.

### 3.6 Annotations

- `scripts/modules/annotations/annotations-3d.js`

Роль:

- 3D stroke/line/rect/pin/eraser.
- Авторство, слои, remote sync hooks.
- Явное управление dispose GPU-ресурсов (важно для WebGPU).

## 4. Ключевые runtime-контракты (инварианты)

1. Тип модели определяется по `zipKind`:
- `SM` = ВПМ (high-poly).
- `NPM` = НПМ (low-poly).

2. Ветвление логики по типу модели используется в разных подсистемах:
- VPM autobind/UDIM/GeoJSON и скрытие SM-collision.
- UI-бейджи `ВПМ`/`НПМ`.
- Тогглы видимости VPM/NPM.

3. `loadedModels` — единый source of truth для:
- инспектора,
- батч-финализации,
- VPM авто-бинда,
- visibility/collision-операций,
- части collab-потока.

4. Для ZIP c освещением `_Light.fbx` важна ориентация:
- light-файл грузится после основной геометрии,
- может наследовать orientation type от предыдущей модели.

5. Material lifecycle:
- `obj.userData._origMaterial` используется как опорный «исходник» для shading/debug-переключений.
- Нельзя бездумно затирать `_origMaterial` в неподходящих режимах.

6. Render policy:
- большинство операций не рендерят кадр напрямую, а ставят флаг через `requestRender`.
- «постоянный» рендер не используется, кроме логики loop + dirty trigger.

## 5. Поток загрузки моделей (реальный)

### 5.1 FBX

1. Вход в `handleFBXFile` (`io/fbx-file.js`).
2. Парсинг в воркере при поддержке, fallback на main-thread parser.
3. Извлечение embedded images.
4. Определение ориентации (`binary/tree/geometry/zip-inherit`).
5. Нормализация ориентации и запись метаданных в `userData`.
6. Для `SM` + `GeoJSON` — расчет/применение offset.
7. Добавление в world, rename материалов, mark UCX, SM UDIM split, glass optimization.
8. Регистрация в `loadedModels` и привязка `zipKind/group`.
9. Автобинд:
- SM: отложенно через batch finalizer (VPM index).
- NPM/прочее: immediate name-based bind.

### 5.2 ZIP

1. Вход в `handleZIPFile` (`io/zip-file.js`).
2. Определение `zipKind` по имени архива.
3. Worker-stream (meta/progress/geojson/fbx/image) с ACK-подтверждениями.
4. Fallback через JSZip на UI-потоке при ошибках worker.
5. При наличии GeoJSON — прикрепление к моделям этой группы.
6. После загрузки — `ensureZipCollisionsHidden(group)`.

### 5.3 Batch Finalize

`createBatchFinalizer.finalizeBatchAfterAllFiles()`:

1. Инкрементальное определение новых моделей.
2. Однократный initial rebase world.
3. Применение окружения/HDRI при включенном IBL.
4. Применение стекла/солнца/теней.
5. VPM autobind для новых SM моделей.
6. Initial fit/focus только при первом заполнении сцены.
7. Финальная синхронизация UI/коллизий/шейдинга.

## 6. Где код сложный и рискованный

1. `viewer-app-main.js`:
- Сильно связанный orchestration-файл.
- Много межмодульных замыканий и runtime переменных.

2. `annotations-3d.js`:
- Сложный pointer + geometry + dispose lifecycle.
- Легко поймать регресс по утечкам/ломаному интерактиву.

3. `collab-controller.js`:
- Много каналов и race-сценариев (room/model/camera/messages).
- Нужна аккуратность с teardown/reconnect.

4. `vpm-autobind.js`:
- Дорогая обработка ERM (canvas split), чувствительна к naming/UDIM-конвенциям.

5. `environment-manager.js`:
- Управление текстурами/PMREM/перестроением окружения, критично к timing и renderer state.

## 7. Производительность: что уже видно

Основные горячие зоны:

1. Парсинг и разбор крупных ZIP/FBX.
2. ERM splitting в `vpm-autobind.js`.
3. Полный `world.traverse(...)` в visibility/material sync операциях.
4. Частые panel refresh при массовых изменениях.

Что уже сделано правильно:

- Worker-first для FBX/ZIP.
- Инкрементальная batch-finalization (`lastFinalizedModelIndex`).
- Demand-driven render loop.

## 8. Практические правила для дальнейших правок

1. Любой новый функционал сначала привязывать к правильной ветке `zipKind` (`SM` vs `NPM`).
2. Не выполнять тяжелые проверки/обходы мира по каждому input-event без debounce/батча.
3. Не ломать контракт `loadedModels` (минимум: `obj`, `name`, `zipKind`, `group`).
4. Перед сменой материалов учитывать `_origMaterial` и текущий shading mode.
5. После массовых операций вызывать `requestRender`, а не форсить лишние render-и.
6. Для WebGPU-совместимых изменений проверять dispose/submit гонки.
7. Изменения в collab-потоке делать только с учетом teardown/reconnect path.

## 9. Точки расширения (куда лучше встраивать новую логику)

1. Импорт-валидации модели:
- место: `io/fbx-file.js` и `io/zip-file.js` до постобработки сцены,
- агрегация: отдельный модуль `scripts/modules/checks/*` + вызов из `batch-finalizer`.

2. Новые UI-панели:
- место: `ui/inspector-panels.js` + отдельный controller,
- state брать из `loadedModels`/derived summaries, не из DOM.

3. Отладочная телеметрия:
- место: `render-loop.js` + `stats-overlay.js`.

4. Материал-нейминг правила:
- место: `material/naming.js` (единый источник регексов и suffix-логики).

## 10. Что зафиксировать как «не трогать без необходимости»

1. Механизм inheritance ориентации для `_Light.fbx`.
2. Логику скрытия SM коллизий после batch finalize.
3. Разделение immediate-bind (NPM) и deferred VPM-bind (SM).
4. Камерную ownership-модель в collab (`camera_owner_id` + broadcast/persist).

## 11. Быстрый индекс файлов для старта задачи

- `scripts/modules/app/viewer-app-main.js` — главный orchestration.
- `scripts/modules/io/fbx-file.js` — импорт FBX.
- `scripts/modules/io/zip-file.js` — импорт ZIP.
- `scripts/modules/io/batch-finalizer.js` — пост-обработка батча.
- `scripts/modules/material/naming.js` — suffix/slot/glass правила.
- `scripts/modules/material/vpm-autobind.js` — VPM UDIM bind.
- `scripts/modules/ui/materials-panel.js` — инспектор материалов.
- `scripts/modules/ui/visibility-collisions.js` — видимость и UCX.
- `scripts/modules/annotations/annotations-3d.js` — 3D аннотации.
- `scripts/modules/collab/collab-controller.js` — realtime collaboration.
