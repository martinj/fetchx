export function calculateRetryAfter(response: Response): number | undefined {
	const retryAfter = response.headers?.get('Retry-After');
	if (!retryAfter) {
		return undefined;
	}
	let retryAfterSeconds = Number(retryAfter);
	if (isNaN(retryAfterSeconds)) {
		retryAfterSeconds = Date.parse(retryAfter) - Date.now();
		if (retryAfterSeconds <= 0) {
			retryAfterSeconds = 1;
		}
	} else {
		retryAfterSeconds = Math.floor(retryAfterSeconds * 1000);
	}
	return retryAfterSeconds;
}

export function mergeHeaders(
	defaults: RequestInit['headers'] | undefined,
	options: RequestInit['headers'] | undefined
): Headers {
	const base = new Headers(defaults);
	if (options) {
		if (options instanceof Headers) {
			options.forEach((v, k) => {
				base.set(k, v);
			});
		} else {
			for (const [k, v] of Object.entries(options)) {
				if (Array.isArray(v)) {
					base.set(k, v.join(', '));
				} else {
					base.set(k, v as string);
				}
			}
		}
	}
	return base;
}
