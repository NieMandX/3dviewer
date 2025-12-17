export function createSunController(options = {}) {
    const THREE = options.THREE || null;
    const app = options.app || null;
    const dirLight = options.dirLight || null;
    const northGrid = options.northGrid || null;

    const latitude = Number.isFinite(options.latitude) ? options.latitude : 0;
    const longitude = Number.isFinite(options.longitude) ? options.longitude : 0;

    const getDay = typeof options.getDay === 'function' ? options.getDay : () => 1;
    const getMonth = typeof options.getMonth === 'function' ? options.getMonth : () => 6;
    const getHour = typeof options.getHour === 'function' ? options.getHour : () => 12;
    const getNorthDeg = typeof options.getNorthDeg === 'function' ? options.getNorthDeg : () => 0;

    const computeSceneBounds = typeof options.computeSceneBounds === 'function' ? options.computeSceneBounds : () => null;
    const fitSunShadowToScene = typeof options.fitSunShadowToScene === 'function' ? options.fitSunShadowToScene : () => {};
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : () => {};

    function sunPosition(date, lat, lon) {
        const rad = Math.PI / 180;
        const day = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);

        const M = (357.5291 + 0.98560028 * day) * rad;
        const L = (280.4665 + 0.98564736 * day) * rad + (1.915 * Math.sin(M) + 0.020 * Math.sin(2 * M)) * rad;
        const e = 23.439 * rad;

        const RA = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
        const dec = Math.asin(Math.sin(e) * Math.sin(L));

        const now = date.getUTCHours() + date.getUTCMinutes() / 60;
        const lst = (100.46 + 0.985647 * day + lon + 15 * now) * rad;
        const H = lst - RA;

        const latRad = lat * rad;
        const alt = Math.asin(Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(H));
        const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(latRad) - Math.sin(latRad) * Math.cos(H));

        return { altitude: alt, azimuth: az };
    }

    function updateSun() {
        if (!THREE || !dirLight || !dirLight.visible) return;

        const day = parseInt(getDay(), 10) || 1;
        const month = parseInt(getMonth(), 10) || 6;
        const hour = parseFloat(getHour()) || 12;
        const north = parseFloat(getNorthDeg()) || 0;

        const date = new Date();
        date.setUTCMonth(month - 1, day);
        date.setUTCHours(hour, 0, 0, 0);

        const { altitude, azimuth } = sunPosition(date, latitude, longitude);

        const northRad = THREE.MathUtils.degToRad(north) + Math.PI;
        const fullTurn = Math.PI * 2;
        const correctedAzimuth = (fullTurn - ((azimuth % fullTurn) + fullTurn) % fullTurn);
        const angle = correctedAzimuth - northRad;

        const dir = new THREE.Vector3(
            Math.cos(altitude) * Math.sin(angle),
            Math.sin(altitude),
            Math.cos(altitude) * Math.cos(angle)
        ).normalize();

        if (app?.sun) {
            app.sun.direction = dir.clone();
        }

        const box = computeSceneBounds();
        if (!box || box.isEmpty?.()) return;

        const center = box.getCenter(new THREE.Vector3());

        if (!dirLight.target.position.equals(center)) {
            dirLight.target.position.copy(center);
            dirLight.target.updateMatrixWorld();
        }

        const currDist = dirLight.position.distanceTo(dirLight.target.position) || 50;
        dirLight.position.copy(center).add(dir.multiplyScalar(currDist));
        dirLight.updateMatrixWorld();

        fitSunShadowToScene(false);
        northGrid?.updateNorthPointer?.();
        requestRender();
    }

    return {
        sunPosition,
        updateSun,
    };
}

