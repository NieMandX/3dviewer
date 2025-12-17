import { createSliderValueDisplayController } from './slider-value-displays.js';

export function createSliderValuesUIController(options = {}) {
    const root = options.root || (typeof document !== 'undefined' ? document : null);
    const sliders = Array.isArray(options.sliders) ? options.sliders : [];

    const controller = createSliderValueDisplayController({ root });
    sliders.forEach(([id, slider]) => controller.register(id, slider));
    controller.updateAll();
    controller.attachInputs();

    return controller;
}

