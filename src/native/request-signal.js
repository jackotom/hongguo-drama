// SPDX-License-Identifier: GPL-3.0-only
// Request-local cancellation: never abort a caller's or another consumer's signal.
function abortError(signal) {
    const timeout = signal?.reason?.name === 'TimeoutError';
    return Object.assign(new Error(timeout ? 'App 片源请求超时' : '已取消 App 片源请求'), {
        code: timeout ? 'ETIMEDOUT' : 'ERR_CANCELED',
    });
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError(signal);
}

function boundedSignal(parent, timeout) {
    const controller = new AbortController();
    const timeoutReason = () => Object.assign(new Error('App 片源请求超时'), { name: 'TimeoutError' });
    const abort = () => controller.abort(parent?.reason?.name === 'TimeoutError' ? timeoutReason() : undefined);
    let timer;
    if (parent?.aborted) abort();
    else {
        parent?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => controller.abort(timeoutReason()), timeout);
        timer.unref?.();
    }
    return { signal: controller.signal, dispose() {
        clearTimeout(timer);
        parent?.removeEventListener('abort', abort);
    } };
}

// Fixed transport codes only; never retain axios config/cause, response or identity.
function networkFailure(code) {
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'DNS';
    if (['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED'].includes(code)) return 'CONNECTION';
    if (['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
        'ERR_SSL_WRONG_VERSION_NUMBER', 'EPROTO'].includes(code)) return 'TLS';
    return undefined;
}

module.exports = { abortError, throwIfAborted, boundedSignal, networkFailure };
