export function collectViewerDom(document) {
    const get = (id) => document.getElementById(id);

    const statusEl = get('status');

    return {
        rootEl: get('viewer'),
        annotateCanvasEl: get('annotateCanvas'),
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
        exportBtn: get('exportBtn'),
        pathTraceBtn: get('pathTraceBtn'),
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
        camPropsDetailsEl: get('camPropsDetails'),
        camPropsTitleEl: get('camPropsTitle'),
        camPropsPanelEl: get('camPropsPanel'),

        // Path trace
        pathTraceHudEl: get('pathTraceHud'),
        pathTraceSamplesEl: get('pathTraceSamples'),
        pathTraceSpeedEl: get('pathTraceSpeed'),
        pathTraceShotBtn: get('pathTraceShot'),
        pathTracePanelEl: get('pathTracePanel'),
        ptBouncesEl: get('ptBounces'),
        ptTransmissiveEl: get('ptTransmissive'),
        ptGlossyEl: get('ptGlossy'),
        ptClampEl: get('ptClamp'),
        ptRenderScaleEl: get('ptRenderScale'),
        ptLowResScaleEl: get('ptLowResScale'),
        ptTilesXEl: get('ptTilesX'),
        ptTilesYEl: get('ptTilesY'),
        ptDynamicLowResEl: get('ptDynamicLowRes'),
        ptStableNoiseEl: get('ptStableNoise'),
        ptMISEl: get('ptMIS'),
        ptPauseEl: get('ptPause'),
        ptResetBtn: get('ptReset'),

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

        // Prompt modal
        promptModalEl: get('promptModal'),
        promptTitleEl: get('promptTitle'),
        promptInputEl: get('promptInput'),
        promptOkBtn: get('promptOk'),
        promptCancelBtn: get('promptCancel'),
        promptCloseBtn: get('promptClose'),

        // Confirm modal
        confirmModalEl: get('confirmModal'),
        confirmTitleEl: get('confirmTitle'),
        confirmMessageEl: get('confirmMessage'),
        confirmOkBtn: get('confirmOk'),
        confirmCancelBtn: get('confirmCancel'),
        confirmCloseBtn: get('confirmClose'),

        // Transition modal
        transitionModalEl: get('transitionModal'),
        transitionTitleEl: get('transitionTitle'),
        transitionSecondsEl: get('transitionSeconds'),
        transitionTypeEl: get('transitionType'),
        transitionOkBtn: get('transitionOk'),
        transitionCancelBtn: get('transitionCancel'),
        transitionCloseBtn: get('transitionClose'),

        // Export modal
        exportModalEl: get('exportModal'),
        exportTitleEl: get('exportTitle'),
        exportFormatEl: get('exportFormat'),
        exportCoordsEl: get('exportCoords'),
        exportOkBtn: get('exportOk'),
        exportCancelBtn: get('exportCancel'),
        exportCloseBtn: get('exportClose'),

        // File flow
        fileInput: get('fileInput'),
        openBtn: get('openBtn'),
    };
}
