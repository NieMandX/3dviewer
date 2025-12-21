export function createSunInputsController(options = {}) {
    const sunHourEl = options.sunHourEl || null;
    const sunHourInputEl = options.sunHourInputEl || null;
    const sunDayEl = options.sunDayEl || null;
    const sunMonthEl = options.sunMonthEl || null;
    const sunNorthEl = options.sunNorthEl || null;

    const sunIntensityEl = options.sunIntensityEl || null;
    const sunIntensityInputEl = options.sunIntensityInputEl || null;
    const dirLight = options.dirLight || null;

    const updateSun = typeof options.updateSun === 'function' ? options.updateSun : () => {};
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};
    const onLightsUpdated = typeof options.onLightsUpdated === 'function' ? options.onLightsUpdated : () => {};

    function clampNumericInput(value, min, max) {
        if (!Number.isFinite(value)) return null;
        if (min != null) value = Math.max(min, value);
        if (max != null) value = Math.min(max, value);
        return value;
    }

    const formatSunHour = (value) => {
        const totalMinutes = Math.round(value * 60);
        const hours = Math.floor(totalMinutes / 60) % 24;
        const minutes = totalMinutes % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    };

    const parseSunHour = (text) => {
        const match = /^\s*(\d{1,2})\s*[:.]\s*(\d{1,2})\s*$/u.exec(text);
        if (!match) return null;
        let hours = parseInt(match[1], 10);
        let minutes = parseInt(match[2], 10);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
        minutes = Math.max(0, Math.min(59, minutes));
        hours = Math.max(0, Math.min(23, hours));
        return hours + minutes / 60;
    };

    const formatSunIntensity = (value) => value.toFixed(1);

    [sunHourEl, sunDayEl, sunMonthEl, sunNorthEl].filter(Boolean).forEach(el => {
        el.addEventListener('input', () => {
            updateSun();
            onLightsUpdated();
        });
    });
    updateSun();

    if (sunHourEl && sunHourInputEl) {
        sunHourInputEl.value = formatSunHour(parseFloat(sunHourEl.value));
        sunHourEl.addEventListener('input', () => {
            sunHourInputEl.value = formatSunHour(parseFloat(sunHourEl.value));
        });
        sunHourInputEl.addEventListener('change', () => {
            const parsed = parseSunHour(sunHourInputEl.value);
            if (parsed == null) {
                sunHourInputEl.value = formatSunHour(parseFloat(sunHourEl.value));
                return;
            }
            sunHourEl.value = String(parsed);
            sunHourInputEl.value = formatSunHour(parsed);
            sunHourEl.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    if (sunIntensityEl && sunIntensityInputEl && dirLight) {
        sunIntensityEl.value = String(dirLight.intensity);
        sunIntensityInputEl.value = formatSunIntensity(dirLight.intensity);
        sunIntensityEl.addEventListener('input', () => {
            const value = clampNumericInput(
                parseFloat(sunIntensityEl.value),
                parseFloat(sunIntensityEl.min) || 0,
                parseFloat(sunIntensityEl.max) || 20,
            );
            if (value == null) return;
            dirLight.intensity = value;
            sunIntensityEl.value = String(value);
            sunIntensityInputEl.value = formatSunIntensity(value);
            requestRender();
            onLightsUpdated();
        });
        sunIntensityInputEl.addEventListener('change', () => {
            let value = clampNumericInput(
                parseFloat(sunIntensityInputEl.value),
                parseFloat(sunIntensityInputEl.min) || 0,
                parseFloat(sunIntensityInputEl.max) || 20,
            );
            if (value == null) {
                sunIntensityInputEl.value = formatSunIntensity(dirLight.intensity);
                return;
            }
            sunIntensityEl.value = String(value);
            sunIntensityInputEl.value = formatSunIntensity(value);
            dirLight.intensity = value;
            requestRender();
            onLightsUpdated();
        });
    }

    return {
        formatSunHour,
        parseSunHour,
        formatSunIntensity,
    };
}
