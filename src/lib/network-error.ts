const networkErrorMessages = new Map([
	['ECONNABORTED', 'Connection was aborted'],
	['ECONNREFUSED', 'Connection refused by remote host'],
	['ECONNRESET', 'Connection was reset before the response completed'],
	['EAI_AGAIN', 'Temporary DNS lookup failure'],
	['ENETUNREACH', 'Network is unreachable'],
	['ENOTFOUND', 'DNS lookup failed'],
	['EHOSTUNREACH', 'Host is unreachable'],
	['ETIMEDOUT', 'Connection timed out'],
	['CERT_HAS_EXPIRED', 'TLS certificate has expired'],
	['CERT_NOT_YET_VALID', 'TLS certificate is not yet valid'],
	['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS certificate is self-signed'],
	['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS certificate hostname mismatch'],
	['SELF_SIGNED_CERT_IN_CHAIN', 'TLS certificate chain contains a self-signed certificate'],
	['UND_ERR_BODY_TIMEOUT', 'Timed out reading response body'],
	['UND_ERR_CONNECT_TIMEOUT', 'Connection timed out'],
	['UND_ERR_HEADERS_TIMEOUT', 'Timed out waiting for response headers'],
	['UND_ERR_SOCKET', 'Socket closed unexpectedly'],
	['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'TLS certificate issuer could not be verified'],
	['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS certificate chain could not be verified']
]);

type CodedError = Error & {code?: unknown; cause?: unknown};

export class NetworkError extends Error {
	code?: string;

	constructor(error: Error) {
		const code = getNetworkErrorCode(error);
		super(createNetworkErrorMessage(code), {cause: error});
		this.name = 'NetworkError';
		this.code = code;
	}
}

function getErrorCode(error: Error): string | undefined {
	const code = (error as CodedError).code;
	return typeof code === 'string' ? code : undefined;
}

function getErrorCause(error: Error): unknown {
	return (error as CodedError).cause;
}

function getNetworkErrorCode(error: Error): string | undefined {
	let current: Error = error;

	for (let depth = 0; depth < 8; depth += 1) {
		const code = getErrorCode(current);
		if (code) {
			return code;
		}

		const cause = getErrorCause(current);
		if (!(cause instanceof Error)) {
			break;
		}
		current = cause;
	}

	return undefined;
}

function createNetworkErrorMessage(code: string | undefined): string {
	if (!code) {
		return 'Network error';
	}

	const readableMessage = networkErrorMessages.get(code);

	return readableMessage ? `${readableMessage} (${code})` : `Network error (${code})`;
}
