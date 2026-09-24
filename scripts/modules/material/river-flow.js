// Optional, self-contained GLB material extras. Ordinary glTF PBR remains the fallback.
export function readRiverFlowSettings(value) {
    if (!value || value.version !== 1) return null;
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

async function createMaterial(base, field, meta, useWebGPU) {
    const THREE = await import('three');
    const origin = new THREE.Vector2(...meta.origin);
    const extent = new THREE.Vector2(...meta.extent);
    const travel = meta.metersPerSecond * meta.cycleSeconds / meta.tileMeters;
    let material;
    let time = { value: 0 };
    if (useWebGPU) {
        const [{ MeshPhysicalNodeMaterial }, { uniform, uv, vec2, texture, mix, normalMap }] = await Promise.all([
            import('three/webgpu'), import('three/tsl'),
        ]);
        material = new MeshPhysicalNodeMaterial();
        THREE.MeshPhysicalMaterial.prototype.copy.call(material, base);
        time = uniform(0);
        // Export contract: normal-map UV is (source X / tile, 1 - source Y / tile).
        const coord = uv(base.normalMap.channel);
        const sourceXY = vec2(coord.x.mul(meta.tileMeters), coord.y.oneMinus().mul(meta.tileMeters));
        const data = texture(field, sourceXY.sub(uniform(origin)).div(uniform(extent)));
        const direction = data.rg.mul(2).sub(1).normalize().mul(vec2(1, -1));
        const clock = time.div(meta.cycleSeconds).add(data.a);
        const p0 = clock.fract(), p1 = clock.add(0.5).fract();
        const distance = direction.mul(data.b).mul(travel);
        const first = texture(base.normalMap, coord.sub(distance.mul(p0)));
        const second = texture(base.normalMap, coord.sub(distance.mul(p1)));
        material.normalNode = normalMap(mix(first, second, p0.mul(2).sub(1).abs()), uniform(base.normalScale.clone()));
    } else {
        material = base.clone();
        material.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, {
                riverTime: time, riverField: { value: field },
                riverOrigin: { value: origin }, riverExtent: { value: extent },
            });
            shader.fragmentShader = 'uniform float riverTime; uniform sampler2D riverField; uniform vec2 riverOrigin; uniform vec2 riverExtent;\n' + shader.fragmentShader;
            const original = THREE.ShaderChunk.normal_fragment_maps;
            const needle = 'texture2D( normalMap, vNormalMapUv ).xyz';
            if (!original.includes(needle)) throw Error('River flow: unsupported normal-map shader chunk');
            shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `
                vec2 riverSource = vec2(vNormalMapUv.x, 1.0-vNormalMapUv.y) * ${meta.tileMeters.toFixed(8)};
                vec4 riverData = texture2D(riverField, (riverSource-riverOrigin)/riverExtent);
                vec2 riverDirection = normalize(riverData.rg*2.0-1.0) * vec2(1.0,-1.0);
                vec2 riverTravel = riverDirection * riverData.b * ${travel.toFixed(12)};
                float riverPhase = riverTime/${meta.cycleSeconds.toFixed(8)} + riverData.a;
                float riverA=fract(riverPhase), riverB=fract(riverPhase+0.5);
                vec3 riverNormal=mix(texture2D(normalMap,vNormalMapUv-riverTravel*riverA).xyz,
                    texture2D(normalMap,vNormalMapUv-riverTravel*riverB).xyz,abs(riverA*2.0-1.0));
                ${original.replaceAll(needle, 'riverNormal')}
            `);
        };
        material.customProgramCacheKey = () => `lpmview-river-v1:${meta.tileMeters}:${meta.cycleSeconds}:${travel}`;
    }
    material.specularColor.setRGB(...meta.specularColor);
    // An enumerable texture reference lets the standard importer/disposal registry own it.
    material.riverFlowMap = field;
    material.needsUpdate = true;
    return { material, time };
}

export async function installRiverFlow(root, { useWebGPU = false, requestRender = () => {}, signal } = {}) {
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
            flow = await createMaterial(base, field, settings, useWebGPU);
            abort();
        } catch (error) {
            flow?.material.dispose();
            field?.dispose();
            throw error;
        }
        const { material, time } = flow;
        const state = material.riverFlow = { time, speed: settings.speed, playing: true };
        const doc = typeof document !== 'undefined' ? document : null;
        let last = performance.now(), disposed = false;
        const hooks = [];
        const visible = () => {
            last = performance.now();
            if (!doc?.hidden && !disposed && root.parent) requestRender();
        };
        doc?.addEventListener('visibilitychange', visible);
        for (const object of new Set(objects)) {
            object.material = Array.isArray(object.material)
                ? object.material.map((m) => m === base ? material : m) : material;
            const previous = object.onBeforeRender;
            function beforeRender(...args) {
                previous?.apply(this, args);
                // Shading overrides and hidden/removed scenes must not keep rendering.
                const renderedMaterial = args[4];
                if (disposed || doc?.hidden || !state.playing || renderedMaterial !== material || !root.parent) { last = performance.now(); return; }
                const now = performance.now();
                time.value += Math.min(Math.max(0, (now - last) / 1000), 0.1) * Math.max(0, Math.min(30, state.speed));
                last = now;
                requestRender();
            }
            object.onBeforeRender = beforeRender;
            hooks.push({ object, previous, beforeRender });
        }
        material.addEventListener('dispose', function cleanup() {
            if (disposed) return;
            disposed = true;
            doc?.removeEventListener('visibilitychange', visible);
            for (const { object, previous, beforeRender } of hooks) {
                if (object.onBeforeRender === beforeRender) object.onBeforeRender = previous;
            }
            material.removeEventListener('dispose', cleanup);
            // Texture resources are disposed by collectMaterialTextures, including riverFlowMap.
        });
        base.dispose(); // Textures are shared with the replacement and remain alive.
    }
}
