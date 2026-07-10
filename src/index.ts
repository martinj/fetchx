import isNetworkError from 'is-network-error';
import {scheduler} from 'node:timers/promises';
import pRetry, {type Options as PRetryOptions, type RetryContext} from 'p-retry';

import {NetworkError} from './lib/network-error.js';
import {calculateRetryAfter, mergeHeaders} from './lib/utils.js';

export {NetworkError} from './lib/network-error.js';

function normalizeNetworkError(error: unknown): unknown {
	if (error instanceof NetworkError) {
		return error;
	}
	if (error instanceof Error && isNetworkError(error)) {
		return new NetworkError(error);
	}
	return error;
}

const defaultRetryConfig: RetryOptions = {
	retries: 2,
	factor: 2,
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

const non2xxResponseErrors = new WeakSet<HttpError>();
const attemptSignalMetadata = new WeakMap<
	RequestInitToHooks,
	{baseSignal: AbortSignal | null | undefined; attemptSignal: AbortSignal | null | undefined; deadline?: number}
>();

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
): Promise<{url: URL; opts: RequestOptionsWithHeaders; firstAttemptDeadline?: number}> {
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

	if (defaults.retry && opts.retry) {
		opts.retry = {...defaults.retry, ...opts.retry};
	}

	let firstAttemptDeadline: number | undefined;

	if (opts.beforeRequest) {
		const hookOpts = createAttemptOptions(opts);
		const {url: newUrl, opts: newOpts} = await opts.beforeRequest(url, hookOpts);
		const resolvedHookOpts = resolveAttemptOptions(hookOpts, newOpts);
		const hookSignalMetadata = attemptSignalMetadata.get(hookOpts);
		const signalWasOverridden = resolvedHookOpts.signal !== hookSignalMetadata?.attemptSignal;
		url = newUrl ?? url;
		opts = persistAttemptOptions(resolvedHookOpts, hookOpts);
		firstAttemptDeadline = hookSignalMetadata && !signalWasOverridden ? hookSignalMetadata.deadline : undefined;
		if (signalWasOverridden) {
			Reflect.deleteProperty(opts, 'timeout');
		}
	}

	if (opts.searchParams) {
		url.search = new URLSearchParams(opts.searchParams).toString();
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

	return {url, opts, firstAttemptDeadline};
}

function createAttemptOptions(
	opts: RequestOptionsWithHeaders,
	deadline = opts.timeout ? Date.now() + opts.timeout : undefined
): RequestOptionsWithHeaders {
	const baseSignal = opts.signal;
	let signal = baseSignal;

	if (deadline !== undefined) {
		const timeoutSignal = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
		signal = baseSignal ? AbortSignal.any([baseSignal, timeoutSignal]) : timeoutSignal;
	}

	const attemptOpts = {...opts, signal};
	attemptSignalMetadata.set(attemptOpts, {baseSignal, attemptSignal: signal, deadline});
	return attemptOpts;
}

function resolveAttemptOptions(
	attemptOpts: RequestOptionsWithHeaders,
	returnedOpts?: RequestOptionsWithHeaders | BeforeRequestInitToHooks
): RequestOptionsWithHeaders {
	if (!returnedOpts || returnedOpts === attemptOpts) {
		return attemptOpts;
	}

	const resolvedOpts: RequestOptionsWithHeaders = {
		...attemptOpts,
		headers: attemptOpts.headers
	};

	Object.assign(resolvedOpts, returnedOpts);
	resolvedOpts.headers = returnedOpts.headers ?? attemptOpts.headers;

	return resolvedOpts;
}

function persistAttemptOptions(
	attemptOpts: RequestOptionsWithHeaders | RequestInitToHooks,
	sourceAttemptOpts: RequestInitToHooks = attemptOpts
): RequestOptionsWithHeaders {
	const persistedSignalMetadata = attemptSignalMetadata.get(sourceAttemptOpts);
	const persistedSignal =
		persistedSignalMetadata && attemptOpts.signal === persistedSignalMetadata.attemptSignal
			? persistedSignalMetadata.baseSignal
			: attemptOpts.signal;

	return {...attemptOpts, signal: persistedSignal};
}

function create(defaultOpts: CreateOptions = {}): Request {
	const defaults: CreateOptions = {
		...defaultOpts,
		retry: {...defaultRetryConfig, ...defaultOpts.retry}
	};

	async function request<T>(url: string | URL, opts: RequestOptions = {}): Promise<T | Response> {
		const {url: currentUrl, opts: pOpts, firstAttemptDeadline} = await processOptions(defaults, url, opts);
		const throwOnHttpError = pOpts.throwOnHttpError ?? true;
		let currentOpts = pOpts;
		let nextAttemptDeadline = firstAttemptDeadline;

		try {
			return await pRetry(
				async () => {
					const requestOpts = createAttemptOptions(currentOpts, nextAttemptDeadline);
					nextAttemptDeadline = undefined;
					let res: Response;
					try {
						res = await fetch(currentUrl, requestOpts);
					} catch (error) {
						throw normalizeNetworkError(error);
					}

					if (currentOpts.afterResponse) {
						try {
							res = await currentOpts.afterResponse(res, currentUrl, requestOpts);
						} finally {
							currentOpts = persistAttemptOptions(requestOpts);
						}
					}

					if (!res.ok) {
						if (!throwOnHttpError) {
							if (currentOpts.cookieJar) {
								await storeCookies(currentOpts.cookieJar, currentUrl.toString(), res.headers.getSetCookie());
							}
							const error = new HttpError(res);
							non2xxResponseErrors.add(error);
							throw error;
						}
						let jsonBody: unknown;
						if (currentOpts.json) {
							try {
								jsonBody = await res.json();
								// eslint-disable-next-line no-empty
							} catch {}
						}
						throw new HttpError(res, undefined, {jsonBody});
					}

					if (currentOpts.cookieJar) {
						await storeCookies(currentOpts.cookieJar, currentUrl.toString(), res.headers.getSetCookie());
					}

					if (currentOpts.json) {
						// Handle responses with no content (204, 205)
						if (res.status === 204 || res.status === 205) {
							return null as T;
						}
						try {
							return (await res.json()) as T;
						} catch (error) {
							throw normalizeNetworkError(error);
						}
					}

					return res;
				},
				{
					retries: pOpts.retry?.retries,
					factor: pOpts.retry?.factor,
					minTimeout: pOpts.retry?.minTimeout,
					signal: pOpts.signal ?? undefined,
					async shouldRetry(context: RetryContext) {
						const {error} = context;
						if (!(error instanceof HttpError)) {
							if (pOpts.retry?.networkErrors && error instanceof NetworkError) {
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
		} catch (error) {
			if (!throwOnHttpError && error instanceof HttpError && non2xxResponseErrors.has(error)) {
				return error.response;
			}
			throw error;
		}
	}

	request.extend = (extendOpts: CreateOptions) => {
		return create({...defaults, ...extendOpts});
	};

	return request;
}

export type RetryOptions = Pick<PRetryOptions, 'retries' | 'factor' | 'minTimeout' | 'onFailedAttempt'> & {
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

type RequestBaseOptions = RequestInit & {
	searchParams?: URLSearchParamsInit;
	cookieJar?: ToughCookieJar;
	json?: boolean;
	/**
	 * Throw HttpError for non-2xx responses (default true)
	 */
	throwOnHttpError?: boolean;
	jsonBody?: unknown;
	timeout?: number;
	retry?: RetryOptions;
};

export type RequestInitToHooks = Omit<
	RequestBaseOptions,
	'headers' | 'searchParams' | 'jsonBody' | 'retry' | 'throwOnHttpError'
> & {
	headers: Headers;
	afterResponse?: AfterResponseHook;
};

export type BeforeRequestInitToHooks = Omit<RequestBaseOptions, 'headers'> & {
	headers: Headers;
	afterResponse?: AfterResponseHook;
};

export type BeforeRequestHook = (
	url: URL,
	opts: BeforeRequestInitToHooks
) => Promise<{url?: URL; opts?: BeforeRequestInitToHooks}>;
export type AfterResponseHook = (response: Response, url: URL, opts: RequestInitToHooks) => Promise<Response>;

export type RequestOptions = RequestBaseOptions & {
	/**
	 *  Note this only occurs before the first request is made
	 */
	beforeRequest?: BeforeRequestHook;
	/**
	 * You can throw HttpError with isRetryable: true from this hook to retry the request
	 * You may modify the url and opts here as well for the next request
	 */
	afterResponse?: AfterResponseHook;
};

type RequestOptionsWithHeaders = Omit<RequestOptions, 'headers' | 'beforeRequest'> & {
	headers: Headers;
	beforeRequest?: BeforeRequestHook;
};

export type CreateOptions = RequestOptions & {
	prefixUrl?: string;
	cookieJar?: ToughCookieJar;
	json?: boolean;
};

type RequestReturn<D extends CreateOptions, T> = D extends {json: true}
	? D extends {throwOnHttpError: false} | {throwOnHttpError?: false}
		? Promise<T | Response>
		: Promise<T>
	: Promise<Response>;

type MergeOptions<D extends CreateOptions, O extends RequestOptions | undefined> = O extends RequestOptions
	? [RequestOptions] extends [O]
		? D
		: Omit<D, keyof O> & O
	: D;

type MergeExtend<D extends CreateOptions, O extends CreateOptions | undefined> = O extends CreateOptions
	? Omit<D, keyof O> & O
	: D;

export type Request<D extends CreateOptions = CreateOptions> = {
	<T = unknown>(url: string | URL): RequestReturn<D, T>;
	<
		T = unknown,
		O extends RequestOptions & {json: true; throwOnHttpError: true} = RequestOptions & {
			json: true;
			throwOnHttpError: true;
		}
	>(
		url: string | URL,
		options?: O
	): Promise<T>;
	<
		T = unknown,
		O extends RequestOptions & {json: true; throwOnHttpError: false} = RequestOptions & {
			json: true;
			throwOnHttpError: false;
		}
	>(
		url: string | URL,
		options?: O
	): Promise<T | Response>;
	<
		T = unknown,
		O extends RequestOptions & {json: true; throwOnHttpError?: undefined} = RequestOptions & {
			json: true;
			throwOnHttpError?: undefined;
		}
	>(
		url: string | URL,
		options?: O
	): D extends {throwOnHttpError: false} | {throwOnHttpError?: false} ? Promise<T | Response> : Promise<T>;
	<T = unknown, O extends RequestOptions & {json: true} = RequestOptions & {json: true}>(
		url: string | URL,
		options?: O
	): Promise<T | Response>;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	<T = unknown, O extends RequestOptions & {json: false} = RequestOptions & {json: false}>(
		url: string | URL,
		options?: O
	): Promise<Response>;
	<
		T = unknown,
		O extends RequestOptions & {throwOnHttpError: false; json?: true} = RequestOptions & {
			throwOnHttpError: false;
			json?: true;
		}
	>(
		url: string | URL,
		options?: O
	): D extends {json: true} ? Promise<T | Response> : Promise<Response>;
	<T = unknown, O extends RequestOptions = RequestOptions>(
		url: string | URL,
		options?: O
	): RequestReturn<MergeOptions<D, O>, T>;
	extend<T extends CreateOptions>(extendOpts: T): Request<MergeExtend<D, T>>;
};

export type ToughCookieJar = {
	getCookieString: (url: string) => Promise<string>;
	setCookie: (cookieOrString: string, currentUrl: string, options?: Record<string, unknown>) => Promise<unknown> | void;
};

export default create();
