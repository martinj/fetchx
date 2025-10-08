import type {IncomingMessage, ServerResponse} from 'node:http';
import {createServer as createHttpServer} from 'node:http';
import {scheduler} from 'node:timers/promises';
import {CookieJar} from 'tough-cookie';
import {afterEach, describe, expect, test, vi} from 'vitest';

import fetchx, {HttpError, type RequestInitToHooks} from '../src/index';

describe('request', () => {
	let server: {stop: () => Promise<void>};

	afterEach(async () => {
		vi.restoreAllMocks();
		await server?.stop();
	});

	test('should make a successful GET request', async () => {
		const url = 'https://jsonplaceholder.typicode.com/todos/1';
		const mockResponse = new Response(JSON.stringify({id: 1, title: 'delectus aut autem'}), {status: 200});
		vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL) => {
			expect(input.toString()).toBe(url);
			return Promise.resolve(mockResponse);
		});

		const response = await fetchx(url);
		expect(response).toBeInstanceOf(Response);
		expect(response.status).toBe(200);
	});

	test('should parse JSON response when json option is true', async () => {
		const mockData = {id: 1, title: 'delectus aut autem'};
		vi.spyOn(global, 'fetch').mockImplementation(() =>
			Promise.resolve(new Response(JSON.stringify(mockData), {status: 200}))
		);

		const data = await fetchx<typeof mockData>('https://jsonplaceholder.typicode.com/todos/1', {json: true});
		expect(data.id).toBe(1);
		expect(data.title).toBe('delectus aut autem');
	});

	test('should handle 204 response with json option without throwing', async () => {
		vi.spyOn(global, 'fetch').mockImplementation(() => Promise.resolve(new Response(null, {status: 204})));

		const data = await fetchx('https://example.com/delete', {json: true});
		expect(data).toBeNull();
	});

	test('should stringify jsonBody and set JSON headers', async () => {
		const payload = {name: 'John'};
		const mockFetch = vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
			expect(init?.body).toBe(JSON.stringify(payload));
			const headers = init?.headers as Headers;
			expect(headers.get('content-type')).toBe('application/json');
			expect(headers.get('accept')).toBeNull();
			return Promise.resolve(new Response(null, {status: 200}));
		});

		const response = await fetchx('https://example.com', {
			method: 'POST',
			jsonBody: payload
		});

		expect(response.status).toBe(200);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	test('should respect existing headers when using jsonBody', async () => {
		const payload = {name: 'John'};
		const mockFetch = vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
			expect(init?.body).toBe(JSON.stringify(payload));
			const headers = init?.headers as Headers;
			expect(headers.get('content-type')).toBe('application/vnd.custom+json');
			expect(headers.get('accept')).toBe('application/vnd.custom+json');
			return Promise.resolve(new Response(null, {status: 200}));
		});

		await fetchx('https://example.com', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/vnd.custom+json',
				Accept: 'application/vnd.custom+json'
			},
			jsonBody: payload
		});

		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	test('should throw when jsonBody is used with body', async () => {
		await expect(
			fetchx('https://example.com', {
				method: 'POST',
				body: 'already set',
				jsonBody: {foo: 'bar'}
			})
		).rejects.toThrow('`jsonBody` cannot be used together with `body`.');
	});

	test('should handle query parameters', async () => {
		const mockData = [{id: 1, userId: 1, title: 'delectus aut autem'}];
		vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL) => {
			const url = input instanceof URL ? input : new URL(input.toString());
			expect(url.searchParams.get('userId')).toBe('1');
			return Promise.resolve(new Response(JSON.stringify(mockData), {status: 200}));
		});

		const response = await fetchx('https://jsonplaceholder.typicode.com/todos', {
			searchParams: {userId: '1'}
		});
		const data = await response.json();
		expect(Array.isArray(data)).toBe(true);
		expect(data.length).toBeGreaterThan(0);
		expect(data[0].userId).toBe(1);
	});

	test('should throw HttpError for non-200 responses', async () => {
		vi.spyOn(global, 'fetch').mockImplementation(() => Promise.resolve(new Response('Not Found', {status: 404})));

		await expect(fetchx('https://jsonplaceholder.typicode.com/nonexistent')).rejects.toThrow(HttpError);
	});

	test('should include jsonBody in HttpError when json option is true and response contains JSON', async () => {
		const errorBody = {error: 'Not Found', message: 'Resource does not exist'};
		vi.spyOn(global, 'fetch').mockImplementation(() =>
			Promise.resolve(new Response(JSON.stringify(errorBody), {status: 404}))
		);

		try {
			await fetchx('https://jsonplaceholder.typicode.com/nonexistent', {json: true});
			expect.fail('Should have thrown HttpError');
		} catch (error) {
			expect(error).toBeInstanceOf(HttpError);
			if (error instanceof HttpError) {
				expect(error.jsonBody).toEqual(errorBody);
				expect(error.statusCode).toBe(404);
			}
		}
	});

	test('should not include jsonBody in HttpError when json option is false', async () => {
		const errorBody = {error: 'Not Found', message: 'Resource does not exist'};
		vi.spyOn(global, 'fetch').mockImplementation(() =>
			Promise.resolve(new Response(JSON.stringify(errorBody), {status: 404}))
		);

		try {
			await fetchx('https://jsonplaceholder.typicode.com/nonexistent', {json: false});
			expect.fail('Should have thrown HttpError');
		} catch (error) {
			expect(error).toBeInstanceOf(HttpError);
			if (error instanceof HttpError) {
				expect(error.jsonBody).toBeUndefined();
				expect(error.statusCode).toBe(404);
			}
		}
	});

	test('should not include jsonBody in HttpError when json option is not set', async () => {
		const errorBody = {error: 'Not Found', message: 'Resource does not exist'};
		vi.spyOn(global, 'fetch').mockImplementation(() =>
			Promise.resolve(new Response(JSON.stringify(errorBody), {status: 404}))
		);

		try {
			await fetchx('https://jsonplaceholder.typicode.com/nonexistent');
			expect.fail('Should have thrown HttpError');
		} catch (error) {
			expect(error).toBeInstanceOf(HttpError);
			if (error instanceof HttpError) {
				expect(error.jsonBody).toBeUndefined();
				expect(error.statusCode).toBe(404);
			}
		}
	});

	test('should handle non-JSON response body gracefully when json option is true', async () => {
		vi.spyOn(global, 'fetch').mockImplementation(() =>
			Promise.resolve(new Response('Plain text error', {status: 500}))
		);

		try {
			await fetchx('https://jsonplaceholder.typicode.com/error', {json: true});
			expect.fail('Should have thrown HttpError');
		} catch (error) {
			expect(error).toBeInstanceOf(HttpError);
			if (error instanceof HttpError) {
				expect(error.jsonBody).toBeUndefined();
				expect(error.statusCode).toBe(500);
			}
		}
	});

	test('should handle empty response body when json option is true', async () => {
		vi.spyOn(global, 'fetch').mockImplementation(() => Promise.resolve(new Response('', {status: 400})));

		try {
			await fetchx('https://jsonplaceholder.typicode.com/error', {json: true});
			expect.fail('Should have thrown HttpError');
		} catch (error) {
			expect(error).toBeInstanceOf(HttpError);
			if (error instanceof HttpError) {
				expect(error.jsonBody).toBeUndefined();
				expect(error.statusCode).toBe(400);
			}
		}
	});

	test('should retry on specified status codes', async () => {
		const mockFetch = vi
			.spyOn(global, 'fetch')
			.mockRejectedValueOnce(new HttpError({status: 503} as Response))
			.mockResolvedValueOnce(new Response('OK', {status: 200}));

		const response = await fetchx('https://example.com', {
			retry: {retries: 1, minTimeout: 0, statusCodes: [503]}
		});

		expect(response.status).toBe(200);
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	test('should retry by default on retryable status (503) without passing retry option', async () => {
		// regression for a bug with default retry config not being applied
		const mockFetch = vi
			.spyOn(global, 'fetch')
			.mockRejectedValueOnce(new HttpError({status: 503} as Response))
			.mockResolvedValueOnce(new Response('OK', {status: 200}));

		const response = await fetchx('https://example.com');

		expect(response.status).toBe(200);
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	test('should merge retry options from defaults and request options', async () => {
		const extendedRequest = fetchx.extend({
			retry: {retries: 3, statusCodes: [500]}
		});

		const mockFetch = vi
			.spyOn(global, 'fetch')
			.mockRejectedValueOnce(new HttpError({status: 503} as Response))
			.mockResolvedValueOnce(new Response('OK', {status: 200}));

		const response = await extendedRequest('https://example.com', {
			retry: {minTimeout: 0, statusCodes: [503]}
		});

		// Should merge: retries: 3 (from defaults), minTimeout: 0 (from request), statusCodes: [503] (from request, overrides default)
		expect(response.status).toBe(200);
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	test('should handle cookies with CookieJar', async () => {
		const cookieJar = new CookieJar();
		await cookieJar.setCookie('session=123456', 'https://httpbin.org');

		vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
			expect((init?.headers as Headers).get('cookie')).toBe('session=123456');
			return Promise.resolve(new Response(JSON.stringify({cookies: {session: '123456'}}), {status: 200}));
		});

		const response = await fetchx('https://httpbin.org/cookies', {cookieJar});
		const data = await response.json();

		expect(data.cookies.session).toBe('123456');
	});

	test('should apply beforeRequest hook', async () => {
		vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
			expect(init?.headers).toBeInstanceOf(Headers);
			expect((init?.headers as Headers).get('x-custom-header')).toBe('test-value');
			expect(input instanceof URL).toBe(true);
			expect((input as URL).searchParams.get('userId')).toBe('1');
			return Promise.resolve(new Response(JSON.stringify({headers: {'X-Custom-Header': 'test-value'}}), {status: 200}));
		});

		const response = await fetchx('https://httpbin.org/headers', {
			async beforeRequest(url: URL, opts: RequestInitToHooks) {
				opts.headers.set('X-Custom-Header', 'test-value');
				url.searchParams.set('userId', '1');
				return {url, opts};
			}
		});

		const data = await response.json();
		expect(data.headers['X-Custom-Header']).toBe('test-value');
	});

	test('should extend request with new defaults', async () => {
		const extendedRequest = fetchx.extend({
			prefixUrl: 'https://jsonplaceholder.typicode.com',
			headers: {'X-API-Key': 'test-key'},
			json: true
		});

		vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof URL ? input : new URL(input.toString());
			expect(url.toString()).toBe('https://jsonplaceholder.typicode.com/todos/1');
			const headers = new Headers(init?.headers ?? {});
			expect(headers.get('x-api-key')).toBe('test-key');
			return Promise.resolve(new Response(JSON.stringify({id: 1}), {status: 200}));
		});

		const response = await extendedRequest<{id: number}>('/todos/1');
		expect(response.id).toBe(1);
	});

	describe('prefixUrl handling', () => {
		test('should preserve base path when url starts with slash', async () => {
			const extendedRequest = fetchx.extend({
				prefixUrl: 'http://base.com/v1'
			});

			vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL) => {
				const url = input instanceof URL ? input : new URL(input.toString());
				expect(url.toString()).toBe('http://base.com/v1/users');
				return Promise.resolve(new Response('OK', {status: 200}));
			});

			await extendedRequest('/users');
		});

		test('should preserve base path when url does not start with slash', async () => {
			const extendedRequest = fetchx.extend({
				prefixUrl: 'http://base.com/v1'
			});

			vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL) => {
				const url = input instanceof URL ? input : new URL(input.toString());
				expect(url.toString()).toBe('http://base.com/v1/users');
				return Promise.resolve(new Response('OK', {status: 200}));
			});

			await extendedRequest('users');
		});

		test('should handle prefixUrl with trailing slash and path with leading slash', async () => {
			const extendedRequest = fetchx.extend({
				prefixUrl: 'http://base.com/v1/'
			});

			vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL) => {
				const url = input instanceof URL ? input : new URL(input.toString());
				expect(url.toString()).toBe('http://base.com/v1/users');
				return Promise.resolve(new Response('OK', {status: 200}));
			});

			await extendedRequest('/users');
		});

		test('should handle nested paths with prefixUrl', async () => {
			const extendedRequest = fetchx.extend({
				prefixUrl: 'http://base.com/api/v2'
			});

			vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL) => {
				const url = input instanceof URL ? input : new URL(input.toString());
				expect(url.toString()).toBe('http://base.com/api/v2/users/123/posts');
				return Promise.resolve(new Response('OK', {status: 200}));
			});

			await extendedRequest('/users/123/posts');
		});

		test('should handle empty path with prefixUrl', async () => {
			const extendedRequest = fetchx.extend({
				prefixUrl: 'http://base.com/v1/users'
			});

			vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL) => {
				const url = input instanceof URL ? input : new URL(input.toString());
				expect(url.toString()).toBe('http://base.com/v1/users');
				return Promise.resolve(new Response('OK', {status: 200}));
			});

			await extendedRequest('');
		});

		test('should handle prefixUrl without base path', async () => {
			const extendedRequest = fetchx.extend({
				prefixUrl: 'http://base.com'
			});

			vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL) => {
				const url = input instanceof URL ? input : new URL(input.toString());
				expect(url.toString()).toBe('http://base.com/users');
				return Promise.resolve(new Response('OK', {status: 200}));
			});

			await extendedRequest('/users');
		});
	});

	test('should throw an error when request exceeds timeout', async () => {
		const timeout = 10;

		server = createServer(async () => {
			await scheduler.wait(500);
			return new Response('OK');
		});

		await expect(fetchx('http://localhost:9393', {timeout})).rejects.toThrow(/timeout|timed out/);
	});

	test('should combine timeout signal with existing abort signal', async () => {
		const abortController = new AbortController();
		const timeout = 100;
		let fetchCalled = false;

		vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
			fetchCalled = true;
			expect(init?.signal).toBeDefined();
			// Return a promise that rejects when the signal is aborted
			return new Promise((resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(new DOMException('This operation was aborted', 'AbortError'));
				});
			});
		});

		const requestPromise = fetchx('https://example.com', {
			timeout,
			signal: abortController.signal
		});

		// Abort the user signal after a short delay
		setTimeout(() => abortController.abort(), 50);

		await expect(requestPromise).rejects.toThrow('This operation was aborted');
		expect(fetchCalled).toBe(true);
	});

	test('should respect existing abort signal when timeout is also set', async () => {
		const abortController = new AbortController();

		vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
			expect(init?.signal).toBeDefined();
			// Return a promise that rejects when the signal is aborted
			return new Promise((resolve, reject) => {
				if (init?.signal?.aborted) {
					reject(new DOMException('This operation was aborted', 'AbortError'));
					return;
				}
				init?.signal?.addEventListener('abort', () => {
					reject(new DOMException('This operation was aborted', 'AbortError'));
				});
			});
		});

		const requestPromise = fetchx('https://example.com', {
			timeout: 1000, // Long timeout, should be aborted by user signal first
			signal: abortController.signal
		});

		// Abort after a small delay to ensure fetch is called
		setTimeout(() => abortController.abort(), 10);

		await expect(requestPromise).rejects.toThrow('This operation was aborted');
	});

	test('should timeout when user signal does not abort first', async () => {
		const abortController = new AbortController();
		const timeout = 50;

		server = createServer(async () => {
			await scheduler.wait(500); // Long delay
			return new Response('OK');
		});

		const requestPromise = fetchx('http://localhost:9393', {
			timeout,
			signal: abortController.signal
		});

		// Don't abort the user signal, let timeout happen first
		await expect(requestPromise).rejects.toThrow(/timeout|timed out/);
	});

	test('should retry based on Retry-After header', async () => {
		let first = true;
		let time;
		let diff = 0;
		server = createServer(async () => {
			if (first) {
				first = false;
				time = Date.now();
				return new Response(null, {status: 429, headers: {'Retry-After': '1'}});
			}
			diff = Date.now() - time!;
			return new Response('OK');
		});

		const response = await fetchx('http://localhost:9393/retry', {
			retry: {retries: 2, minTimeout: 0, statusCodes: [429]}
		});

		expect(response.status).toBe(200);
		expect(diff).toBeGreaterThanOrEqual(1000);
	});

	test('should apply afterResponse hook', async () => {
		vi.spyOn(global, 'fetch').mockImplementation(() => {
			return Promise.resolve(
				new Response(JSON.stringify({status: 'success'}), {
					status: 200,
					headers: {'x-response-header': 'original'}
				})
			);
		});

		const response = await fetchx('https://httpbin.org/status/200', {
			async afterResponse(response: Response) {
				const modified = response.clone();
				const headers = new Headers(modified.headers);
				headers.set('x-modified-header', 'modified');
				return new Response(modified.body, {
					status: modified.status,
					statusText: modified.statusText,
					headers
				});
			}
		});

		expect(response.headers.get('x-modified-header')).toBe('modified');
		expect(response.status).toBe(200);
	});

	test('should retry with modified headers when afterResponse throws HttpRetryError', async () => {
		const mockFetch = vi
			.spyOn(global, 'fetch')
			.mockImplementationOnce((input: RequestInfo | URL, init?: RequestInit) => {
				// First request doesn't have the auth header
				expect((init?.headers as Headers).get('Authorization')).toBeNull();
				return Promise.resolve(new Response(null, {status: 401}));
			})
			.mockImplementationOnce((input: RequestInfo | URL, init?: RequestInit) => {
				// Second request should have the auth header
				expect((init?.headers as Headers).get('Authorization')).toBe('Bearer new-token');
				return Promise.resolve(new Response(JSON.stringify({status: 'success'}), {status: 200}));
			});

		const response = await fetchx('https://httpbin.org/status/401', {
			retry: {retries: 1, minTimeout: 0, statusCodes: [401]},
			async afterResponse(response: Response, url: URL, requestInit: RequestInitToHooks) {
				if (response.status === 401) {
					// Simulate refreshing a token and updating headers
					requestInit.headers.set('Authorization', 'Bearer new-token');
					throw new HttpError(response, undefined, {isRetryable: true});
				}
				return response;
			}
		});

		expect(response.status).toBe(200);
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	test('should handle afterResponse errors', async () => {
		vi.spyOn(global, 'fetch').mockImplementation(() => {
			return Promise.resolve(new Response(JSON.stringify({status: 'error'}), {status: 500}));
		});

		await expect(
			fetchx('https://httpbin.org/status/500', {
				async afterResponse() {
					throw new Error('Custom afterResponse error');
				}
			})
		).rejects.toThrow('Custom afterResponse error');
	});

	describe('header merging', () => {
		test('should merge plain object headers correctly', async () => {
			const extendedRequest = fetchx.extend({
				headers: {'X-Default': 'default-value', 'Content-Type': 'application/json'}
			});

			vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
				const headers = init?.headers as Headers;
				expect(headers.get('x-default')).toBe('default-value');
				expect(headers.get('content-type')).toBe('text/plain');
				expect(headers.get('x-custom')).toBe('custom-value');
				return Promise.resolve(new Response('OK', {status: 200}));
			});

			await extendedRequest('https://example.com', {
				headers: {'X-Custom': 'custom-value', 'Content-Type': 'text/plain'}
			});
		});

		test('should merge Headers instance with plain object headers', async () => {
			const defaultHeaders = new Headers({'X-Default': 'default-value', Authorization: 'Bearer token1'});
			const extendedRequest = fetchx.extend({
				headers: defaultHeaders
			});

			vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
				const headers = init?.headers as Headers;
				expect(headers.get('x-default')).toBe('default-value');
				expect(headers.get('authorization')).toBe('Bearer token2');
				expect(headers.get('x-custom')).toBe('custom-value');
				return Promise.resolve(new Response('OK', {status: 200}));
			});

			await extendedRequest('https://example.com', {
				headers: {'X-Custom': 'custom-value', Authorization: 'Bearer token2'}
			});
		});

		test('should merge plain object with Headers instance headers', async () => {
			const extendedRequest = fetchx.extend({
				headers: {'X-Default': 'default-value', 'Content-Type': 'application/json'}
			});

			const requestHeaders = new Headers({'X-Custom': 'custom-value', 'Content-Type': 'text/plain'});

			vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
				const headers = init?.headers as Headers;
				expect(headers.get('x-default')).toBe('default-value');
				expect(headers.get('content-type')).toBe('text/plain');
				expect(headers.get('x-custom')).toBe('custom-value');
				return Promise.resolve(new Response('OK', {status: 200}));
			});

			await extendedRequest('https://example.com', {
				headers: requestHeaders
			});
		});

		test('should merge Headers instance with Headers instance', async () => {
			const defaultHeaders = new Headers({'X-Default': 'default-value', Authorization: 'Bearer token1'});
			const extendedRequest = fetchx.extend({
				headers: defaultHeaders
			});

			const requestHeaders = new Headers({'X-Custom': 'custom-value', Authorization: 'Bearer token2'});

			vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
				const headers = init?.headers as Headers;
				expect(headers.get('x-default')).toBe('default-value');
				expect(headers.get('authorization')).toBe('Bearer token2');
				expect(headers.get('x-custom')).toBe('custom-value');
				return Promise.resolve(new Response('OK', {status: 200}));
			});

			await extendedRequest('https://example.com', {
				headers: requestHeaders
			});
		});

		test('should properly merge headers with cookies', async () => {
			const cookieJar = new CookieJar();
			await cookieJar.setCookie('session=abc123', 'https://example.com');

			const defaultHeaders = new Headers({'X-Default': 'default-value'});
			const extendedRequest = fetchx.extend({
				headers: defaultHeaders,
				cookieJar
			});

			const requestHeaders = new Headers({'X-Custom': 'custom-value'});

			vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
				const headers = init?.headers as Headers;
				expect(headers.get('x-default')).toBe('default-value');
				expect(headers.get('x-custom')).toBe('custom-value');
				expect(headers.get('cookie')).toBe('session=abc123');
				return Promise.resolve(new Response('OK', {status: 200}));
			});

			await extendedRequest('https://example.com', {
				headers: requestHeaders
			});
		});

		test('should handle undefined/null headers gracefully', async () => {
			const extendedRequest = fetchx.extend({
				headers: undefined
			});

			vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
				const headers = init?.headers as Headers;
				expect(headers.get('x-custom')).toBe('custom-value');
				return Promise.resolve(new Response('OK', {status: 200}));
			});

			await extendedRequest('https://example.com', {
				headers: {'X-Custom': 'custom-value'}
			});
		});

		test('should preserve header case sensitivity correctly', async () => {
			const defaultHeaders = new Headers({'Content-Type': 'application/json'});
			const extendedRequest = fetchx.extend({
				headers: defaultHeaders
			});

			vi.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
				const headers = init?.headers as Headers;
				// Headers are case-insensitive, but the value should be preserved
				expect(headers.get('content-type')).toBe('text/plain');
				expect(headers.get('Content-Type')).toBe('text/plain');
				return Promise.resolve(new Response('OK', {status: 200}));
			});

			await extendedRequest('https://example.com', {
				headers: {'content-type': 'text/plain'}
			});
		});
	});

	describe('network error handling', () => {
		test('should retry on network errors by default', async () => {
			const networkError = new TypeError('fetch failed');
			Object.assign(networkError, {
				cause: {
					code: 'ECONNREFUSED',
					errno: -61,
					syscall: 'connect'
				}
			});

			const mockFetch = vi
				.spyOn(global, 'fetch')
				.mockRejectedValueOnce(networkError)
				.mockResolvedValueOnce(new Response('OK', {status: 200}));

			const response = await fetchx('http://localhost:9999', {
				retry: {retries: 1, minTimeout: 0}
			});

			expect(response.status).toBe(200);
			expect(mockFetch).toHaveBeenCalledTimes(2);
		});

		test('should not retry on network errors when networkErrors is false', async () => {
			const networkError = new TypeError('fetch failed');
			Object.assign(networkError, {
				cause: {
					code: 'ECONNREFUSED',
					errno: -61,
					syscall: 'connect'
				}
			});

			vi.spyOn(global, 'fetch').mockRejectedValueOnce(networkError);

			await expect(
				fetchx('http://localhost:9999', {
					retry: {retries: 1, minTimeout: 0, networkErrors: false}
				})
			).rejects.toThrow('fetch failed');
		});

		test('should use shouldRetry for non-HttpError and non-network errors', async () => {
			const customError = new Error('Custom error');
			let shouldRetryCalled = false;

			const mockFetch = vi
				.spyOn(global, 'fetch')
				.mockRejectedValueOnce(customError)
				.mockResolvedValueOnce(new Response('OK', {status: 200}));

			const response = await fetchx('http://localhost:9999', {
				retry: {
					retries: 1,
					minTimeout: 0,
					shouldRetry: (context) => {
						shouldRetryCalled = true;
						expect(context.error).toBe(customError);
						return true;
					}
				}
			});

			expect(shouldRetryCalled).toBe(true);
			expect(response.status).toBe(200);
			expect(mockFetch).toHaveBeenCalledTimes(2);
		});

		test('should not call shouldRetry for network errors when networkErrors is true', async () => {
			const networkError = new TypeError('fetch failed');
			Object.assign(networkError, {
				cause: {
					code: 'ECONNREFUSED',
					errno: -61,
					syscall: 'connect'
				}
			});

			let shouldRetryCalled = false;

			const mockFetch = vi
				.spyOn(global, 'fetch')
				.mockRejectedValueOnce(networkError)
				.mockResolvedValueOnce(new Response('OK', {status: 200}));

			const response = await fetchx('http://localhost:9999', {
				retry: {
					retries: 1,
					minTimeout: 0,
					networkErrors: true,
					shouldRetry: () => {
						shouldRetryCalled = true;
						return false;
					}
				}
			});

			expect(shouldRetryCalled).toBe(false);
			expect(response.status).toBe(200);
			expect(mockFetch).toHaveBeenCalledTimes(2);
		});
	});
});

function createServer(handler: (req: Request) => Promise<Response>) {
	if (typeof Bun !== 'undefined') {
		const server = Bun.serve({
			port: 9393,
			fetch: handler
		});

		return {
			stop: () => server.stop(true)
		};
	}

	const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
		try {
			// Convert Node.js request to fetch Request
			const url = new URL(req.url ?? '', `http://${req.headers.host}`);
			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) {
				if (value) headers.set(key, value as string);
			}

			const chunks: Buffer[] = [];
			for await (const chunk of req) {
				chunks.push(chunk);
			}
			const body = Buffer.concat(chunks);

			const request = new Request(url, {
				method: req.method,
				headers,
				body: body.length > 0 ? body : undefined
			});

			// Call the handler and convert Response to Node.js response
			const response = await handler(request);
			res.statusCode = response.status;
			response.headers.forEach((value, key) => {
				res.setHeader(key, value);
			});

			if (response.body) {
				const reader = response.body.getReader();
				while (true) {
					const {done, value} = await reader.read();
					if (done) break;
					res.write(value);
				}
			}
			res.end();
		} catch (error) {
			console.error('Server error:', error);
			res.statusCode = 500;
			res.end('Internal Server Error');
		}
	});

	server.listen(9393);

	return {
		stop: () => new Promise<void>((resolve) => server.close(() => resolve()))
	};
}
