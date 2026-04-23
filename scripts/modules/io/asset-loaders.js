import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { createFBXWorkerClient } from '../workers/fbx-worker-client.js';
import { createZIPWorkerClient } from '../workers/zip-worker-client.js';

export function createAssetLoaders(options = {}) {
    const THREE = options.THREE;
    if (!THREE) throw new Error('createAssetLoaders: THREE is required');

    const fbxLoader = new FBXLoader();
    const textureLoader = new THREE.TextureLoader();
    const texLd = new THREE.TextureLoader(); // for small helper textures

    const fbxWorkerClient = createFBXWorkerClient();
    let fbxWorkerSupported = fbxWorkerClient.isSupported();
    const parseFBXInWorker = fbxWorkerClient.parseFBXInWorker;
    const FBX_Z_UP_WARNING = 'z-up coordinate system';
    const FBX_Z_UP_WARNING_SECOND = 'vertex data are not converted';

    function isFBXZUpWarning(args) {
        if (!args?.length) return false;

        const payload = args
            .map((arg) => {
                if (typeof arg === 'string') return arg;
                if (arg && typeof arg === 'object' && typeof arg.message === 'string') return arg.message;
                return '';
            })
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        if (!payload.includes(FBX_Z_UP_WARNING)) return false;
        return payload.includes(FBX_Z_UP_WARNING) && payload.includes(FBX_Z_UP_WARNING_SECOND);
    }

    function withFilteredFBXWarnings(task) {
        const warn = console.warn?.bind(console);
        const error = console.error?.bind(console);
        const log = console.log?.bind(console);

        if (warn) {
            console.warn = (...args) => {
                if (!isFBXZUpWarning(args)) warn(...args);
            };
        }
        if (error) {
            console.error = (...args) => {
                if (!isFBXZUpWarning(args)) error(...args);
            };
        }
        if (log) {
            console.log = (...args) => {
                if (!isFBXZUpWarning(args)) log(...args);
            };
        }

        try {
            return task();
        } finally {
            if (warn) console.warn = warn;
            if (error) console.error = error;
            if (log) console.log = log;
        }
    }

    function parseFBXOnMainThread(buffer) {
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const parsed = withFilteredFBXWarnings(() => fbxLoader.parse(buffer, ''));
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

    return {
        fbxLoader,
        textureLoader,
        texLd,
        parseFBXInWorker,
        parseFBXOnMainThread,
        isWorkerSupported,
        setWorkerSupported,
        disableWorker,
        unpackZIPInWorker,
    };
}
