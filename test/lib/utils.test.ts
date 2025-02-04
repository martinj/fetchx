import {describe, expect, test} from 'vitest';

import {calculateRetryAfter} from '../../src/lib/utils';

describe('calculateRetryAfter', () => {
	test('should return undefined when no Retry-After header is present', () => {
		const response = new Response(null, {status: 429});
		expect(calculateRetryAfter(response)).toBeUndefined();
	});

	test('should parse Retry-After header with seconds', () => {
		const response = new Response(null, {
			status: 429,
			headers: {'Retry-After': '120'}
		});
		expect(calculateRetryAfter(response)).toBe(120000); // 120 seconds in milliseconds
	});

	test('should parse Retry-After header with HTTP date', () => {
		const futureDate = new Date(Date.now() + 60000); // 1 minute in the future
		const response = new Response(null, {
			status: 429,
			headers: {'Retry-After': futureDate.toUTCString()}
		});
		const result = calculateRetryAfter(response);
		expect(result).toBeGreaterThan(59000); // Should be close to 60000, but allow some flexibility
		expect(result).toBeLessThan(61000);
	});

	test('should return 1ms if HTTP date is in the past', () => {
		const pastDate = new Date(Date.now() - 60000); // 1 minute in the past
		const response = new Response(null, {
			status: 429,
			headers: {'Retry-After': pastDate.toUTCString()}
		});
		expect(calculateRetryAfter(response)).toBe(1);
	});
});
