import isNetworkError from 'is-network-error';
import {scheduler} from 'node:timers/promises';
import pRetry, {type Options as PRetryOptions, type RetryContext} from 'p-retry';

import {calculateRetryAfter, mergeHeaders} from './lib/utils.js';

const defaultRetryConfig: RetryOptions = {
	retries: 2,
	minTimeout: 50,
	statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524],
	networkErrors: true
};

export class HttpError extends Error {
	response: Response;
	statusCode: number;
	isRetryable: boolean;
	jsonBody?: unknown;

	constructor(response: Response, message?: string, options?: {isRetryable?: boolean; jsonBody?: unknown}) {
		super(message || `HTTP error! status: ${response.status}`);
		this.response = response;
		this.statusCode = response.status;
		this.isRetryable = options?.isRetryable ?? false;
		this.jsonBody = options?.jsonBody;
	}
}

async function getCookieHeader(cookieJar: ToughCookieJar, prefixUrl: string) {
	const cookieString: string = await cookieJar.getCookieString(prefixUrl);
	if (typeof cookieString === 'string' && cookieString.length > 0) {
		return {cookie: cookieString};
	}
	return undefined;
}

async function storeCookies(cookieJar: ToughCookieJar, url: string, rawCookies: string[]) {
	await Promise.all(rawCookies.map((rawCookie: string) => cookieJar.setCookie(rawCookie, url)));
}

async function processOptions(
	defaultOpts: CreateOptions,
	url: string | URL,
	options: RequestOptions
): Promise<{url: URL; opts: RequestOptionsWithHeaders}> {
	const {prefixUrl, ...defaults} = defaultOpts;
	let opts: RequestOptionsWithHeaders = {
		...defaults,
		...options,
		headers: mergeHeaders(defaults.headers, options.headers)
	};

	if (prefixUrl) {
		const urlString = url.toString();
		const normalizedUrl = urlString.startsWith('/') ? urlString.slice(1) : urlString;
		if (normalizedUrl === '') {
			url = new URL(prefixUrl);
		} else {
			const normalizedPrefix = prefixUrl.endsWith('/') ? prefixUrl : `${prefixUrl}/`;
			url = new URL(normalizedUrl, normalizedPrefix);
		}
	}

	if (!(url instanceof URL)) {
		url = new URL(url);
	}

	if (opts.searchParams) {
		url.search = new URLSearchParams(opts.searchParams).toString();
	}

	if (defaults.retry && opts.retry) {
		opts.retry = {...defaults.retry, ...opts.retry};
	}

	if (opts.jsonBody !== undefined) {
		if (opts.body !== undefined) {
			throw new TypeError('`jsonBody` cannot be used together with `body`.');
		}

		opts.body = JSON.stringify(opts.jsonBody);
		if (!opts.headers.has('content-type')) {
			opts.headers.set('content-type', 'application/json');
		}
		Reflect.deleteProperty(opts, 'jsonBody');
	}

	if (opts.cookieJar) {
		const cookieHeader = await getCookieHeader(opts.cookieJar, url.toString());
		if (cookieHeader) {
			opts.headers = mergeHeaders(opts.headers, cookieHeader);
		}
	}

	if (opts.timeout) {
		const timeoutSignal = AbortSignal.timeout(opts.timeout);
		opts.signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
	}

	if (opts.beforeRequest) {
		const {url: newUrl, opts: newOpts} = await opts.beforeRequest(url, opts);
		url = newUrl ?? url;
		opts = newOpts ? {...opts, ...newOpts} : opts;
	}

	return {url, opts};
}

function create(defaultOpts: CreateOptions = {}): Request {
	const defaults: CreateOptions = {
		...defaultOpts,
		retry: {...defaultRetryConfig, ...defaultOpts.retry}
	};

	async function request<T>(url: string | URL, opts: RequestOptions = {}): Promise<T | Response> {
		const {url: pUrl, opts: pOpts} = await processOptions(defaults, url, opts);

		return pRetry(
			async () => {
				let res = await fetch(pUrl, pOpts);

				if (pOpts.afterResponse) {
					res = await pOpts.afterResponse(res, pUrl, pOpts);
				}

				if (!res.ok) {
					let jsonBody: unknown;
					if (pOpts.json) {
						try {
							jsonBody = await res.json();
							// eslint-disable-next-line no-empty
						} catch {}
					}
					throw new HttpError(res, undefined, {jsonBody});
				}

				if (pOpts.cookieJar) {
					await storeCookies(pOpts.cookieJar, pUrl.toString(), res.headers.getSetCookie());
				}

				if (pOpts.json) {
					// Handle responses with no content (204, 205)
					if (res.status === 204 || res.status === 205) {
						return null as T;
					}
					return res.json() as Promise<T>;
				}

				return res;
			},
			{
				retries: pOpts.retry?.retries,
				minTimeout: pOpts.retry?.minTimeout,
				signal: pOpts.signal ?? undefined,
				async shouldRetry(context: RetryContext) {
					const {error} = context;
					if (!(error instanceof HttpError)) {
						if (pOpts.retry?.networkErrors && isNetworkError(error)) {
							return true;
						}
						return pOpts.retry?.shouldRetry ? pOpts.retry.shouldRetry(context) : false;
					}

					const shouldRetry = Boolean(
						error.isRetryable || (pOpts.retry?.statusCodes && pOpts.retry.statusCodes.includes(error.statusCode))
					);

					if (!shouldRetry) {
						return false;
					}

					const retryAfter = calculateRetryAfter(error.response);
					if (retryAfter) {
						if (pOpts.retry?.maxRetryAfter && retryAfter > pOpts.retry.maxRetryAfter) {
							return false;
						}
						await scheduler.wait(retryAfter);
					}

					return shouldRetry;
				},
				onFailedAttempt: pOpts.retry?.onFailedAttempt
			}
		);
	}

	request.extend = (extendOpts: CreateOptions) => {
		return create({...defaults, ...extendOpts});
	};

	return request;
}

export type RequestInitToHooks = Omit<RequestInit, 'headers'> & {headers: Headers};

type RequestOptionsWithHeaders = Omit<RequestOptions, 'headers'> & {
	headers: Headers;
};

export type RetryOptions = Pick<PRetryOptions, 'retries' | 'minTimeout' | 'onFailedAttempt'> & {
	/**
	 * Maximum retry after in ms (overrides retries)
	 * If retry-after header is greater than maxRetryAfter, the request will not be retried
	 */
	readonly maxRetryAfter?: number;
	/**
	 * Status codes to retry
	 */
	readonly statusCodes?: number[];
	/**
	 * Whether do retries on network errors
	 */
	readonly networkErrors?: boolean;

	/**
	 * Should retry will only be called for non HTTPError
	 * The exception being if networkErrors is true it will not be called with network related errors
	 */
	readonly shouldRetry?: (context: {
		error: Error;
		attemptNumber: number;
		retriesLeft: number;
	}) => boolean | Promise<boolean>;
};

export type URLSearchParamsInit = ConstructorParameters<typeof URLSearchParams>[0];

export type RequestOptions = RequestInit & {
	searchParams?: URLSearchParamsInit;
	cookieJar?: ToughCookieJar;
	json?: boolean;
	jsonBody?: unknown;
	timeout?: number;
	/**
	 *  Note this only occurs before the first request is made
	 */
	beforeRequest?: (url: URL, opts: RequestInitToHooks) => Promise<{url?: URL; opts?: RequestInitToHooks}>;
	/**
	 * You can throw HttpError with isRetryable: true from this hook to retry the request
	 * You may modify the url and opts here as well for the next request
	 */
	afterResponse?: (response: Response, url: URL, opts: RequestInitToHooks) => Promise<Response>;
	retry?: RetryOptions;
};

export type CreateOptions = RequestOptions & {
	prefixUrl?: string;
	cookieJar?: ToughCookieJar;
	json?: boolean;
};

export type Request<D extends CreateOptions = CreateOptions> = {
	<T = unknown>(url: string | URL): D['json'] extends true ? Promise<T> : Promise<Response>;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	<T = unknown>(url: string | URL, options?: RequestOptions & {json: false}): Promise<Response>;
	<T = unknown>(url: string | URL, options?: RequestOptions & {json: true}): Promise<T>;
	<T = unknown>(url: string | URL, options?: RequestOptions): D['json'] extends true ? Promise<T> : Promise<Response>;
	extend<T extends CreateOptions>(extendOpts: T): Request<T & D>;
};

export type ToughCookieJar = {
	getCookieString: (url: string) => Promise<string>;
	setCookie: (cookieOrString: string, currentUrl: string, options?: Record<string, unknown>) => Promise<unknown> | void;
};

export default create();
