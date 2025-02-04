import {expectTypeOf} from 'expect-type';
import {beforeEach, describe, test, vi} from 'vitest';

import fetchx from '../src/index';

describe('Type Tests', () => {
	beforeEach(() => {
		// Mock fetch to prevent actual network calls in type tests
		// Create a new Response for each call to avoid "Body already read" errors
		vi.spyOn(global, 'fetch').mockImplementation(() => Promise.resolve(new Response('{}', {status: 200})));
	});

	test('should return unknown when json: true is used without generic', () => {
		// Using json: true in request options
		const result1 = fetchx('https://example.com', {json: true});
		expectTypeOf(result1).toEqualTypeOf<Promise<unknown>>();

		// Using json: true with extend
		const extendedClient = fetchx.extend({json: true});
		const result2 = extendedClient('https://example.com');
		expectTypeOf(result2).toEqualTypeOf<Promise<unknown>>();
	});

	test('should return typed response when generic is provided with json: true', () => {
		interface User {
			id: number;
			name: string;
		}

		// Using generic with json: true in request options
		const result1 = fetchx<User>('https://example.com', {json: true});
		expectTypeOf(result1).toEqualTypeOf<Promise<User>>();

		// Using generic with json: true in extend
		const extendedClient = fetchx.extend({json: true});
		const result2 = extendedClient<User>('https://example.com');
		expectTypeOf(result2).toEqualTypeOf<Promise<User>>();
	});

	test('should return Response when json is false or not set', () => {
		// Without json option
		const result1 = fetchx('https://example.com');
		expectTypeOf(result1).toEqualTypeOf<Promise<Response>>();

		// With json: false
		const result2 = fetchx('https://example.com', {json: false});
		expectTypeOf(result2).toEqualTypeOf<Promise<Response>>();
	});

	test('should return typed response when generic is provided without json option', () => {
		interface ApiResponse {
			success: boolean;
		}

		// Generic without json option should still return Response
		// because json is not set to true
		const result = fetchx<ApiResponse>('https://example.com');
		expectTypeOf(result).toEqualTypeOf<Promise<Response>>();
	});

	test('should handle nested extends with json option', () => {
		interface Todo {
			id: number;
			title: string;
			completed: boolean;
		}

		const baseClient = fetchx.extend({prefixUrl: 'https://api.example.com'});
		const jsonClient = baseClient.extend({json: true});

		// With generic
		const result1 = jsonClient<Todo>('/todos/1');
		expectTypeOf(result1).toEqualTypeOf<Promise<Todo>>();

		// Without generic
		const result2 = jsonClient('/todos/2');
		expectTypeOf(result2).toEqualTypeOf<Promise<unknown>>();
	});

	test('should override extend json option with request-level option', () => {
		interface Data {
			value: string;
		}

		const jsonClient = fetchx.extend({json: true});

		// Override with json: false
		const result1 = jsonClient<Data>('https://example.com', {json: false});
		expectTypeOf(result1).toEqualTypeOf<Promise<Response>>();

		// Keep json: true from extend
		const result2 = jsonClient<Data>('https://example.com');
		expectTypeOf(result2).toEqualTypeOf<Promise<Data>>();
	});
});
