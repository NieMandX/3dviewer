import { loadLiveKitClient } from './livekit-browser.js';

function normalizeApiUrl(value) {
    const url = String(value || '').trim();
    return url.replace(/\/+$/, '');
}

function safeName(value, fallback = 'Guest') {
    const text = String(value || '').trim();
    return text || fallback;
}

function makeParticipantSnapshot(participant, activeSpeakerIds, isLocal = false) {
    if (!participant) return null;
    const identity = String(participant.identity || '').trim() || String(participant.sid || '').trim();
    if (!identity) return null;
    return {
        id: identity,
        name: safeName(participant.name, identity),
        isLocal,
        speaking: activeSpeakerIds.has(identity),
    };
}

export function createVoiceController(options = {}) {
    const voiceApiUrl = normalizeApiUrl(options.voiceApiUrl);
    const audioMountEl = options.audioMountEl || null;
    const onState = typeof options.onState === 'function' ? options.onState : () => {};

    if (!voiceApiUrl) {
        throw new Error('Voice API URL is missing.');
    }

    let sdk = null;
    let room = null;
    let connecting = false;
    let micEnabled = false;
    let disposed = false;
    let lifecycleGeneration = 0;
    let activeTokenAbortController = null;
    let nextFallbackTrackId = 0;
    const attachedAudio = new Map();
    const fallbackTrackKeys = new WeakMap();
    const roomEventCleanups = new WeakMap();

    function emitState(extra = {}) {
        if (disposed) return;
        const activeSpeakerIds = new Set(
            Array.isArray(room?.activeSpeakers)
                ? room.activeSpeakers
                    .map((participant) => String(participant?.identity || '').trim())
                    .filter(Boolean)
                : []
        );
        const participants = [];
        const localSnapshot = makeParticipantSnapshot(room?.localParticipant, activeSpeakerIds, true);
        if (localSnapshot) participants.push(localSnapshot);
        if (room?.remoteParticipants?.forEach) {
            room.remoteParticipants.forEach((participant) => {
                const snapshot = makeParticipantSnapshot(participant, activeSpeakerIds, false);
                if (snapshot) participants.push(snapshot);
            });
        }
        participants.sort((a, b) => {
            if (a.isLocal && !b.isLocal) return -1;
            if (!a.isLocal && b.isLocal) return 1;
            return String(a.name || '').localeCompare(String(b.name || ''));
        });

        onState({
            connected: !!room && !connecting,
            connecting,
            micEnabled,
            participants,
            ...extra,
        });
    }

    function clearAudioTracks() {
        attachedAudio.forEach(({ track, el }) => {
            try { track?.detach?.(el); } catch (_) {}
            try { el?.remove?.(); } catch (_) {}
        });
        attachedAudio.clear();
    }

    function trackKey(trackPublication, track) {
        const explicit = String(trackPublication?.trackSid || track?.sid || '').trim();
        if (explicit) return explicit;
        const target = (trackPublication && typeof trackPublication === 'object')
            ? trackPublication
            : ((track && typeof track === 'object') ? track : null);
        if (!target) {
            nextFallbackTrackId += 1;
            return `fallback:${nextFallbackTrackId}`;
        }
        let key = fallbackTrackKeys.get(target);
        if (!key) {
            nextFallbackTrackId += 1;
            key = `fallback:${nextFallbackTrackId}`;
            fallbackTrackKeys.set(target, key);
        }
        return key;
    }

    function attachAudioTrack(trackPublication, track) {
        if (disposed) return;
        if (!audioMountEl || !track?.attach) return;
        const key = trackKey(trackPublication, track);
        if (attachedAudio.has(key)) return;
        const element = track.attach();
        if (!element) return;
        element.autoplay = true;
        element.playsInline = true;
        element.dataset.voiceTrackId = key;
        audioMountEl.appendChild(element);
        attachedAudio.set(key, { track, el: element });
    }

    function detachAudioTrack(trackPublication, track) {
        const key = trackKey(trackPublication, track);
        const attached = attachedAudio.get(key);
        if (!attached) return;
        try { attached.track?.detach?.(attached.el); } catch (_) {}
        try { attached.el?.remove?.(); } catch (_) {}
        attachedAudio.delete(key);
    }

    function isCurrentRoom(nextRoom, generation) {
        return !disposed && generation === lifecycleGeneration && room === nextRoom;
    }

    function bindRoomEvent(nextRoom, event, handler, cleanups) {
        if (!nextRoom?.on || !event || typeof handler !== 'function') return;
        nextRoom.on(event, handler);
        cleanups.push(() => {
            try {
                if (typeof nextRoom.off === 'function') {
                    nextRoom.off(event, handler);
                } else if (typeof nextRoom.removeListener === 'function') {
                    nextRoom.removeListener(event, handler);
                } else if (typeof nextRoom.removeEventListener === 'function') {
                    nextRoom.removeEventListener(event, handler);
                }
            } catch (_) {}
        });
    }

    function unbindRoomEvents(nextRoom) {
        if (!nextRoom || (typeof nextRoom !== 'object' && typeof nextRoom !== 'function')) return;
        const cleanups = roomEventCleanups.get(nextRoom);
        if (!cleanups) return;
        roomEventCleanups.delete(nextRoom);
        cleanups.forEach((cleanup) => cleanup());
    }

    function bindRoomEvents(nextRoom, generation) {
        const RoomEvent = sdk?.RoomEvent || {};
        const TrackKind = sdk?.Track?.Kind || {};
        const audioKind = TrackKind.Audio || 'audio';
        const cleanups = [];
        const refresh = () => {
            if (!isCurrentRoom(nextRoom, generation)) return;
            emitState();
        };

        unbindRoomEvents(nextRoom);
        bindRoomEvent(nextRoom, RoomEvent.ParticipantConnected, refresh, cleanups);
        bindRoomEvent(nextRoom, RoomEvent.ParticipantDisconnected, refresh, cleanups);
        bindRoomEvent(nextRoom, RoomEvent.ActiveSpeakersChanged, refresh, cleanups);
        bindRoomEvent(nextRoom, RoomEvent.LocalTrackPublished, refresh, cleanups);
        bindRoomEvent(nextRoom, RoomEvent.LocalTrackUnpublished, refresh, cleanups);
        bindRoomEvent(nextRoom, RoomEvent.TrackMuted, refresh, cleanups);
        bindRoomEvent(nextRoom, RoomEvent.TrackUnmuted, refresh, cleanups);
        bindRoomEvent(nextRoom, RoomEvent.ConnectionStateChanged, refresh, cleanups);

        bindRoomEvent(nextRoom, RoomEvent.TrackSubscribed, (track, publication) => {
            if (!isCurrentRoom(nextRoom, generation)) return;
            const kind = track?.kind || publication?.kind || '';
            if (kind === audioKind) attachAudioTrack(publication, track);
            refresh();
        }, cleanups);

        bindRoomEvent(nextRoom, RoomEvent.TrackUnsubscribed, (track, publication) => {
            if (!isCurrentRoom(nextRoom, generation)) return;
            const kind = track?.kind || publication?.kind || '';
            if (kind === audioKind) detachAudioTrack(publication, track);
            refresh();
        }, cleanups);

        bindRoomEvent(nextRoom, RoomEvent.Disconnected, () => {
            if (!isCurrentRoom(nextRoom, generation)) return;
            unbindRoomEvents(nextRoom);
            clearAudioTracks();
            room = null;
            connecting = false;
            micEnabled = false;
            emitState({ reason: 'disconnected' });
        }, cleanups);
        roomEventCleanups.set(nextRoom, cleanups);
    }

    async function requestToken(session, signal = null) {
        const response = await fetch(`${voiceApiUrl}/v1/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(session),
            signal: signal || undefined,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.token || !payload?.wsUrl) {
            throw new Error(payload?.error || 'Voice token request failed.');
        }
        return payload;
    }

    async function connect(session = {}) {
        if (disposed || room || connecting) return;
        const generation = ++lifecycleGeneration;
        connecting = true;
        emitState();
        let nextRoom = null;
        const tokenAbortController = typeof AbortController === 'function' ? new AbortController() : null;
        activeTokenAbortController = tokenAbortController;
        try {
            sdk = sdk || await loadLiveKitClient();
            if (disposed || generation !== lifecycleGeneration) return;
            const tokenPayload = await requestToken(session, tokenAbortController?.signal || null);
            if (disposed || generation !== lifecycleGeneration) return;
            nextRoom = new sdk.Room();
            room = nextRoom;
            bindRoomEvents(nextRoom, generation);
            await nextRoom.connect(tokenPayload.wsUrl, tokenPayload.token);
            if (disposed || generation !== lifecycleGeneration || room !== nextRoom) {
                unbindRoomEvents(nextRoom);
                try { await nextRoom.disconnect?.(); } catch (_) {}
                return;
            }
            if (typeof nextRoom.startAudio === 'function') {
                try { await nextRoom.startAudio(); } catch (_) {}
            }
            if (disposed || generation !== lifecycleGeneration || room !== nextRoom) {
                unbindRoomEvents(nextRoom);
                try { await nextRoom.disconnect?.(); } catch (_) {}
                return;
            }
            await nextRoom.localParticipant.setMicrophoneEnabled(true);
            if (disposed || generation !== lifecycleGeneration || room !== nextRoom) {
                try { await nextRoom.localParticipant?.setMicrophoneEnabled?.(false); } catch (_) {}
                unbindRoomEvents(nextRoom);
                try { await nextRoom.disconnect?.(); } catch (_) {}
                return;
            }
            micEnabled = true;
            connecting = false;
            emitState({ roomName: tokenPayload.room });
        } catch (error) {
            const isCurrentConnect = !disposed && generation === lifecycleGeneration;
            const ownsActiveRoom = !!nextRoom && room === nextRoom;
            if (isCurrentConnect) connecting = false;
            if (ownsActiveRoom) clearAudioTracks();
            if (nextRoom) {
                unbindRoomEvents(nextRoom);
                try { await nextRoom.disconnect?.(); } catch (_) {}
            }
            if (!isCurrentConnect) return;
            room = null;
            micEnabled = false;
            emitState({ error: error instanceof Error ? error.message : 'Voice connect failed' });
            throw error;
        } finally {
            if (activeTokenAbortController === tokenAbortController) {
                activeTokenAbortController = null;
            }
            if (generation === lifecycleGeneration && connecting && room !== nextRoom) {
                connecting = false;
                emitState();
            }
        }
    }

    async function disconnect() {
        lifecycleGeneration += 1;
        const tokenAbortController = activeTokenAbortController;
        activeTokenAbortController = null;
        try {
            if (tokenAbortController && !tokenAbortController.signal?.aborted) {
                tokenAbortController.abort();
            }
        } catch (_) {}
        connecting = false;
        const activeRoom = room;
        room = null;
        micEnabled = false;
        clearAudioTracks();
        unbindRoomEvents(activeRoom);
        if (activeRoom?.disconnect) {
            try {
                await activeRoom.disconnect();
            } catch (_) {}
        }
        emitState({ reason: 'manual-disconnect' });
    }

    async function setMuted(muted) {
        const activeRoom = room;
        const generation = lifecycleGeneration;
        if (disposed || !activeRoom?.localParticipant?.setMicrophoneEnabled) return;
        const nextEnabled = !muted;
        await activeRoom.localParticipant.setMicrophoneEnabled(nextEnabled);
        if (disposed || generation !== lifecycleGeneration || room !== activeRoom) return;
        micEnabled = nextEnabled;
        emitState();
    }

    async function toggleMute() {
        await setMuted(micEnabled);
    }

    async function dispose() {
        if (disposed) return;
        disposed = true;
        await disconnect();
    }

    return Object.freeze({
        connect,
        disconnect,
        dispose,
        setMuted,
        toggleMute,
        isConnected: () => !!room && !connecting,
    });
}
