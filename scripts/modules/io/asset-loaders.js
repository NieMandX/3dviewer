import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { createFBXWorkerClient } from '../workers/fbx-worker-client.js';
import { createZIPWorkerClient } from '../workers/zip-worker-client.js';

const DEFAULT_DRACO_DECODER_PATH = 'https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/draco/';

export function createAssetLoaders(options = {}) {
    const THREE = options.THREE;
    if (!THREE) throw new Error('createAssetLoaders: THREE is required');

    const fbxLoader = new FBXLoader();
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(options.dracoDecoderPath || DEFAULT_DRACO_DECODER_PATH);
    const gltfLoader = new GLTFLoader();
    gltfLoader.setDRACOLoader(dracoLoader);
    gltfLoader.setMeshoptDecoder(MeshoptDecoder);
    const textureLoader = new THREE.TextureLoader();
    const texLd = new THREE.TextureLoader(); // for small helper textures

    const fbxWorkerClient = createFBXWorkerClient();
    let fbxWorkerSupported = fbxWorkerClient.isSupported();
    const parseFBXInWorker = fbxWorkerClient.parseFBXInWorker;

    function parseFBXOnMainThread(buffer) {
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const parsed = fbxLoader.parse(buffer, '');
        const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (fbxLoader?.fbxTree) {
            (parsed.userData ||= {}).fbxTree = fbxLoader.fbxTree;
        }
        return { obj: parsed, duration: end - now };
    }

    function isWorkerSupported() {
        return fbxWorkerSupported;
    }

    function setWorkerSupported(next) {
        fbxWorkerSupported = next;
    }

    function disableWorker(err) {
        try {
            fbxWorkerClient.disable(err);
        } catch (_) {}
    }

    const zipWorkerClient = createZIPWorkerClient();
    const unpackZIPInWorker = zipWorkerClient.unpackZIPInWorker;

    function dispose() {
        try {
            fbxWorkerClient.dispose?.();
        } catch (_) {}
        try {
            zipWorkerClient.dispose?.();
        } catch (_) {}
        try {
            dracoLoader.dispose?.();
        } catch (_) {}
    }

    function getDiagnostics() {
        return {
            fbx: fbxWorkerClient.getDiagnostics?.() || {
                supported: fbxWorkerSupported,
                workerActive: false,
                pending: 0,
            },
            zip: zipWorkerClient.getDiagnostics?.() || {
                supported: zipWorkerClient.isSupported?.() || false,
                workerActive: false,
                pending: 0,
            },
            fbxWorkerSupported,
        };
    }

    return {
        fbxLoader,
        gltfLoader,
        textureLoader,
        texLd,
        parseFBXInWorker,
        parseFBXOnMainThread,
        isWorkerSupported,
        setWorkerSupported,
        disableWorker,
        unpackZIPInWorker,
        getDiagnostics,
        dispose,
    };
}
