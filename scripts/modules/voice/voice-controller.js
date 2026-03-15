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
    const attachedAudio = new Map();

    function emitState(extra = {}) {
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
            connected: !!room,
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
        return String(trackPublication?.trackSid || track?.sid || Math.random()).trim();
    }

    function attachAudioTrack(trackPublication, track) {
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

    function bindRoomEvents(nextRoom) {
        const RoomEvent = sdk?.RoomEvent || {};
        const TrackKind = sdk?.Track?.Kind || {};
        const audioKind = TrackKind.Audio || 'audio';
        const refresh = () => emitState();

        nextRoom.on(RoomEvent.ParticipantConnected, refresh);
        nextRoom.on(RoomEvent.ParticipantDisconnected, refresh);
        nextRoom.on(RoomEvent.ActiveSpeakersChanged, refresh);
        nextRoom.on(RoomEvent.LocalTrackPublished, refresh);
        nextRoom.on(RoomEvent.LocalTrackUnpublished, refresh);
        nextRoom.on(RoomEvent.TrackMuted, refresh);
        nextRoom.on(RoomEvent.TrackUnmuted, refresh);
        nextRoom.on(RoomEvent.ConnectionStateChanged, refresh);

        nextRoom.on(RoomEvent.TrackSubscribed, (track, publication) => {
            const kind = track?.kind || publication?.kind || '';
            if (kind === audioKind) attachAudioTrack(publication, track);
            refresh();
        });

        nextRoom.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
            const kind = track?.kind || publication?.kind || '';
            if (kind === audioKind) detachAudioTrack(publication, track);
            refresh();
        });

        nextRoom.on(RoomEvent.Disconnected, () => {
            clearAudioTracks();
            room = null;
            connecting = false;
            micEnabled = false;
            emitState({ reason: 'disconnected' });
        });
    }

    async function requestToken(session) {
        const response = await fetch(`${voiceApiUrl}/v1/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(session),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.token || !payload?.wsUrl) {
            throw new Error(payload?.error || 'Voice token request failed.');
        }
        return payload;
    }

    async function connect(session = {}) {
        if (room || connecting) return;
        connecting = true;
        emitState();
        try {
            sdk = sdk || await loadLiveKitClient();
            const tokenPayload = await requestToken(session);
            const nextRoom = new sdk.Room();
            bindRoomEvents(nextRoom);
            await nextRoom.connect(tokenPayload.wsUrl, tokenPayload.token);
            room = nextRoom;
            if (typeof nextRoom.startAudio === 'function') {
                try { await nextRoom.startAudio(); } catch (_) {}
            }
            await nextRoom.localParticipant.setMicrophoneEnabled(true);
            micEnabled = true;
            connecting = false;
            emitState({ roomName: tokenPayload.room });
        } catch (error) {
            connecting = false;
            clearAudioTracks();
            if (room) {
                try { room.disconnect?.(); } catch (_) {}
            }
            room = null;
            micEnabled = false;
            emitState({ error: error instanceof Error ? error.message : 'Voice connect failed' });
            throw error;
        }
    }

    async function disconnect() {
        connecting = false;
        const activeRoom = room;
        room = null;
        micEnabled = false;
        clearAudioTracks();
        if (activeRoom?.disconnect) {
            try {
                await activeRoom.disconnect();
            } catch (_) {}
        }
        emitState({ reason: 'manual-disconnect' });
    }

    async function setMuted(muted) {
        if (!room?.localParticipant?.setMicrophoneEnabled) return;
        const nextEnabled = !muted;
        await room.localParticipant.setMicrophoneEnabled(nextEnabled);
        micEnabled = nextEnabled;
        emitState();
    }

    async function toggleMute() {
        await setMuted(micEnabled);
    }

    async function dispose() {
        await disconnect();
    }

    return Object.freeze({
        connect,
        disconnect,
        dispose,
        setMuted,
        toggleMute,
        isConnected: () => !!room,
    });
}
