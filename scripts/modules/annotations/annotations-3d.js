function safePrompt(promptFn, message, fallback = '') {
    if (typeof promptFn !== 'function') return fallback;
    try {
        const value = promptFn(message);
        if (value == null) return null;
        return String(value);
    } catch (_) {
        return fallback;
    }
}

function isEditableElement(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
}

function isAnyModalOpen() {
    if (typeof document === 'undefined') return false;
    return !!document.querySelector?.('.modal.show');
}

export function createAnnotations3DController(options = {}) {
    const THREE = options.THREE || null;
    const world = options.world || null;
    const camera = options.camera || null;
    const controls = options.controls || null;
    const flightControls = options.flightControls || null;
    const renderer = options.renderer || null;
    const canvas = options.annotateCanvasEl || null;
    const toolbarEl = options.annotateToolbarEl || null;
    const annoToggleBtn = options.annoToggleBtn || null;
    const annoVisibleBtn = options.annoVisibleBtn || null;
    const annoDrawBtn = options.annoDrawBtn || null;
    const annoColorEl = options.annoColorEl || null;
    const annoDashEl = options.annoDashEl || null;
    const annoWidthEl = options.annoWidthEl || null;
    const annoUndoBtn = options.annoUndoBtn || null;
    const annoClearBtn = options.annoClearBtn || null;
    const annoLayerSelectEl = options.annoLayerSelectEl || null;
    const annoLayerAddBtn = options.annoLayerAddBtn || null;
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const onStrokeCommitted =
        typeof options.onStrokeCommitted === 'function' ? options.onStrokeCommitted : null;
    const onStrokeRemoved =
        typeof options.onStrokeRemoved === 'function' ? options.onStrokeRemoved : null;
    const promptLayerName =
        typeof options.promptLayerName === 'function' ? options.promptLayerName : null;
    const promptRectSettings =
        typeof options.promptRectSettings === 'function' ? options.promptRectSettings : null;
    const canRemoveStroke =
        typeof options.canRemoveStroke === 'function' ? options.canRemoveStroke : null;
    const promptFn =
        typeof options.prompt === 'function'
            ? options.prompt
            : (typeof globalThis !== 'undefined' && typeof globalThis.prompt === 'function'
                ? globalThis.prompt.bind(globalThis)
                : null);

    if (!THREE || !world || !camera || !canvas) {
        return Object.freeze({
            setEnabled: () => false,
            setVisible: () => false,
            getDrawEnabled: () => false,
            isPointerDown: () => false,
            addRemoteAnnotation: () => null,
            removeRemoteAnnotation: () => false,
            registerAnnotationId: () => false,
            applyWorldOffsetDelta: () => {},
            dispose: () => {},
        });
    }

    const MathUtils = THREE.MathUtils;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const tmpDir = new THREE.Vector3();
    const tmpOrigin = new THREE.Vector3();
    const tmpRight = new THREE.Vector3();
    const tmpUp = new THREE.Vector3();
    const tmpVec = new THREE.Vector3();
    const tmpVec2 = new THREE.Vector3();
    const tmpVec3 = new THREE.Vector3();
    const tmpNormal = new THREE.Vector3();

    const annotationsRoot = new THREE.Group();
    annotationsRoot.name = 'Annotations';
    annotationsRoot.userData.annotationRoot = true;
    world.add(annotationsRoot);

    const draftGroup = new THREE.Group();
    draftGroup.name = 'AnnotationDraft';
    draftGroup.userData.excludeFromExport = true;
    annotationsRoot.add(draftGroup);

    const layers = [];
    let activeLayerId = null;
    let drawEnabled = false;
    let visible = true;
    let tool = 'pencil';
    let dash = 'solid';
    let color = '#ffcc00';
    let widthPx = 3;
    let planeDistance = 1;
    let draft = null;
    let rectModalOpen = false;
    let pointerId = null;
    let prevControlsEnabled = null;
    let prevFlightEnabled = null;
    let lastEraseId = null;
    let onWheelBound = null;
    let onPointerDownBound = null;
    let onPointerMoveBound = null;
    let onPointerUpBound = null;
    let onPointerCancelBound = null;
    let onKeyDownBound = null;
    let toolbarReady = false;
    let hotkeysReady = false;
    const authorVisibility = new Map();
    const pinAuthorVisibility = new Map();
    const pendingDisposals = new Map();
    let disposeScheduled = false;
    const raf =
        typeof globalThis !== 'undefined' && typeof globalThis.requestAnimationFrame === 'function'
            ? globalThis.requestAnimationFrame.bind(globalThis)
            : null;
    const undoStack = [];
    const strokesById = new Map();

    function makeId() {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function vecToArray(vec) {
        if (!vec) return null;
        return [vec.x, vec.y, vec.z];
    }

    function toStoredPoint(vec) {
        if (!vec) return null;
        const stored = vec.clone();
        if (world?.position) stored.sub(world.position);
        return stored;
    }

    function fromStoredPoint(vec, coordSpace) {
        if (!vec) return null;
        if (coordSpace === 'world' && world?.position) {
            vec.add(world.position);
        }
        return vec;
    }

    function arraysToPoints(list, coordSpace) {
        if (!Array.isArray(list)) return [];
        return list
            .map((pt) => (Array.isArray(pt) ? fromStoredPoint(new THREE.Vector3(pt[0], pt[1], pt[2]), coordSpace) : null))
            .filter((pt) => pt);
    }

    function serializeStyle(style) {
        if (!style) return null;
        return {
            color: style.color,
            width: style.width,
            dash: style.dash,
        };
    }

    function setCanvasActive(active) {
        canvas.classList.toggle('active', !!active);
    }

    function setDrawEnabled(next) {
        const nextEnabled = !!next;
        if (!nextEnabled && (draft || pointerId != null)) {
            cancelStroke();
        }
        drawEnabled = nextEnabled;
        if (drawEnabled) {
            planeDistance = getDefaultPlaneDistance();
        }
        setCanvasActive(drawEnabled);
        syncToolbar();
    }

    function setVisible(next) {
        visible = !!next;
        annotationsRoot.visible = visible;
        if (annoVisibleBtn) annoVisibleBtn.classList.toggle('active', visible);
        requestRender();
    }

    function normalizeTool(nextTool) {
        const t = String(nextTool || '').trim().toLowerCase();
        return ['pencil', 'line', 'rect', 'pin', 'eraser'].includes(t) ? t : null;
    }

    function setTool(nextTool) {
        const t = normalizeTool(nextTool) || 'pencil';
        tool = t;
        syncToolbar();
    }

    function setDash(nextDash) {
        const t = String(nextDash || '').trim().toLowerCase();
        dash = ['solid', 'dashed', 'dotted'].includes(t) ? t : 'solid';
    }

    function setColor(nextColor) {
        const c = String(nextColor || '').trim();
        color = c || '#ffcc00';
    }

    function setWidth(nextWidth) {
        const n = Number(nextWidth);
        widthPx = Number.isFinite(n) ? Math.max(1, Math.min(40, n)) : widthPx;
    }

    function getDefaultPlaneDistance() {
        if (!controls?.target || !camera?.position) return 1;
        return Math.max(0.1, camera.position.distanceTo(controls.target));
    }

    function getViewRect() {
        const viewEl = renderer?.domElement || canvas;
        if (!viewEl?.getBoundingClientRect) return null;
        return viewEl.getBoundingClientRect();
    }

    function updateNdcFromClient(clientX, clientY, rect) {
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        return true;
    }

    function updateNdcFromEvent(e, rect) {
        return updateNdcFromClient(e.clientX, e.clientY, rect);
    }

    function getPlaneState() {
        camera.getWorldDirection(tmpDir);
        tmpDir.normalize();

        tmpOrigin.copy(camera.position).addScaledVector(tmpDir, planeDistance);
        tmpUp.copy(camera.up).normalize();
        tmpRight.crossVectors(tmpDir, tmpUp);
        if (tmpRight.lengthSq() < 1e-6) {
            tmpRight.set(1, 0, 0);
        } else {
            tmpRight.normalize();
        }
        tmpUp.crossVectors(tmpRight, tmpDir).normalize();

        const plane = new THREE.Plane();
        plane.setFromNormalAndCoplanarPoint(tmpDir, tmpOrigin);
        return {
            origin: tmpOrigin.clone(),
            normal: tmpDir.clone(),
            xAxis: tmpRight.clone(),
            yAxis: tmpUp.clone(),
            plane,
        };
    }

    function getPointOnPlane(e, planeState) {
        const rect = getViewRect();
        if (!rect || !updateNdcFromEvent(e, rect)) return null;
        raycaster.setFromCamera(ndc, camera);
        if (!raycaster.ray.intersectPlane(planeState.plane, tmpVec)) return null;
        return tmpVec.clone();
    }

    function shouldSkipSurfaceHit(obj) {
        if (!obj || !obj.isMesh) return true;
        let current = obj;
        while (current) {
            const ud = current.userData || null;
            if (ud?.annotationRoot || ud?.annotationLayer || ud?.annotationStroke) return true;
            if (ud?.excludeFromBounds || ud?.excludeFromExport || ud?.lightHelper) return true;
            if (ud?._isBackfaceOverlay) return true;
            if (ud?._geoId !== undefined || ud?._angle !== undefined) return true;
            if (ud?.isCollision) return true;

            const type = String(current.type || current.constructor?.name || '');
            if (type.endsWith('Helper')) return true;
            if (current.isHelper || current.isAxesHelper || current.isGridHelper || current.isPolarGridHelper) {
                return true;
            }

            const name = String(current.name || '');
            if (name.includes('(wireframe)') || name.includes('(beautywire)')) return true;
            current = current.parent;
        }
        return false;
    }

    function getSurfaceHitFromClient(clientX, clientY, rect) {
        if (!rect || !updateNdcFromClient(clientX, clientY, rect)) return null;
        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObjects(world.children, true);
        for (const hit of hits) {
            const obj = hit?.object;
            if (shouldSkipSurfaceHit(obj)) continue;
            let normal = null;
            if (hit?.face?.normal) {
                normal = tmpNormal.copy(hit.face.normal).transformDirection(obj.matrixWorld);
                if (normal.lengthSq() > 0) {
                    normal.normalize();
                    if (normal.dot(raycaster.ray.direction) > 0) {
                        normal.multiplyScalar(-1);
                    }
                } else {
                    normal = null;
                }
            }
            return {
                point: hit.point.clone(),
                normal: normal ? normal.clone() : null,
                distance: hit.distance,
                object: obj,
            };
        }
        return null;
    }

    function offsetSurfacePoint(point, normal, style) {
        if (!point) return null;
        return point.clone();
    }

    function getSurfacePointFromClient(clientX, clientY, rect, style) {
        const hit = getSurfaceHitFromClient(clientX, clientY, rect);
        if (!hit) return null;
        return {
            point: offsetSurfacePoint(hit.point, hit.normal, style),
            hit,
        };
    }

    function toPlaneCoords(point, planeState) {
        tmpVec2.copy(point).sub(planeState.origin);
        return {
            x: tmpVec2.dot(planeState.xAxis),
            y: tmpVec2.dot(planeState.yAxis),
        };
    }

    function fromPlaneCoords(x, y, planeState) {
        return planeState.origin.clone()
            .addScaledVector(planeState.xAxis, x)
            .addScaledVector(planeState.yAxis, y);
    }

    function getWorldPerPixel(distance, rect) {
        if (!rect) return 1;
        if (camera.isPerspectiveCamera) {
            const fov = MathUtils.degToRad(
                typeof camera.getEffectiveFOV === 'function' ? camera.getEffectiveFOV() : camera.fov
            );
            const height = 2 * Math.tan(fov * 0.5) * distance;
            return height / rect.height;
        }
        if (camera.isOrthographicCamera) {
            const height = (camera.top - camera.bottom) / (camera.zoom || 1);
            return height / rect.height;
        }
        return 1;
    }

    function makeStrokeStyle(planeState) {
        const rect = getViewRect();
        const worldPerPx = getWorldPerPixel(planeDistance, rect);
        const widthWorld = Math.max(0.0001, widthPx * worldPerPx);
        return {
            color,
            width: widthWorld,
            dash,
            planeState,
        };
    }

    function simplifyPoints(points, minDistance) {
        if (!Array.isArray(points) || points.length < 2) return points;
        const result = [points[0]];
        for (let i = 1; i < points.length; i++) {
            const prev = result[result.length - 1];
            if (prev.distanceTo(points[i]) >= minDistance) {
                result.push(points[i]);
            }
        }
        if (result.length === 1 && points.length > 1) result.push(points[points.length - 1]);
        return result;
    }

    function getSurfaceSampleStepPx() {
        return Math.max(6, Math.min(24, widthPx * 2));
    }

    function sampleClientLinePoints(a, b, stepPx) {
        const points = [];
        if (!a || !b) return points;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        if (!Number.isFinite(length) || length <= 0) {
            points.push({ x: a.x, y: a.y });
            return points;
        }
        const steps = Math.max(1, Math.ceil(length / Math.max(1, stepPx)));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            points.push({ x: a.x + dx * t, y: a.y + dy * t });
        }
        return points;
    }

    function sampleClientRectPoints(a, b, stepPx) {
        if (!a || !b) return [];
        const minX = Math.min(a.x, b.x);
        const maxX = Math.max(a.x, b.x);
        const minY = Math.min(a.y, b.y);
        const maxY = Math.max(a.y, b.y);
        const tl = { x: minX, y: minY };
        const tr = { x: maxX, y: minY };
        const br = { x: maxX, y: maxY };
        const bl = { x: minX, y: maxY };
        const points = [];
        const edge1 = sampleClientLinePoints(tl, tr, stepPx);
        const edge2 = sampleClientLinePoints(tr, br, stepPx);
        const edge3 = sampleClientLinePoints(br, bl, stepPx);
        const edge4 = sampleClientLinePoints(bl, tl, stepPx);
        points.push(...edge1);
        points.push(...edge2.slice(1));
        points.push(...edge3.slice(1));
        points.push(...edge4.slice(1));
        return points;
    }

    function sampleClientCirclePoints(center, edge, stepPx) {
        if (!center || !edge) return [];
        const dx = edge.x - center.x;
        const dy = edge.y - center.y;
        const radius = Math.hypot(dx, dy);
        if (!Number.isFinite(radius) || radius <= 0) {
            return [{ x: center.x, y: center.y }];
        }
        const circumference = 2 * Math.PI * radius;
        const steps = Math.max(24, Math.ceil(circumference / Math.max(1, stepPx)));
        const points = [];
        for (let i = 0; i <= steps; i++) {
            const t = (i / steps) * Math.PI * 2;
            points.push({
                x: center.x + Math.cos(t) * radius,
                y: center.y + Math.sin(t) * radius,
            });
        }
        return points;
    }

    function projectClientPointsToSurface(clientPoints, rect, style) {
        if (!rect || !Array.isArray(clientPoints) || !clientPoints.length) return [];
        const points = [];
        for (const pt of clientPoints) {
            const hit = getSurfaceHitFromClient(pt.x, pt.y, rect);
            if (!hit) continue;
            const worldPoint = offsetSurfacePoint(hit.point, hit.normal, style);
            if (worldPoint) points.push(worldPoint);
        }
        const minDist = Math.max(style?.width * 0.4 || 0, 0.001);
        return simplifyPoints(points, minDist);
    }

    function ensureClosedPoints(points) {
        if (!Array.isArray(points) || points.length < 2) return points;
        const first = points[0];
        const last = points[points.length - 1];
        if (first.distanceTo(last) > 1e-5) points.push(first.clone());
        return points;
    }

    function getDashPattern(style) {
        const w = Math.max(0.0001, style.width);
        if (style.dash === 'dashed') return { on: w * 6, off: w * 3 };
        if (style.dash === 'dotted') return { on: w * 1.5, off: w * 2.5 };
        return null;
    }

    function splitPolyline(points, pattern) {
        if (!pattern || !Array.isArray(points) || points.length < 2) return [points];
        const segments = [];
        let draw = true;
        let remaining = pattern.on;
        let current = [];

        for (let i = 0; i < points.length - 1; i++) {
            let a = points[i].clone();
            const b = points[i + 1].clone();
            let segLen = a.distanceTo(b);
            if (segLen <= 0) continue;
            while (segLen > 0) {
                const step = Math.min(segLen, remaining);
                const t = step / segLen;
                const end = a.clone().lerp(b, t);
                if (draw) {
                    if (!current.length) current.push(a.clone());
                    current.push(end.clone());
                }
                segLen -= step;
                a = end;
                remaining -= step;
                if (remaining <= 0) {
                    if (draw && current.length >= 2) segments.push(current);
                    current = [];
                    draw = !draw;
                    remaining = draw ? pattern.on : pattern.off;
                }
            }
        }
        if (draw && current.length >= 2) segments.push(current);
        return segments;
    }

    function createTubeGeometry(points, radius) {
        const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.5);
        const segments = Math.max(2, Math.round(points.length * 3));
        return new THREE.TubeGeometry(curve, segments, radius, 4, false);
    }

    function toLocalPoints(points) {
        if (!Array.isArray(points)) return [];
        if (!annotationsRoot?.worldToLocal) return points.map((pt) => pt.clone());
        annotationsRoot.updateMatrixWorld(true);
        return points.map((pt) => annotationsRoot.worldToLocal(pt.clone()));
    }

    function toLocalPoint(point) {
        if (!point) return null;
        if (!annotationsRoot?.worldToLocal) return point.clone();
        annotationsRoot.updateMatrixWorld(true);
        return annotationsRoot.worldToLocal(point.clone());
    }

    function buildStrokeObject(points, style, markStroke = true) {
        if (!Array.isArray(points) || points.length < 2) return null;
        const localPoints = toLocalPoints(points);
        const pattern = getDashPattern(style);
        const segments = splitPolyline(localPoints, pattern);
        const group = new THREE.Group();
        if (markStroke) group.userData.annotationStroke = true;
        group.userData.strokeStyle = { color: style.color, width: style.width, dash: style.dash };

        const material = new THREE.MeshBasicMaterial({
            color: new THREE.Color(style.color),
            transparent: true,
            opacity: 1,
        });

        segments.forEach((segment) => {
            if (!segment || segment.length < 2) return;
            const geometry = createTubeGeometry(segment, style.width * 0.5);
            const mesh = new THREE.Mesh(geometry, material);
            if (markStroke) mesh.userData.annotationStroke = true;
            group.add(mesh);
        });
        return group;
    }

    function resolveShapePoints(shape) {
        if (!shape) return null;
        if (shape.type === 'path') {
            const widthValue = Number.isFinite(shape.style?.width) ? shape.style.width : widthPx;
            return simplifyPoints(shape.points || [], widthValue * 0.4);
        }
        if (shape.type === 'line') {
            if (!shape.a || !shape.b) return null;
            return [shape.a, shape.b];
        }
        if (shape.mode === 'surface') {
            const rect = getViewRect();
            if (!rect) return null;
            const stepPx = getSurfaceSampleStepPx();
            let clientPoints = null;
            if (shape.type === 'line') {
                clientPoints = sampleClientLinePoints(shape.startClient, shape.endClient, stepPx);
            } else if (shape.type === 'rect') {
                clientPoints = sampleClientRectPoints(shape.startClient, shape.endClient, stepPx);
            } else if (shape.type === 'circle') {
                clientPoints = sampleClientCirclePoints(shape.startClient, shape.endClient, stepPx);
            }
            const points = projectClientPointsToSurface(clientPoints, rect, shape.style);
            if (shape.type === 'rect' || shape.type === 'circle') ensureClosedPoints(points);
            return points;
        }
        if (shape.type === 'circle') {
            const plane = shape.plane || shape.style?.planeState;
            if (!plane) return null;
            const segments = 48;
            const center = toPlaneCoords(shape.c, plane);
            const points = [];
            for (let i = 0; i <= segments; i++) {
                const t = (i / segments) * Math.PI * 2;
                const x = center.x + Math.cos(t) * shape.r;
                const y = center.y + Math.sin(t) * shape.r;
                points.push(fromPlaneCoords(x, y, plane));
            }
            return points;
        }
        if (shape.type === 'rect') {
            const plane = shape.plane || shape.style?.planeState;
            if (!plane) return null;
            const a2 = toPlaneCoords(shape.a, plane);
            const b2 = toPlaneCoords(shape.b, plane);
            const minX = Math.min(a2.x, b2.x);
            const maxX = Math.max(a2.x, b2.x);
            const minY = Math.min(a2.y, b2.y);
            const maxY = Math.max(a2.y, b2.y);
            return [
                fromPlaneCoords(minX, minY, plane),
                fromPlaneCoords(maxX, minY, plane),
                fromPlaneCoords(maxX, maxY, plane),
                fromPlaneCoords(minX, maxY, plane),
            ];
        }
        return null;
    }

    function makeShapeRecord(shape, layer) {
        if (!shape || !shape.style) return null;
        const points = resolveShapePoints(shape);
        if (!Array.isArray(points) || points.length < 2) return null;
        return {
            kind: shape.type,
            payload: {
                kind: shape.type,
                points: points.map((pt) => vecToArray(toStoredPoint(pt))),
                style: serializeStyle(shape.style),
                layerId: layer?.id || null,
                layerName: layer?.name || null,
                coordSpace: 'world',
            },
        };
    }

    function makeRectRecord(rect, style, settings, layer) {
        if (!rect || !style) return null;
        return {
            kind: 'rect',
            payload: {
                kind: 'rect',
                corners: rect.corners.map((pt) => vecToArray(toStoredPoint(pt))),
                width: rect.width,
                height: rect.height,
                normal: rect.normal ? vecToArray(rect.normal) : null,
                style: serializeStyle(style),
                settings: {
                    color: settings?.color || style.color,
                    fill: settings?.fill || 'none',
                    info: settings?.info || 'none',
                    text: settings?.text || '',
                    labelText: settings?.labelText || '',
                    area: rect.width * rect.height,
                },
                layerId: layer?.id || null,
                layerName: layer?.name || null,
                coordSpace: 'world',
            },
        };
    }

    function makePinRecord(rect, style, settings, layer, cameraSnapshot) {
        if (!rect || !style) return null;
        return {
            kind: 'pin',
            payload: {
                kind: 'pin',
                corners: rect.corners.map((pt) => vecToArray(toStoredPoint(pt))),
                width: rect.width,
                height: rect.height,
                normal: rect.normal ? vecToArray(rect.normal) : null,
                style: serializeStyle(style),
                settings: {
                    color: settings?.color || style.color,
                    text: settings?.text || '',
                    labelText: settings?.text || '',
                },
                camera: cameraSnapshot || null,
                layerId: layer?.id || null,
                layerName: layer?.name || null,
                coordSpace: 'world',
            },
        };
    }

    function formatAreaLabel(area) {
        const value = Number(area);
        if (!Number.isFinite(value)) return '—';
        let fixed = value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
        fixed = fixed.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
        return fixed;
    }

    function captureCameraSnapshot() {
        if (!camera || !controls) return null;
        const view = camera.view;
        const fullWidth = Number.isFinite(view?.fullWidth) ? view.fullWidth : 1;
        const fullHeight = Number.isFinite(view?.fullHeight) ? view.fullHeight : 1;
        const offsetX = Number.isFinite(view?.offsetX) ? view.offsetX : 0;
        const offsetY = Number.isFinite(view?.offsetY) ? view.offsetY : 0;
        return {
            position: camera.position?.toArray?.() || [0, 0, 0],
            target: controls.target?.toArray?.() || [0, 0, 0],
            up: camera.up?.toArray?.() || [0, 1, 0],
            fov: camera.fov,
            zoom: camera.zoom,
            near: camera.near,
            far: camera.far,
            shiftX: fullWidth ? offsetX / fullWidth : 0,
            shiftY: fullHeight ? offsetY / fullHeight : 0,
        };
    }

    function computeRectFromThreePoints(a, b, c) {
        if (!a || !b || !c) return null;
        const u = tmpVec.copy(a).sub(b);
        const v = tmpVec2.copy(c).sub(b);
        const uLenSq = u.lengthSq();
        const vLenSq = v.lengthSq();
        if (uLenSq < 1e-10 || vLenSq < 1e-10) return null;

        const uNorm = u.clone().normalize();
        const vPerp = v.clone().sub(uNorm.clone().multiplyScalar(v.dot(uNorm)));
        if (vPerp.lengthSq() < 1e-10) return null;

        const cAdj = b.clone().add(vPerp);
        const d = a.clone().add(vPerp);
        const normal = u.clone().cross(vPerp).normalize();
        const width = u.length();
        const height = vPerp.length();

        return {
            corners: [a.clone(), b.clone(), cAdj, d],
            normal,
            width,
            height,
        };
    }

    function computePinRectFromMidpoints(a, b, normal, cameraPos) {
        if (!a || !b || !normal) return null;
        const axis = tmpVec.copy(a).sub(b);
        const length = axis.length();
        if (!Number.isFinite(length) || length <= 1e-6) return null;
        const n = normal.clone().normalize();
        const center = tmpVec2.copy(a).add(b).multiplyScalar(0.5);
        if (cameraPos && cameraPos.isVector3) {
            const toCam = tmpVec3.copy(cameraPos).sub(center);
            if (toCam.dot(n) < 0) {
                n.multiplyScalar(-1);
            }
        }
        const u = axis.clone().normalize();
        const side = tmpVec2.copy(n).cross(u);
        if (side.lengthSq() < 1e-10) return null;
        side.normalize();
        const half = length * 0.5;
        const topRight = a.clone().addScaledVector(side, half);
        const topLeft = a.clone().addScaledVector(side, -half);
        const bottomLeft = b.clone().addScaledVector(side, -half);
        const bottomRight = b.clone().addScaledVector(side, half);
        const offset = n.clone().multiplyScalar(length * 0.08);
        topRight.add(offset);
        topLeft.add(offset);
        bottomLeft.add(offset);
        bottomRight.add(offset);
        return {
            corners: [topLeft, topRight, bottomRight, bottomLeft],
            normal: n,
            width: length,
            height: length,
        };
    }

    function buildRectPreviewStroke(points, preview, style) {
        if (!Array.isArray(points) || !points.length) return null;
        if (points.length === 1) {
            if (!preview) return null;
            return buildStrokeObject([points[0], preview], style, false);
        }
        if (points.length >= 2) {
            if (!preview && points.length < 3) {
                return buildStrokeObject([points[0], points[1]], style, false);
            }
            const c = preview || points[2];
            const rect = computeRectFromThreePoints(points[0], points[1], c);
            if (!rect) return null;
            return buildRectEdgesGroup(rect.corners, style, false);
        }
        return null;
    }

    function buildRectEdgesGroup(corners, style, markStroke = true) {
        if (!Array.isArray(corners) || corners.length < 4) return null;
        const group = new THREE.Group();
        if (markStroke) group.userData.annotationStroke = true;
        group.userData.strokeStyle = { color: style.color, width: style.width, dash: style.dash };

        for (let i = 0; i < 4; i++) {
            const a = corners[i];
            const b = corners[(i + 1) % 4];
            const edge = buildStrokeObject([a, b], style, false);
            if (edge) group.add(edge);
        }

        return group;
    }

    function makeHatchTexture(hexColor) {
        if (typeof document === 'undefined' || !THREE) return null;
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.clearRect(0, 0, size, size);
        ctx.strokeStyle = hexColor || '#ffcc00';
        ctx.lineWidth = 4;
        ctx.globalAlpha = 0.7;

        const step = 16;
        for (let i = -size; i <= size * 2; i += step) {
            ctx.beginPath();
            ctx.moveTo(i, 0);
            ctx.lineTo(i + size, size);
            ctx.stroke();
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.needsUpdate = true;
        return tex;
    }

    function createRectFillMesh(rect, style, settings) {
        if (!rect || !rect.corners) return null;
        const fillType = String(settings?.fill || 'none');
        if (fillType === 'none') return null;
        if (!THREE) return null;

        const corners = toLocalPoints(rect.corners);
        if (corners.length < 4) return null;
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array([
            corners[0].x, corners[0].y, corners[0].z,
            corners[1].x, corners[1].y, corners[1].z,
            corners[2].x, corners[2].y, corners[2].z,
            corners[3].x, corners[3].y, corners[3].z,
        ]);
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
            0, 0,
            1, 0,
            1, 1,
            0, 1,
        ]), 2));
        geometry.computeVertexNormals();

        const baseColor = new THREE.Color(String(settings?.color || style?.color || '#ffcc00'));
        const materialOpts = {
            color: baseColor,
            transparent: true,
            opacity: fillType === 'solid' ? 0.25 : 0.4,
            side: THREE.DoubleSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
        };

        if (fillType === 'hatch') {
            const tex = makeHatchTexture(baseColor.getStyle());
            if (tex) {
                const repeatX = Math.max(1, Math.min(20, rect.width / 2));
                const repeatY = Math.max(1, Math.min(20, rect.height / 2));
                tex.repeat.set(repeatX, repeatY);
                materialOpts.map = tex;
                materialOpts.color = new THREE.Color(0xffffff);
            }
        }

        const material = new THREE.MeshBasicMaterial(materialOpts);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.annotationFill = true;
        mesh.renderOrder = -1;
        return mesh;
    }

    function createRectLabelSprite(text, rect, settings) {
        if (!text || !rect || typeof document === 'undefined' || !THREE) return null;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        const fontSize = 42;
        const padding = 14;
        const labelText = String(text);
        ctx.font = `600 ${fontSize}px sans-serif`;
        const metrics = ctx.measureText(labelText);
        const width = Math.ceil(metrics.width + padding * 2);
        const height = Math.ceil(fontSize + padding * 2);
        canvas.width = width;
        canvas.height = height;

        ctx.font = `600 ${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = String(settings?.color || '#ffffff');
        ctx.fillText(labelText, width / 2, height / 2);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;

        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
        });
        const sprite = new THREE.Sprite(material);

        const base = Math.max(rect.width || 0, rect.height || 0);
        const spriteHeight = Math.max(0.2, base * 0.12);
        const spriteWidth = spriteHeight * (width / height);
        sprite.scale.set(spriteWidth, spriteHeight, 1);

        const center = rect.corners.reduce((acc, p) => acc.add(p.clone()), new THREE.Vector3()).multiplyScalar(0.25);
        const offset = rect.normal ? rect.normal.clone().multiplyScalar(Math.max(0.01, base * 0.02)) : new THREE.Vector3();
        const pos = center.add(offset);
        const localPos = toLocalPoint(pos);
        if (localPos) sprite.position.copy(localPos);

        sprite.userData.annotationLabel = true;
        sprite.renderOrder = 2;
        return sprite;
    }

    function buildRectangleAnnotation(rect, style, settings) {
        if (!rect || !style) return null;
        const group = new THREE.Group();
        group.userData.annotationStroke = true;
        group.userData.annotationRect = {
            color: settings?.color || style.color,
            fill: settings?.fill || 'none',
            info: settings?.info || 'none',
            text: settings?.text || '',
            labelText: settings?.labelText || '',
            area: rect.width * rect.height,
        };

        const edges = buildRectEdgesGroup(rect.corners, style, false);
        if (edges) group.add(edges);

        const fill = createRectFillMesh(rect, style, settings);
        if (fill) group.add(fill);

        const label = createRectLabelSprite(settings?.labelText, rect, settings);
        if (label) group.add(label);

        return group;
    }

    function createPinFillMesh(rect, colorValue) {
        if (!rect || !rect.corners || !THREE) return null;
        const corners = toLocalPoints(rect.corners);
        if (corners.length < 4) return null;
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array([
            corners[0].x, corners[0].y, corners[0].z,
            corners[1].x, corners[1].y, corners[1].z,
            corners[2].x, corners[2].y, corners[2].z,
            corners[3].x, corners[3].y, corners[3].z,
        ]);
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        geometry.computeVertexNormals();
        const baseColor = new THREE.Color(String(colorValue || '#ffcc00'));
        const material = new THREE.MeshBasicMaterial({
            color: baseColor,
            transparent: false,
            opacity: 1,
            side: THREE.DoubleSide,
            depthTest: true,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -4,
            polygonOffsetUnits: -4,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.annotationFill = true;
        mesh.renderOrder = 5;
        return mesh;
    }

    function buildPinAnnotation(rect, style, settings) {
        if (!rect || !style) return null;
        const group = new THREE.Group();
        group.userData.annotationStroke = true;
        group.userData.annotationPin = true;
        const fillColor = settings?.color || style.color;
        const fill = createPinFillMesh(rect, fillColor);
        if (fill) group.add(fill);
        const label = createRectLabelSprite(String(settings?.text || '').trim(), rect, {
            color: '#ffffff',
        });
        if (label) group.add(label);
        return group;
    }

    function getWebGPUDevice() {
        if (!renderer) return null;
        if (renderer.device) return renderer.device;
        if (typeof renderer.getDevice === 'function') {
            try {
                return renderer.getDevice();
            } catch (_) {
                return null;
            }
        }
        const backend = renderer.backend || renderer._backend || null;
        if (backend?.device) return backend.device;
        if (typeof backend?.getDevice === 'function') {
            try {
                return backend.getDevice();
            } catch (_) {
                return null;
            }
        }
        return renderer._device || null;
    }

    function getWebGPUQueue() {
        const device = getWebGPUDevice();
        return device?.queue || null;
    }

    function shouldDeferDispose() {
        if (!renderer) return false;
        if (renderer.isWebGPURenderer) return true;
        return !!getWebGPUQueue()?.onSubmittedWorkDone;
    }

    function getRenderFrame() {
        const frame = Number(renderer?.info?.render?.frame);
        return Number.isFinite(frame) ? frame : null;
    }

    function disposeObjectNow(obj) {
        if (!obj) return;
        const disposedGeometries = new Set();
        const disposedMaterials = new Set();
        obj.traverse?.((child) => {
            const geometry = child?.geometry || null;
            if (geometry?.dispose && !disposedGeometries.has(geometry)) {
                disposedGeometries.add(geometry);
                geometry.dispose();
            }
            if (child?.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach((mat) => {
                        if (!mat?.dispose || disposedMaterials.has(mat)) return;
                        disposedMaterials.add(mat);
                        mat.dispose();
                    });
                } else if (child.material.dispose && !disposedMaterials.has(child.material)) {
                    disposedMaterials.add(child.material);
                    child.material.dispose();
                }
            }
        });
    }

    function flushDisposals(force = false) {
        if (!pendingDisposals.size) return;
        if (!force && (pointerId != null || !!draft || rectModalOpen)) return;
        const now = Date.now();
        const frameNow = getRenderFrame();
        const minAgeMs = 5000;
        const minDraftAgeMs = 10000;
        const minFrameGap = 16;
        const minDraftFrameGap = 30;
        const items = Array.from(pendingDisposals.entries());
        items.forEach(([item, meta]) => {
            const queuedAt = Number(meta?.queuedAt || 0);
            const queuedFrame = Number.isFinite(meta?.queuedFrame) ? meta.queuedFrame : null;
            const isDraft = meta?.reason === 'draft';
            const ageMs = now - queuedAt;
            const requiredAge = isDraft ? minDraftAgeMs : minAgeMs;
            const requiredFrameGap = isDraft ? minDraftFrameGap : minFrameGap;
            if (!force && ageMs < requiredAge) return;
            if (!force && frameNow != null && queuedFrame != null && (frameNow - queuedFrame) < requiredFrameGap) return;
            pendingDisposals.delete(item);
            disposeObjectNow(item);
        });
    }

    function waitFrames(count, cb) {
        if (!raf || count <= 0) {
            cb();
            return;
        }
        let remaining = count;
        const step = () => {
            remaining -= 1;
            if (remaining <= 0) {
                cb();
                return;
            }
            raf(step);
        };
        raf(step);
    }

    function scheduleDisposeFlush() {
        if (disposeScheduled) return;
        disposeScheduled = true;
        const finalize = () => {
            disposeScheduled = false;
            flushDisposals();
            if (pendingDisposals.size) scheduleDisposeFlush();
        };
        waitFrames(6, () => {
            const queue = getWebGPUQueue();
            if (queue?.onSubmittedWorkDone) {
                queue
                    .onSubmittedWorkDone()
                    .then(() => waitFrames(2, () => {
                        queue
                            .onSubmittedWorkDone()
                            .then(() => waitFrames(2, finalize))
                            .catch(() => waitFrames(8, finalize));
                    }))
                    .catch(() => waitFrames(8, finalize));
                return;
            }
            waitFrames(8, finalize);
        });
    }

    function disposeObject(obj, reason = 'stroke') {
        if (!obj) return;
        if (reason === 'draft' && shouldDeferDispose()) {
            // Draft meshes churn every pointer move; explicit dispose in WebGPU can race with queued submits.
            // For drafts we prefer dropping references and letting GC reclaim them.
            return;
        }
        if (shouldDeferDispose()) {
            pendingDisposals.set(obj, {
                queuedAt: Date.now(),
                queuedFrame: getRenderFrame(),
                reason,
            });
            scheduleDisposeFlush();
            return;
        }
        disposeObjectNow(obj);
    }

    function getActiveLayer() {
        return activeLayerId ? layers.find((l) => l.id === activeLayerId) : null;
    }

    function getLayerById(id) {
        if (!id) return null;
        return layers.find((l) => l.id === id) || null;
    }

    function syncLayerSelect() {
        if (!annoLayerSelectEl) return;
        annoLayerSelectEl.innerHTML = '';
        layers.forEach((layer) => {
            const option = document.createElement('option');
            option.value = layer.id;
            option.textContent = layer.name;
            annoLayerSelectEl.appendChild(option);
        });
        if (activeLayerId) annoLayerSelectEl.value = activeLayerId;
    }

    function createLayer(name, forcedId = null, makeActive = true) {
        const layerName = String(name || '').trim() || `Layer ${layers.length + 1}`;
        const group = new THREE.Group();
        group.name = layerName;
        group.userData.annotationLayer = true;
        annotationsRoot.add(group);
        const layer = {
            id: forcedId || makeId(),
            name: layerName,
            group,
            strokes: [],
        };
        layers.push(layer);
        if (makeActive) activeLayerId = layer.id;
        syncLayerSelect();
        return layer;
    }

    function ensureLayer(id, name, makeActive = true) {
        if (id) {
            const existing = layers.find((layer) => layer.id === id);
            if (existing) return existing;
        }
        return createLayer(name, id || null, makeActive);
    }

    createLayer('Layer 1');

    function setActiveLayer(id) {
        if (!id) return;
        const layer = layers.find((l) => l.id === id);
        if (!layer) return;
        activeLayerId = layer.id;
        syncLayerSelect();
    }

    function registerStrokeAnnotation(stroke, annotationId) {
        if (!stroke || !annotationId) return;
        stroke.userData.annotationId = annotationId;
        strokesById.set(annotationId, stroke);
    }

    function addStrokeToLayer(stroke, layer, options = {}) {
        if (!stroke || !layer) return;
        layer.group.add(stroke);
        layer.strokes.push(stroke);
        if (!options.skipUndo) {
            undoStack.push({ layerId: layer.id, stroke });
        }
        if (options.annotationId) {
            registerStrokeAnnotation(stroke, options.annotationId);
        }
        applyAuthorVisibilityToStroke(stroke);
        requestRender();
    }

    function isPinStroke(stroke) {
        return !!stroke?.userData?.annotationPin;
    }

    function getAuthorVisibility(authorId) {
        if (!authorId) return true;
        const value = authorVisibility.get(authorId);
        return value !== false;
    }

    function applyAuthorVisibilityToStroke(stroke) {
        const authorId = stroke?.userData?.authorId || null;
        if (!authorId) return;
        const visible = isPinStroke(stroke)
            ? getPinVisibility(authorId)
            : getAuthorVisibility(authorId);
        stroke.visible = visible;
    }

    function getPinVisibility(authorId) {
        if (!authorId) return true;
        const value = pinAuthorVisibility.get(authorId);
        return value !== false;
    }

    function refreshAuthorVisibility(authorId) {
        if (!authorId) return;
        if (!authorVisibility.has(authorId)) return;
        layers.forEach((layer) => {
            layer.strokes.forEach((stroke) => {
                if (stroke?.userData?.authorId === authorId) {
                    if (isPinStroke(stroke)) return;
                    applyAuthorVisibilityToStroke(stroke);
                }
            });
        });
        requestRender();
    }

    function refreshPinVisibility(authorId) {
        if (!authorId) return;
        if (!pinAuthorVisibility.has(authorId)) return;
        layers.forEach((layer) => {
            layer.strokes.forEach((stroke) => {
                if (stroke?.userData?.authorId === authorId) {
                    if (!isPinStroke(stroke)) return;
                    applyAuthorVisibilityToStroke(stroke);
                }
            });
        });
        requestRender();
    }

    function removeStroke(stroke, options = {}) {
        if (!stroke) return;
        const root = getStrokeRoot(stroke) || stroke;
        if (!options.force && canRemoveStroke && !canRemoveStroke(root)) {
            return false;
        }
        const layer = layers.find((l) => l.strokes.includes(root));
        if (layer) {
            const idx = layer.strokes.indexOf(root);
            if (idx >= 0) layer.strokes.splice(idx, 1);
        }
        if (root.parent) root.parent.remove(root);
        const undoIndex = undoStack.findIndex((entry) => entry.stroke === root);
        if (undoIndex >= 0) undoStack.splice(undoIndex, 1);
        const annotationId = root.userData?.annotationId;
        if (annotationId) strokesById.delete(annotationId);
        disposeObject(root, 'stroke');
        if (!options.skipNotify && onStrokeRemoved) {
            onStrokeRemoved({ stroke: root, annotationId: annotationId || null });
        }
        requestRender();
        return true;
    }

    function getStrokeRoot(obj) {
        let current = obj;
        let found = null;
        while (current) {
            if (current.userData?.annotationStroke && !current.userData?.excludeFromExport) {
                found = current;
            }
            current = current.parent;
        }
        return found;
    }

    function isStrokeRemovable(stroke) {
        const root = getStrokeRoot(stroke) || stroke;
        if (!root) return false;
        if (!canRemoveStroke) return true;
        return !!canRemoveStroke(root);
    }

    function pickStroke(e, options = {}) {
        const removableOnly = !!options.removableOnly;
        const rect = getViewRect();
        if (!rect || !updateNdcFromEvent(e, rect)) return null;
        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObjects(annotationsRoot.children, true);
        for (const hit of hits) {
            const stroke = getStrokeRoot(hit.object);
            if (!stroke) continue;
            if (removableOnly && !isStrokeRemovable(stroke)) continue;
            return stroke;
        }
        return null;
    }

    function beginStroke(e) {
        if (!drawEnabled) return;
        if (e.button !== 0) return;
        if (pointerId != null) return;
        if (rectModalOpen || isAnyModalOpen()) return;

        if (tool === 'eraser') {
            pointerId = e.pointerId;
            const hit = pickStroke(e, { removableOnly: true });
            if (hit && hit.uuid !== lastEraseId) {
                if (removeStroke(hit)) {
                    lastEraseId = hit.uuid;
                }
            }
            ensurePointerCapture(e);
            setControlsEnabled(false);
            return;
        }

        if (tool === 'pin') {
            const layer = getActiveLayer();
            if (!layer) return;
            const rect = getViewRect();
            const surfaceHit = rect ? getSurfaceHitFromClient(e.clientX, e.clientY, rect) : null;
            if (!surfaceHit) return;
            planeDistance = Math.max(0.1, surfaceHit.distance);
            let style = makeStrokeStyle(null);
            style = { ...style, dash: 'solid' };
            const point = offsetSurfacePoint(surfaceHit.point, surfaceHit.normal, style);
            draft = {
                type: 'pin',
                mode: 'surface',
                a: point,
                b: point,
                normal: surfaceHit.normal.clone(),
                style,
                layerId: layer.id,
                camera: captureCameraSnapshot(),
            };
            pointerId = e.pointerId;
            ensurePointerCapture(e);
            setControlsEnabled(false);
            updateDraftGeometry();
            return;
        }

        if (tool === 'rect') {
            const layer = getActiveLayer();
            if (!layer) return;
            const rectDraft = draft && draft.type === 'rect' ? draft : null;
            const rect = getViewRect();
            let mode = rectDraft?.mode || null;
            let planeState = rectDraft?.plane || null;
            let style = rectDraft?.style || null;
            let point = null;

            if (mode === 'surface') {
                const surfaceHit = rect ? getSurfaceHitFromClient(e.clientX, e.clientY, rect) : null;
                if (!surfaceHit) return;
                if (!style) style = makeStrokeStyle(null);
                point = offsetSurfacePoint(surfaceHit.point, surfaceHit.normal, style);
            } else if (!mode || mode === 'surface') {
                const surfaceHit = rect ? getSurfaceHitFromClient(e.clientX, e.clientY, rect) : null;
                if (surfaceHit) {
                    mode = 'surface';
                    planeDistance = Math.max(0.1, surfaceHit.distance);
                    if (!style) style = makeStrokeStyle(null);
                    point = offsetSurfacePoint(surfaceHit.point, surfaceHit.normal, style);
                } else {
                    mode = 'plane';
                }
            }

            if (!point) {
                if (!planeState) planeState = getPlaneState();
                point = getPointOnPlane(e, planeState);
                if (!point) return;
                if (!style) style = makeStrokeStyle(planeState);
            }

            if (!rectDraft) {
                draft = {
                    type: 'rect',
                    mode: mode || 'plane',
                    style,
                    points: [],
                    preview: point,
                    plane: planeState || null,
                    layerId: layer.id,
                };
            } else {
                rectDraft.mode = mode || rectDraft.mode || 'plane';
                rectDraft.style = style || rectDraft.style;
                rectDraft.preview = point;
                if (planeState && !rectDraft.plane) rectDraft.plane = planeState;
                draft = rectDraft;
            }

            pointerId = e.pointerId;
            ensurePointerCapture(e);
            setControlsEnabled(false);
            updateDraftGeometry();
            return;
        }

        const layer = getActiveLayer();
        if (!layer) return;
        const rect = getViewRect();
        const surfaceHit = rect ? getSurfaceHitFromClient(e.clientX, e.clientY, rect) : null;

        let planeState = null;
        let point = null;
        let style = null;
        let mode = 'plane';

        if (surfaceHit) {
            planeDistance = Math.max(0.1, surfaceHit.distance);
            style = makeStrokeStyle(null);
            point = offsetSurfacePoint(surfaceHit.point, surfaceHit.normal, style);
            mode = 'surface';
        } else {
            planeState = getPlaneState();
            point = getPointOnPlane(e, planeState);
            if (!point) return;
            style = makeStrokeStyle(planeState);
        }

        pointerId = e.pointerId;
        ensurePointerCapture(e);
        setControlsEnabled(false);
        const startClient = { x: e.clientX, y: e.clientY };

        if (tool === 'pencil') {
            draft = { type: 'path', points: [point], style, mode };
        } else if (tool === 'line') {
            if (mode === 'surface') {
                draft = { type: 'line', a: point, b: point, style, mode };
            } else {
                draft = { type: 'line', a: point, b: point, style, mode, plane: planeState };
            }
        } else if (tool === 'rect') {
            if (mode === 'surface') {
                draft = { type: 'rect', style, mode, startClient, endClient: { ...startClient } };
            } else {
                draft = { type: 'rect', a: point, b: point, style, mode, plane: planeState };
            }
        } else if (tool === 'circle') {
            if (mode === 'surface') {
                draft = { type: 'circle', style, mode, startClient, endClient: { ...startClient } };
            } else {
                draft = { type: 'circle', c: point, r: 0, style, mode, plane: planeState };
            }
        }
        updateDraftGeometry();
    }

    function moveStroke(e) {
        if (!drawEnabled || !draft || pointerId == null || e.pointerId !== pointerId) return;
        if (draft.type === 'pin') {
            const rect = getViewRect();
            const surfacePoint = rect ? getSurfacePointFromClient(e.clientX, e.clientY, rect, draft.style) : null;
            if (!surfacePoint) return;
            draft.b = surfacePoint.point;
            updateDraftGeometry();
            return;
        }
        if (draft.type === 'rect') {
            const rect = getViewRect();
            let point = null;
            if (draft.mode === 'surface') {
                const surfacePoint = rect ? getSurfacePointFromClient(e.clientX, e.clientY, rect, draft.style) : null;
                if (!surfacePoint) return;
                point = surfacePoint.point;
            } else {
                const planeState = draft.plane || getPlaneState();
                point = getPointOnPlane(e, planeState);
                if (!point) return;
            }
            draft.preview = point;
            updateDraftGeometry();
            return;
        }
        if (draft.mode === 'surface') {
            const rect = getViewRect();
            if (!rect) return;
            if (draft.type === 'path') {
                const surfacePoint = getSurfacePointFromClient(e.clientX, e.clientY, rect, draft.style);
                if (!surfacePoint) return;
                const point = surfacePoint.point;
                const last = draft.points[draft.points.length - 1];
                const minDist = Math.max(draft.style.width * 0.4, 0.001);
                if (!last || last.distanceTo(point) >= minDist) {
                    draft.points.push(point);
                }
            } else if (draft.type === 'line') {
                const surfacePoint = getSurfacePointFromClient(e.clientX, e.clientY, rect, draft.style);
                if (!surfacePoint) return;
                draft.b = surfacePoint.point;
            } else {
                const hit = getSurfaceHitFromClient(e.clientX, e.clientY, rect);
                if (!hit) return;
                draft.endClient = { x: e.clientX, y: e.clientY };
            }
            updateDraftGeometry();
            return;
        }

        const planeState = draft.style?.planeState || draft.plane || getPlaneState();
        const point = getPointOnPlane(e, planeState);
        if (!point) return;

        if (draft.type === 'path') {
            const last = draft.points[draft.points.length - 1];
            const minDist = Math.max(draft.style.width * 0.4, 0.001);
            if (!last || last.distanceTo(point) >= minDist) {
                draft.points.push(point);
            }
        } else if (draft.type === 'line' || draft.type === 'rect') {
            draft.b = point;
        } else if (draft.type === 'circle') {
            draft.r = draft.c.distanceTo(point);
        }
        updateDraftGeometry();
    }

    function commitRectPoint(e) {
        const rectDraft = draft;
        if (!rectDraft || rectDraft.type !== 'rect') return false;

        const point = rectDraft.preview;
        rectDraft.preview = null;
        if (point) {
            if (!Array.isArray(rectDraft.points)) rectDraft.points = [];
            rectDraft.points.push(point);
        }

        pointerId = null;
        releasePointerCapture(e);
        setControlsEnabled(true);

        if (!Array.isArray(rectDraft.points) || rectDraft.points.length < 3) {
            updateDraftGeometry();
            return true;
        }

        const rect = computeRectFromThreePoints(rectDraft.points[0], rectDraft.points[1], rectDraft.points[2]);
        if (!rect) {
            draft = null;
            clearDraft();
            return true;
        }

        updateDraftGeometry();
        rectModalOpen = true;
        const area = rect.width * rect.height;
        const baseColor = rectDraft.style?.color || color;

        void (async () => {
            const settings = promptRectSettings
                ? await Promise.resolve(promptRectSettings({
                    color: baseColor,
                    fill: 'hatch',
                    info: 'area',
                    area,
                    text: '',
                }))
                : {
                    color: baseColor,
                    fill: 'hatch',
                    info: 'area',
                    text: '',
                    area,
                };

            rectModalOpen = false;
            if (!settings) {
                draft = null;
                clearDraft();
                return;
            }

            let labelText = '';
            if (settings.info === 'area') {
                labelText = `${formatAreaLabel(area)} м²`;
            } else if (settings.info === 'text') {
                labelText = String(settings.text || '').trim();
            }
            const finalSettings = { ...settings, labelText };
            const style = {
                ...rectDraft.style,
                color: settings.color || rectDraft.style?.color || baseColor,
            };
            const stroke = buildRectangleAnnotation(rect, style, finalSettings);
            const layer = getLayerById(rectDraft.layerId) || getActiveLayer();
            if (stroke && layer) {
                addStrokeToLayer(stroke, layer);
                if (onStrokeCommitted) {
                    const record = makeRectRecord(rect, style, finalSettings, layer);
                    if (record) onStrokeCommitted({ stroke, record });
                }
            }

            draft = null;
            clearDraft();
        })();

        return true;
    }

    function commitPinStroke(e) {
        const pinDraft = draft;
        if (!pinDraft || pinDraft.type !== 'pin') return false;

        pointerId = null;
        releasePointerCapture(e);
        setControlsEnabled(true);

        const cameraSnapshot = pinDraft.camera || captureCameraSnapshot();
        const cameraPos = cameraSnapshot?.position
            ? new THREE.Vector3(
                cameraSnapshot.position[0],
                cameraSnapshot.position[1],
                cameraSnapshot.position[2]
            )
            : camera?.position || null;
        const rect = computePinRectFromMidpoints(pinDraft.a, pinDraft.b, pinDraft.normal, cameraPos);
        if (!rect) {
            draft = null;
            clearDraft();
            return true;
        }

        updateDraftGeometry();
        rectModalOpen = true;
        const baseColor = pinDraft.style?.color || color;

        void (async () => {
            const settings = promptRectSettings
                ? await Promise.resolve(promptRectSettings({
                    title: 'Pin',
                    color: baseColor,
                    fill: 'none',
                    info: 'text',
                    text: '',
                    mode: 'pin',
                }))
                : {
                    color: baseColor,
                    text: '',
                };

            rectModalOpen = false;
            if (!settings) {
                draft = null;
                clearDraft();
                return;
            }

            const finalText = String(settings.text || '').trim();
            const finalSettings = { color: settings.color || baseColor, text: finalText };
            const style = {
                ...pinDraft.style,
                color: finalSettings.color || pinDraft.style?.color || baseColor,
                dash: 'solid',
            };
            const stroke = buildPinAnnotation(rect, style, finalSettings);
            const layer = getLayerById(pinDraft.layerId) || getActiveLayer();
            if (stroke && layer) {
                addStrokeToLayer(stroke, layer);
                if (onStrokeCommitted) {
                    const record = makePinRecord(rect, style, finalSettings, layer, cameraSnapshot);
                    if (record) onStrokeCommitted({ stroke, record });
                }
            }

            draft = null;
            clearDraft();
        })();

        return true;
    }

    function endStroke(e) {
        if (pointerId != null && e.pointerId === pointerId && !draft) {
            releasePointerCapture(e);
            pointerId = null;
            setControlsEnabled(true);
            return;
        }
        if (!drawEnabled || !draft || pointerId == null || e.pointerId !== pointerId) return;
        if (draft.type === 'rect') {
            commitRectPoint(e);
            return;
        }
        if (draft.type === 'pin') {
            commitPinStroke(e);
            return;
        }
        const layer = getActiveLayer();
        const shape = draft;
        if (shape?.mode === 'surface' && shape.type === 'line') {
            const rect = getViewRect();
            const surfacePoint = rect ? getSurfacePointFromClient(e.clientX, e.clientY, rect, shape.style) : null;
            if (surfacePoint) shape.b = surfacePoint.point;
        }
        draft = null;
        pointerId = null;
        releasePointerCapture(e);
        setControlsEnabled(true);

        if (!layer) return;
        const stroke = buildStrokeFromShape(shape);
        if (stroke) {
            addStrokeToLayer(stroke, layer);
            if (onStrokeCommitted) {
                const record = makeShapeRecord(shape, layer);
                if (record) onStrokeCommitted({ stroke, record });
            }
        }
        clearDraft();
    }

    function cancelStroke(e) {
        if (pointerId != null) {
            if (e?.pointerId === pointerId) {
                releasePointerCapture(e);
            } else {
                try {
                    canvas?.releasePointerCapture?.(pointerId);
                } catch (_) {}
            }
        }
        draft = null;
        pointerId = null;
        setControlsEnabled(true);
        clearDraft();
    }

    function updateDraftGeometry() {
        clearDraft();
        if (!draft) return;
        let stroke = null;
        if (draft.type === 'pin') {
            const rect = computePinRectFromMidpoints(draft.a, draft.b, draft.normal, camera?.position);
            if (rect) {
                stroke = buildRectEdgesGroup(rect.corners, draft.style, false);
            }
        } else if (draft.type === 'rect' && Array.isArray(draft.points)) {
            stroke = buildRectPreviewStroke(draft.points, draft.preview, draft.style);
        } else {
            stroke = buildStrokeFromShape(draft, true);
        }
        if (!stroke) return;
        stroke.userData.excludeFromExport = true;
        draftGroup.add(stroke);
        requestRender();
    }

    function clearDraft() {
        if (!draftGroup.children.length) return;
        draftGroup.children.forEach((child) => disposeObject(child, 'draft'));
        draftGroup.clear();
        requestRender();
    }

    function buildStrokeFromShape(shape) {
        if (!shape) return null;
        if (shape.type === 'path') {
            const points = simplifyPoints(shape.points || [], shape.style.width * 0.4);
            return buildStrokeObject(points, shape.style);
        }
        if (shape.type === 'rect' && Array.isArray(shape.points) && shape.points.length >= 3) {
            const rect = computeRectFromThreePoints(shape.points[0], shape.points[1], shape.points[2]);
            if (!rect) return null;
            return buildRectEdgesGroup(rect.corners, shape.style, true);
        }
        if (shape.mode === 'surface') {
            if (shape.type === 'line') {
                if (!shape.a || !shape.b) return null;
                return buildStrokeObject([shape.a, shape.b], shape.style);
            }
            const rect = getViewRect();
            if (!rect) return null;
            const stepPx = getSurfaceSampleStepPx();
            let clientPoints = null;
            if (shape.type === 'line') {
                clientPoints = sampleClientLinePoints(shape.startClient, shape.endClient, stepPx);
            } else if (shape.type === 'rect') {
                clientPoints = sampleClientRectPoints(shape.startClient, shape.endClient, stepPx);
            } else if (shape.type === 'circle') {
                clientPoints = sampleClientCirclePoints(shape.startClient, shape.endClient, stepPx);
            }
            const points = projectClientPointsToSurface(clientPoints, rect, shape.style);
            if (shape.type === 'rect' || shape.type === 'circle') ensureClosedPoints(points);
            if (!Array.isArray(points) || points.length < 2) return null;
            return buildStrokeObject(points, shape.style);
        }
        if (shape.type === 'line') {
            return buildStrokeObject([shape.a, shape.b], shape.style);
        }
        if (shape.type === 'rect') {
            const plane = shape.plane || shape.style.planeState;
            if (!plane) return null;
            const a2 = toPlaneCoords(shape.a, plane);
            const b2 = toPlaneCoords(shape.b, plane);
            const minX = Math.min(a2.x, b2.x);
            const maxX = Math.max(a2.x, b2.x);
            const minY = Math.min(a2.y, b2.y);
            const maxY = Math.max(a2.y, b2.y);
            const points = [
                fromPlaneCoords(minX, minY, plane),
                fromPlaneCoords(maxX, minY, plane),
                fromPlaneCoords(maxX, maxY, plane),
                fromPlaneCoords(minX, maxY, plane),
            ];
            return buildRectEdgesGroup(points, shape.style, true);
        }
        if (shape.type === 'circle') {
            const plane = shape.plane || shape.style.planeState;
            if (!plane) return null;
            const segments = 48;
            const center = toPlaneCoords(shape.c, plane);
            const points = [];
            for (let i = 0; i <= segments; i++) {
                const t = (i / segments) * Math.PI * 2;
                const x = center.x + Math.cos(t) * shape.r;
                const y = center.y + Math.sin(t) * shape.r;
                points.push(fromPlaneCoords(x, y, plane));
            }
            return buildStrokeObject(points, shape.style);
        }
        return null;
    }

    function normalizeStrokeStyle(raw) {
        if (!raw) {
            return {
                color,
                width: widthPx,
                dash,
            };
        }
        return {
            color: raw.color || color,
            width: Number.isFinite(raw.width) ? raw.width : widthPx,
            dash: raw.dash || dash,
        };
    }

    function buildStrokeFromRecord(record) {
        if (!record) return null;
        const payload = record.payload || {};
        const coordSpace = payload.coordSpace || null;
        const kind = record.kind || payload.kind;
        if (kind === 'pin') {
            const corners = arraysToPoints(payload.corners || [], coordSpace);
            if (corners.length < 4) return null;
            const widthValue = Number.isFinite(payload.width) ? payload.width : corners[0].distanceTo(corners[1]);
            const heightValue = Number.isFinite(payload.height) ? payload.height : corners[1].distanceTo(corners[2]);
            const normal = payload.normal ? new THREE.Vector3(payload.normal[0], payload.normal[1], payload.normal[2]) : null;
            const rect = {
                corners,
                width: widthValue,
                height: heightValue,
                normal,
            };
            const style = normalizeStrokeStyle(payload.style);
            const settings = {
                color: payload.settings?.color || style.color,
                text: payload.settings?.text || '',
            };
            const stroke = buildPinAnnotation(rect, style, settings);
            if (stroke) {
                stroke.userData = stroke.userData || {};
                stroke.userData.annotationPin = true;
            }
            return stroke;
        }
        if (kind === 'rect') {
            const corners = arraysToPoints(payload.corners || [], coordSpace);
            if (corners.length < 4) return null;
            const widthValue = Number.isFinite(payload.width) ? payload.width : corners[0].distanceTo(corners[1]);
            const heightValue = Number.isFinite(payload.height) ? payload.height : corners[1].distanceTo(corners[2]);
            const normal = payload.normal ? new THREE.Vector3(payload.normal[0], payload.normal[1], payload.normal[2]) : null;
            const rect = {
                corners,
                width: widthValue,
                height: heightValue,
                normal,
            };
            const style = normalizeStrokeStyle(payload.style);
            const settings = {
                ...(payload.settings || {}),
                color: payload.settings?.color || style.color,
            };
            const stroke = buildRectangleAnnotation(rect, style, settings);
            if (stroke && !coordSpace) {
                stroke.userData = stroke.userData || {};
                stroke.userData.legacyCoordSpace = true;
                stroke.userData.legacyWorldPos = world?.position ? world.position.clone() : null;
            }
            return stroke;
        }
        const points = arraysToPoints(payload.points || [], coordSpace);
        if (!points.length) return null;
        const style = normalizeStrokeStyle(payload.style);
        const stroke = buildStrokeObject(points, style);
        if (stroke && !coordSpace) {
            stroke.userData = stroke.userData || {};
            stroke.userData.legacyCoordSpace = true;
            stroke.userData.legacyWorldPos = world?.position ? world.position.clone() : null;
        }
        return stroke;
    }

    function undo() {
        while (undoStack.length) {
            const entry = undoStack.pop();
            if (entry?.stroke && entry.stroke.parent) {
                removeStroke(entry.stroke);
                return true;
            }
        }
        return false;
    }

    function clear() {
        const layer = getActiveLayer();
        if (!layer) return false;
        const strokes = [...layer.strokes];
        strokes.forEach((stroke) => removeStroke(stroke));
        return true;
    }

    function addRemoteAnnotation(record) {
        if (!record || !record.id) return null;
        if (strokesById.has(record.id)) return strokesById.get(record.id);
        const payload = record.payload || {};
        const layer = (payload.layerId || payload.layerName)
            ? ensureLayer(payload.layerId || null, payload.layerName || 'Layer', false)
            : getActiveLayer();
        const stroke = buildStrokeFromRecord(record);
        if (!stroke) return null;
        if (record.author_name) {
            stroke.userData = stroke.userData || {};
            stroke.userData.authorName = record.author_name;
            if (record.author_id) stroke.userData.authorId = record.author_id;
        }
        addStrokeToLayer(stroke, layer, { skipUndo: true, annotationId: record.id });
        return stroke;
    }

    function removeRemoteAnnotation(annotationId) {
        if (!annotationId) return false;
        const stroke = strokesById.get(annotationId);
        if (!stroke) return false;
        removeStroke(stroke, { skipNotify: true, force: true });
        return true;
    }

    function setAuthorVisibility(authorId, visible) {
        if (!authorId) return;
        authorVisibility.set(authorId, !!visible);
        layers.forEach((layer) => {
            layer.strokes.forEach((stroke) => {
                if (stroke?.userData?.authorId === authorId) {
                    if (isPinStroke(stroke)) return;
                    stroke.visible = !!visible;
                }
            });
        });
        requestRender();
    }

    function setPinVisibility(authorId, visible) {
        if (!authorId) return;
        pinAuthorVisibility.set(authorId, !!visible);
        layers.forEach((layer) => {
            layer.strokes.forEach((stroke) => {
                if (stroke?.userData?.authorId === authorId) {
                    if (!isPinStroke(stroke)) return;
                    stroke.visible = !!visible;
                }
            });
        });
        requestRender();
    }

    function registerAnnotationId(stroke, annotationId) {
        if (!stroke || !annotationId) return false;
        registerStrokeAnnotation(stroke, annotationId);
        return true;
    }

    function applyWorldOffsetDelta(delta) {
        if (!delta || !Number.isFinite(delta.x) || !Number.isFinite(delta.y) || !Number.isFinite(delta.z)) return;
        if (delta.lengthSq() < 1e-12) return;
        layers.forEach((layer) => {
            layer.strokes.forEach((stroke) => {
                if (!stroke?.userData?.legacyCoordSpace) return;
                const legacyWorldPos = stroke.userData.legacyWorldPos;
                if (legacyWorldPos && legacyWorldPos.lengthSq() > 1e-10) return;
                stroke.position.sub(delta);
            });
        });
        requestRender();
    }

    function ensurePointerCapture(e) {
        try {
            canvas?.setPointerCapture?.(e.pointerId);
        } catch (_) {}
    }

    function releasePointerCapture(e) {
        try {
            canvas?.releasePointerCapture?.(e.pointerId);
        } catch (_) {}
    }

    function getControlEnabled(ctrl) {
        if (!ctrl) return null;
        if (typeof ctrl.enabled === 'boolean') return ctrl.enabled;
        if (typeof ctrl.isEnabled === 'function') return ctrl.isEnabled();
        return null;
    }

    function setControlEnabled(ctrl, enabled) {
        if (!ctrl) return;
        if (typeof ctrl.enabled === 'boolean') {
            ctrl.enabled = enabled;
            return;
        }
        if (typeof ctrl.setEnabled === 'function') {
            ctrl.setEnabled(enabled);
        }
    }

    function setControlsEnabled(enabled) {
        if (controls && prevControlsEnabled == null) {
            prevControlsEnabled = getControlEnabled(controls);
        }
        if (flightControls && prevFlightEnabled == null) {
            prevFlightEnabled = getControlEnabled(flightControls);
        }
        if (controls) setControlEnabled(controls, enabled ? prevControlsEnabled ?? true : false);
        if (flightControls) setControlEnabled(flightControls, enabled ? prevFlightEnabled ?? true : false);
        if (enabled) {
            prevControlsEnabled = null;
            prevFlightEnabled = null;
        }
    }

    function syncToolbar() {
        if (!toolbarEl) return;
        toolbarEl.querySelectorAll?.('.anno-tool')?.forEach((btn) => {
            const t = btn?.dataset?.tool;
            btn.classList.toggle('active', drawEnabled && t && t === tool);
        });
        if (annoVisibleBtn) annoVisibleBtn.classList.toggle('active', visible);
        if (annoDrawBtn) annoDrawBtn.classList.toggle('active', drawEnabled);
        if (annoColorEl && typeof annoColorEl.value === 'string') annoColorEl.value = color;
        if (annoDashEl && typeof annoDashEl.value === 'string') annoDashEl.value = dash;
        if (annoWidthEl) annoWidthEl.value = String(widthPx);
        if (annoLayerSelectEl && activeLayerId) annoLayerSelectEl.value = activeLayerId;
    }

    function setToolbarVisible(visibleState) {
        if (!toolbarEl) return;
        const next = !!visibleState;
        toolbarEl.hidden = !next;
        if (annoToggleBtn) {
            annoToggleBtn.classList.toggle('active', next);
            annoToggleBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
        }
        if (next) {
            setVisible(true);
            setDrawEnabled(true);
        } else {
            setDrawEnabled(false);
        }
        syncToolbar();
    }

    function toggleToolbar() {
        if (!toolbarEl) return;
        setToolbarVisible(!!toolbarEl.hidden);
    }

    function ensureToolbar() {
        if (!toolbarEl || toolbarReady) return;
        toolbarReady = true;

        toolbarEl.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const btn = target.closest?.('.anno-tool');
            if (!btn) return;
            const nextTool = normalizeTool(btn.dataset.tool);
            if (!nextTool) return;
            if (drawEnabled && tool === nextTool) {
                setDrawEnabled(false);
                return;
            }
            setTool(nextTool);
            setVisible(true);
            setDrawEnabled(true);
        });

        annoVisibleBtn?.addEventListener?.('click', () => {
            setVisible(!visible);
        });

        annoDrawBtn?.addEventListener?.('click', () => {
            const next = !drawEnabled;
            if (next) setVisible(true);
            setDrawEnabled(next);
            syncToolbar();
        });

        annoUndoBtn?.addEventListener?.('click', () => {
            undo();
            syncToolbar();
        });

        annoClearBtn?.addEventListener?.('click', () => {
            clear();
            syncToolbar();
        });

        annoColorEl?.addEventListener?.('input', () => {
            setColor(annoColorEl.value);
            syncToolbar();
        });

        annoDashEl?.addEventListener?.('change', () => {
            setDash(annoDashEl.value);
            syncToolbar();
        });

        annoWidthEl?.addEventListener?.('input', () => {
            setWidth(annoWidthEl.value);
            syncToolbar();
        });

        annoLayerSelectEl?.addEventListener?.('change', () => {
            setActiveLayer(annoLayerSelectEl.value);
        });

        annoLayerAddBtn?.addEventListener?.('click', () => {
            void (async () => {
                let name = null;
                if (promptLayerName) {
                    try {
                        name = await Promise.resolve(promptLayerName(`Layer ${layers.length + 1}`));
                    } catch (_) {
                        name = null;
                    }
                } else {
                    name = safePrompt(promptFn, 'Layer name', `Layer ${layers.length + 1}`);
                }
                if (name == null) return;
                const trimmed = String(name).trim();
                if (!trimmed) return;
                createLayer(trimmed);
                syncToolbar();
            })();
        });

        syncToolbar();
    }

    function ensureHotkeys() {
        if (hotkeysReady) return;
        const win = (typeof window !== 'undefined' ? window : null) || null;
        if (!win?.addEventListener) return;
        hotkeysReady = true;

        const repeatSensitive = new Set(['KeyH', 'Escape', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']);
        const toolByDigit = Object.freeze({
            Digit1: 'pencil',
            Digit2: 'line',
            Digit3: 'rect',
            Digit4: 'pin',
            Digit5: 'eraser',
        });

        onKeyDownBound = (event) => {
            if (!event || event.defaultPrevented) return;
            if (isAnyModalOpen()) return;
            if (isEditableElement(event.target)) return;

            const code = event.code;
            if ((event.ctrlKey || event.metaKey) && code === 'KeyZ' && !event.shiftKey) {
                undo();
                syncToolbar();
                event.preventDefault?.();
                return;
            }

            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.repeat && repeatSensitive.has(code)) return;

            if (code === 'Escape') {
                if (drawEnabled) {
                    setDrawEnabled(false);
                    syncToolbar();
                    event.preventDefault?.();
                }
                return;
            }

            if (code === 'KeyH') {
                setVisible(!visible);
                syncToolbar();
                event.preventDefault?.();
                return;
            }

            const toolKey = toolByDigit[code];
            if (toolKey) {
                setTool(toolKey);
                setVisible(true);
                setDrawEnabled(true);
                event.preventDefault?.();
                return;
            }

            if (code === 'BracketLeft' || code === 'BracketRight') {
                const delta = code === 'BracketRight' ? 1 : -1;
                setWidth(widthPx + delta);
                syncToolbar();
                event.preventDefault?.();
                return;
            }
        };

        win.addEventListener('keydown', onKeyDownBound);
    }

    function handleWheel(e) {
        if (!drawEnabled) return;
        e.preventDefault?.();
        const delta = Math.max(-100, Math.min(100, e.deltaY || 0));
        const scale = Math.exp(delta * 0.002);
        planeDistance = Math.max(0.1, Math.min(100000, planeDistance * scale));
    }

    function handlePointerMove(e) {
        if (tool === 'eraser' && drawEnabled && pointerId != null && e.pointerId === pointerId) {
            const isDown =
                (typeof e.buttons === 'number' && (e.buttons & 1) === 1) ||
                (typeof e.pressure === 'number' && e.pressure > 0);
            if (!isDown) {
                cancelStroke(e);
                return;
            }
            const hit = pickStroke(e, { removableOnly: true });
            if (hit && hit.uuid !== lastEraseId) {
                if (removeStroke(hit)) {
                    lastEraseId = hit.uuid;
                }
            }
            return;
        }
        moveStroke(e);
    }

    function attachEvents() {
        if (!canvas) return;
        onWheelBound = (event) => handleWheel(event);
        onPointerDownBound = (event) => beginStroke(event);
        onPointerMoveBound = (event) => handlePointerMove(event);
        onPointerUpBound = (event) => endStroke(event);
        onPointerCancelBound = (event) => cancelStroke(event);
        canvas.addEventListener('wheel', onWheelBound, { passive: false });
        canvas.addEventListener('pointerdown', onPointerDownBound);
        canvas.addEventListener('pointermove', onPointerMoveBound);
        canvas.addEventListener('pointerup', onPointerUpBound);
        canvas.addEventListener('pointercancel', onPointerCancelBound);
    }

    function detachEvents() {
        if (!canvas) return;
        if (onWheelBound) canvas.removeEventListener('wheel', onWheelBound);
        if (onPointerDownBound) canvas.removeEventListener('pointerdown', onPointerDownBound);
        if (onPointerMoveBound) canvas.removeEventListener('pointermove', onPointerMoveBound);
        if (onPointerUpBound) canvas.removeEventListener('pointerup', onPointerUpBound);
        if (onPointerCancelBound) canvas.removeEventListener('pointercancel', onPointerCancelBound);
        onWheelBound = null;
        onPointerDownBound = null;
        onPointerMoveBound = null;
        onPointerUpBound = null;
        onPointerCancelBound = null;
    }

    function dispose() {
        detachEvents();
        if (onKeyDownBound && typeof window !== 'undefined') {
            window.removeEventListener('keydown', onKeyDownBound);
        }
        clearDraft();
        layers.forEach((layer) => {
            layer.strokes.forEach((stroke) => disposeObject(stroke));
        });
        flushDisposals(true);
        strokesById.clear();
        annotationsRoot.removeFromParent();
    }

    ensureToolbar();
    setToolbarVisible(false);
    annoToggleBtn?.addEventListener?.('click', toggleToolbar);
    ensureHotkeys();
    attachEvents();
    syncLayerSelect();
    setVisible(true);

    return Object.freeze({
        setEnabled: (enabled) => {
            setDrawEnabled(enabled);
            return drawEnabled;
        },
        setVisible: (next) => setVisible(next),
        getDrawEnabled: () => drawEnabled,
        isPointerDown: () => pointerId != null,
        getRoot: () => annotationsRoot,
        addRemoteAnnotation,
        removeRemoteAnnotation,
        registerAnnotationId,
        applyWorldOffsetDelta,
        setAuthorVisibility,
        getAuthorVisibility,
        refreshAuthorVisibility,
        setPinVisibility,
        getPinVisibility,
        refreshPinVisibility,
        dispose,
    });
}
