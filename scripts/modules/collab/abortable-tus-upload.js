export function makeAbortError(message = 'Upload aborted') {
    try {
        return new DOMException(message, 'AbortError');
    } catch (_) {
        const err = new Error(message);
        err.name = 'AbortError';
        return err;
    }
}

export function runAbortableOperation(operation, options = {}) {
    const signal = options.signal || null;
    const abortMessage = options.abortMessage || 'Operation aborted';
    const run = typeof operation === 'function' ? operation : () => operation;

    if (signal?.aborted) {
        return Promise.reject(signal.reason || makeAbortError(abortMessage));
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            try {
                signal?.removeEventListener?.('abort', handleAbort);
            } catch (_) {}
        };
        const finish = (callback, value) => {
            if (settled) return false;
            settled = true;
            cleanup();
            callback(value);
            return true;
        };
        function handleAbort() {
            finish(reject, signal?.reason || makeAbortError(abortMessage));
        }

        signal?.addEventListener?.('abort', handleAbort, { once: true });

        let result = null;
        try {
            result = run();
        } catch (err) {
            finish(reject, err);
            return;
        }

        Promise.resolve(result).then(
            (value) => {
                if (!finish(resolve, value)) {
                    try { options.onLateResolve?.(value); } catch (_) {}
                }
            },
            (err) => {
                if (!finish(reject, err)) {
                    try { options.onLateReject?.(err); } catch (_) {}
                }
            },
        );
    });
}

export async function runAbortableTusUpload(options = {}) {
    const UploadCtor = options.UploadCtor || options.tus?.Upload || null;
    const file = options.file || null;
    const signal = options.signal || null;
    const abortMessage = options.abortMessage || 'Upload aborted';

    if (!UploadCtor) throw new Error('TUS Upload constructor is required');
    if (!file) throw new Error('TUS file is required');

    let upload = null;
    let settled = false;
    let aborting = false;

    return new Promise((resolve, reject) => {
        const cleanup = () => {
            try {
                signal?.removeEventListener?.('abort', handleAbort);
            } catch (_) {}
        };

        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(value);
        };

        const rejectAbort = () => finish(reject, makeAbortError(abortMessage));

        function handleAbort() {
            if (settled || aborting) return;
            aborting = true;
            const maybeAbort = (() => {
                try {
                    return upload?.abort?.(true);
                } catch (_) {
                    return null;
                }
            })();
            if (maybeAbort && typeof maybeAbort.then === 'function') {
                maybeAbort.catch(() => {}).finally(rejectAbort);
            } else {
                rejectAbort();
            }
        }

        if (signal?.aborted) {
            rejectAbort();
            return;
        }

        signal?.addEventListener?.('abort', handleAbort, { once: true });

        const uploadOptions = {
            endpoint: options.endpoint,
            retryDelays: options.retryDelays,
            chunkSize: options.chunkSize,
            uploadDataDuringCreation: options.uploadDataDuringCreation,
            removeFingerprintOnSuccess: options.removeFingerprintOnSuccess,
            headers: options.headers,
            metadata: options.metadata,
            onProgress: (bytesUploaded, bytesTotal) => {
                if (signal?.aborted) return;
                options.onProgress?.(bytesUploaded, bytesTotal);
            },
            onError: (error) => {
                if (signal?.aborted) {
                    handleAbort();
                    return;
                }
                finish(reject, error);
            },
            onSuccess: () => {
                if (signal?.aborted) {
                    handleAbort();
                    return;
                }
                finish(resolve, true);
            },
        };

        const startUpload = () => {
            if (signal?.aborted) {
                handleAbort();
                return;
            }
            try {
                upload.start();
            } catch (err) {
                finish(reject, err);
            }
        };

        try {
            upload = new UploadCtor(file, uploadOptions);
        } catch (err) {
            finish(reject, err);
            return;
        }

        Promise.resolve(upload.findPreviousUploads?.())
            .then((previousUploads) => {
                if (signal?.aborted) {
                    handleAbort();
                    return;
                }
                if (Array.isArray(previousUploads) && previousUploads.length && typeof upload.resumeFromPreviousUpload === 'function') {
                    upload.resumeFromPreviousUpload(previousUploads[0]);
                }
                startUpload();
            })
            .catch(() => startUpload());
    });
}
