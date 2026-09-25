// Optional, self-contained GLB material extras. Ordinary glTF PBR remains the fallback.
export function readRiverFlowSettings(value) {
    if (!value || ![1, 2].includes(value.version)) return null;
    const pair = (v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
    if (!pair(value.origin) || !pair(value.extent) || value.extent.some((v) => v <= 0)) return null;
    if (![value.tileMeters, value.cycleSeconds, value.metersPerSecond].every(Number.isFinite)) return null;
    if (value.tileMeters <= 0 || value.cycleSeconds <= 0 || value.metersPerSecond < 0) return null;
    if (typeof value.flowMap !== 'string' || !value.flowMap.startsWith('data:image/png;base64,') || value.flowMap.length > 4 * 1024 * 1024) return null;
    return {
        ...value,
        speed: Number.isFinite(value.speed) ? Math.max(0, Math.min(30, value.speed)) : 1,
        specularColor: Array.isArray(value.specularColor) && value.specularColor.length === 3
            && value.specularColor.every((v) => Number.isFinite(v) && v >= 0 && v <= 2)
            ? value.specularColor : [1, 1, 1],
    };
}

export async function createRiverMaterial(base, field, meta, useWebGPU) {
    const THREE = await import('three');
    const origin = new THREE.Vector2(...meta.origin);
    const extent = new THREE.Vector2(...meta.extent);
    const travel = meta.metersPerSecond * meta.cycleSeconds / meta.tileMeters;
    let material;
    let time = { value: 0 };
    const offset = new THREE.Vector3();
    if (useWebGPU) {
        const [{ MeshPhysicalNodeMaterial }, { uniform, uv, vec2, vec3, vec4, texture, mix, normalMap, positionWorld, cameraViewMatrix }] = await Promise.all([
            import('three/webgpu'), import('three/tsl'),
        ]);
        material = new MeshPhysicalNodeMaterial();
        THREE.MeshPhysicalMaterial.prototype.copy.call(material, base);
        time = uniform(0);
        // Export contract: normal-map UV is (source X / tile, 1 - source Y / tile).
        const sourceXY = meta.version === 2 ? positionWorld.sub(uniform(offset)).xz
            : vec2(uv(base.normalMap.channel).x.mul(meta.tileMeters), uv(base.normalMap.channel).y.oneMinus().mul(meta.tileMeters));
        const coord = meta.version === 2 ? sourceXY.div(meta.tileMeters) : uv(base.normalMap.channel);
        const data = texture(field, sourceXY.sub(uniform(origin)).div(uniform(extent)));
        const direction = data.rg.mul(2).sub(1).normalize().mul(vec2(1, meta.version === 2 ? 1 : -1));
        const clock = time.div(meta.cycleSeconds).add(data.a);
        const p0 = clock.fract(), p1 = clock.add(0.5).fract();
        const distance = direction.mul(data.b).mul(travel);
        const first = texture(base.normalMap, coord.sub(distance.mul(p0)));
        const second = texture(base.normalMap, coord.sub(distance.mul(p1)));
        material.updateRiverNormal = (map) => { first.value = map; second.value = map; material.normalMap = map; material.needsUpdate = true; };
        const sampled = mix(first, second, p0.mul(2).sub(1).abs());
        if (meta.version === 2) {
            const n = sampled.xyz.mul(2).sub(1);
            const scale = uniform(material.normalScale);
            material.normalNode = cameraViewMatrix.mul(vec4(vec3(n.x.mul(scale.x), n.z, n.y.mul(scale.y)).normalize(), 0)).xyz.normalize();
        } else material.normalNode = normalMap(sampled, uniform(material.normalScale));
    } else {
        material = base.clone();
        material.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, {
                riverOffset: { value: offset }, riverTime: time, riverField: { value: field },
                riverOrigin: { value: origin }, riverExtent: { value: extent },
            });
            if (meta.version === 2) {
                shader.vertexShader = 'varying vec3 riverWorld;\n' + shader.vertexShader;
                shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n vec4 riverLocal = vec4(transformed,1.0);\n #ifdef USE_INSTANCING\n riverLocal = instanceMatrix * riverLocal;\n #endif\n riverWorld = (modelMatrix * riverLocal).xyz;');
            }
            shader.fragmentShader = (meta.version === 2 ? 'varying vec3 riverWorld; uniform vec3 riverOffset;\n' : '') + 'uniform float riverTime; uniform sampler2D riverField; uniform vec2 riverOrigin; uniform vec2 riverExtent;\n' + shader.fragmentShader;
            const original = THREE.ShaderChunk.normal_fragment_maps;
            const needle = 'texture2D( normalMap, vNormalMapUv ).xyz';
            if (!original.includes(needle)) throw Error('River flow: unsupported normal-map shader chunk');
            shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `
                vec2 riverSource = ${meta.version === 2 ? '(riverWorld-riverOffset).xz' : `vec2(vNormalMapUv.x, 1.0-vNormalMapUv.y) * ${meta.tileMeters.toFixed(8)}`};
                vec2 riverUV = ${meta.version === 2 ? `riverSource / ${meta.tileMeters.toFixed(8)}` : 'vNormalMapUv'};
                vec4 riverData = texture2D(riverField, (riverSource-riverOrigin)/riverExtent);
                vec2 riverDirection = normalize(riverData.rg*2.0-1.0) * vec2(1.0,${meta.version === 2 ? '1.0' : '-1.0'});
                vec2 riverTravel = riverDirection * riverData.b * ${travel.toFixed(12)};
                float riverPhase = riverTime/${meta.cycleSeconds.toFixed(8)} + riverData.a;
                float riverA=fract(riverPhase), riverB=fract(riverPhase+0.5);
                vec3 riverNormal=mix(texture2D(normalMap,riverUV-riverTravel*riverA).xyz,
                    texture2D(normalMap,riverUV-riverTravel*riverB).xyz,abs(riverA*2.0-1.0));
                ${meta.version === 2 ? 'vec3 rn=riverNormal*2.0-1.0; normal=normalize(mat3(viewMatrix)*normalize(vec3(rn.x*normalScale.x,rn.z,rn.y*normalScale.y)));' : original.replaceAll(needle, 'riverNormal')}
            `);
        };
        material.customProgramCacheKey = () => `lpmview-river-v${meta.version}:${meta.tileMeters}:${meta.cycleSeconds}:${travel}`;
    }
    material.specularColor.setRGB(...meta.specularColor);
    // An enumerable texture reference lets the standard importer/disposal registry own it.
    material.riverFlowMap = field;
    material.needsUpdate = true;
    return { material, time, offset };
}

export async function installRiverFlow(root, { useWebGPU = false, requestRender = () => {}, signal, world = null } = {}) {
    const candidates = new Map();
    root.traverse((object) => {
        if (!object.isMesh) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((base) => {
            const settings = readRiverFlowSettings(base?.userData?.lpmview_water);
            if (!settings || !base?.isMeshPhysicalMaterial || !base.normalMap) return;
            if (!candidates.has(base)) candidates.set(base, { settings, objects: [] });
            candidates.get(base).objects.push(object);
        });
    });
    if (!candidates.size) return;
    const THREE = await import('three');
    const abort = () => { if (signal?.aborted) throw new DOMException('River flow import aborted', 'AbortError'); };
    for (const [base, { settings, objects }] of candidates) {
        let field = null, flow = null;
        try {
            abort();
            field = await new THREE.TextureLoader().loadAsync(settings.flowMap);
            abort();
            field.flipY = false;
            field.colorSpace = THREE.NoColorSpace;
            field.wrapS = field.wrapT = THREE.ClampToEdgeWrapping;
            field.generateMipmaps = false;
            field.minFilter = field.magFilter = THREE.LinearFilter;
            field.needsUpdate = true;
            flow = await createRiverMaterial(base, field, settings, useWebGPU);
            abort();
        } catch (error) {
            flow?.material.dispose();
            field?.dispose();
            throw error;
        }
        const { material } = flow;
        for (const object of objects) object.material = Array.isArray(object.material)
            ? object.material.map((m) => m === base ? material : m) : material;
        attachRiverRuntime(flow, objects, root, settings, { requestRender, world });
        base.dispose(); // Textures are shared with the replacement and remain alive.
    }
}

const renderHooks = new WeakMap();

export function attachRiverRuntime(flow, objects, root, settings, { requestRender = () => {}, world = null } = {}) {
    const { material, time, offset } = flow;
    const state = material.riverFlow = { time, speed: settings.speed, playing: true };
    const doc = typeof document !== 'undefined' ? document : null;
    let last = performance.now(), disposed = false;
    const registrations = [];
    const visible = () => { last = performance.now(); if (!doc?.hidden && !disposed && root.parent) requestRender(); };
    doc?.addEventListener('visibilitychange', visible);
    for (const object of new Set(objects)) {
        let hook = renderHooks.get(object);
        if (!hook) {
            hook = { previous: object.onBeforeRender, callbacks: new Set() };
            hook.dispatch = function (...args) { hook.previous?.apply(this, args); for (const callback of hook.callbacks) callback(args[4]); };
            renderHooks.set(object, hook); object.onBeforeRender = hook.dispatch;
        }
        const update = (renderedMaterial) => {
            if (world) offset.copy(world.position);
            if (disposed || doc?.hidden || state.suspended || !state.playing || state.speed <= 0 || renderedMaterial !== material || !root.parent) { last = performance.now(); return; }
            const now = performance.now();
            time.value += Math.min(Math.max(0, (now - last) / 1000), 0.1) * Math.max(0, Math.min(30, state.speed));
            last = now; requestRender();
        };
        hook.callbacks.add(update); registrations.push({ object, hook, update });
    }
    material.addEventListener('dispose', function cleanup() {
        if (disposed) return; disposed = true;
        doc?.removeEventListener('visibilitychange', visible);
        for (const { object, hook, update } of registrations) {
            hook.callbacks.delete(update);
            if (!hook.callbacks.size) { if (object.onBeforeRender === hook.dispatch) object.onBeforeRender = hook.previous; renderHooks.delete(object); }
        }
        registrations.length = 0; material.removeEventListener('dispose', cleanup);
    });
}
