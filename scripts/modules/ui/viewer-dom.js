export function collectViewerDom(document) {
    const get = (id) => document.getElementById(id);

    const statusEl = get('status');

    return {
        rootEl: get('viewer'),
        dropEl: get('drop'),
        statusEl,
        appbarStatusEl: get('appbarStatus') || statusEl,
        emptyHintEl: get('emptyHint'),
        shadingSel: get('shadingMode'),

        // Sun
        sunHourEl: get('sunHour'),
        sunHourInputEl: get('sunHourInput'),
        sunIntensityEl: get('sunIntensity'),
        sunIntensityInputEl: get('sunIntensityInput'),
        sunDayEl: get('sunDay'),
        sunMonthEl: get('sunMonth'),
        sunNorthEl: get('sunNorth'),
        sunEnabledEl: get('sunEnabled'),
        sunControlsEl: get('sunControls'),

        // Side panel sections
        imagesDetails: get('imagesDetails'),
        bindLogDetails: get('bindLogDetails'),

        // Environment / HDRI
        iblChk: get('hdriChk'),
        hdriPresetSel: get('hdriPreset'),
        iblIntEl: get('iblInt'),
        iblGammaEl: get('iblGamma'),
        iblTintEl: get('iblTint'),
        iblRotEl: get('iblRot'),
        hdriExposureEl: get('hdriExposure'),
        hdriSaturationEl: get('hdriSaturation'),
        hdriBlurEl: get('hdriBlur'),

        // Hemi light
        hemiIntEl: get('hemiInt'),
        hemiSkyEl: get('hemiSky'),
        hemiGroundEl: get('hemiGround'),

        // Appbar / buttons
        toggleSideBtn: get('toggleSideBtn'),
        loadParcelsBtn: get('loadParcelsBtn'),
        resetViewerBtn: get('resetViewerBtn'),
        resetViewBtn: get('resetViewBtn'),
        fullscreenBtn: get('fullscreenBtn'),
	        statsBtn: get('statsBtn'),
	        bgToggleBtn: get('bgToggleBtn'),
	        camsToggleBtn: get('camsToggleBtn'),
	        collToggleBtn: get('collToggleBtn'),
	        solidToggleBtn: get('solidToggleBtn'),
	        vpmToggleBtn: get('vpmToggleBtn'),
	        npmToggleBtn: get('npmToggleBtn'),
	        gridToggleBtn: get('gridToggleBtn'),
	        statsOverlayEl: get('statsOverlay'),

        // Cameras
        camsBarEl: get('camsBar'),
        camsBarListEl: get('camsBarList'),
        camsDetailsEl: get('camsDetails'),
        camsCountEl: get('camsCount'),
        camsSideListEl: get('camsSideList'),

        // Glass controls
        glassOpacityEl: get('glassOpacity'),
        glassIorEl: get('glassIor'),
        glassTransmissionEl: get('glassTransmission'),
        glassReflectEl: get('glassReflect'),
        glassRoughEl: get('glassRough'),
        glassMetalEl: get('glassMetal'),
        glassAttenDistEl: get('glassAttenDist'),
        glassAttenColorEl: get('glassAttenColor'),
        glassColorEl: get('glassColor'),
        glassResetBtn: get('glassReset'),

        // Materials panel / gallery
        outEl: get('out'),
        galleryEl: get('gallery'),
        texCountEl: get('texCount'),
        matSelect: get('matSelect'),
        bindLogEl: get('bindLog'),
        bgAlphaEl: get('bgAlpha'),
        sampleSelect: get('sampleSelect'),

        // Imported lights UI
        lightHelpersBtn: get('lightHelpersBtn'),
        lightEmittersBtn: get('lightEmittersBtn'),

        // Texture modal
        texModal: get('texModal'),
        mClose: get('mClose'),
        mImg: get('mImg'),
        mTitle: get('mTitle'),
        mFile: get('mFile'),
        mKind: get('mKind'),
        mMime: get('mMime'),
        dlLink: get('dlLink'),
        bindBtn: get('bindBtn'),
        slotSelect: get('slotSelect'),

        // File flow
        fileInput: get('fileInput'),
        openBtn: get('openBtn'),
    };
}
