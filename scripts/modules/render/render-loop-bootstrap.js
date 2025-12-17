import { createRenderLoopController } from './render-loop.js';

export function createAndStartRenderLoop(options = {}) {
    const loop = createRenderLoopController(options);
    loop.start();
    return loop;
}

