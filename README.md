# @martinj/fetchx

fetch with extras

## Installation

```bash
npm install @martinj/fetchx
```

## Usage

```typescript
import fetchx from '@martinj/fetchx';

// Basic GET request
const response = await fetchx('https://api.example.com/data');

// GET request with JSON response
const data = await fetchx('https://api.example.com/data', { json: true });

// POST request with JSON body
const result = await fetchx('https://api.example.com/create', {
  method: 'POST',
  jsonBody: { name: 'John' }
});

// Using search parameters
// Note this use URLSearchParams so it doesn't support nested objects as `qs` does
const searchResult = await fetchx('https://api.example.com/search', {
  searchParams: {
    q: 'search term',
    page: '1'
  }
});

// Creating an instance with default options
const api = fetchx.extend({
  prefixUrl: 'https://api.example.com',
  headers: {
    'Authorization': 'Bearer token'
  },
  json: true
});

// Using the configured instance
const userData = await api('/users/123');
```

## Use cases

### Service-to-service resilience (timeout + retry)

```typescript
const res = await fetchx('https://service.internal/health', {
  timeout: 1500,
  retry: {retries: 2, factor: 1, minTimeout: 100, statusCodes: [503, 504]}
});
```

`timeout` applies to each request attempt. Retry delays and later attempts get their own timeout budget.

Set `factor: 1` for constant backoff. The default `factor: 2` uses exponential backoff.

### Total operation deadline

```typescript
await fetchx('https://api.example.com/data', {
  timeout: 1500,
  signal: AbortSignal.timeout(5000),
  retry: {retries: 2, minTimeout: 100}
});
```

Use `signal` for a global deadline or cancellation shared across retries. If both `timeout` and `signal` are provided, whichever aborts first cancels the current attempt.

If a hook replaces `opts.signal`, that replacement becomes the active signal for later work and retries. In `beforeRequest`, replacing `opts.signal` also overrides the internal timeout signal for the first fetch attempt.

### Rate-limit handling (Retry-After)

```typescript
await fetchx('https://api.example.com/limit', {
  retry: {retries: 3, minTimeout: 0, statusCodes: [429], maxRetryAfter: 10_000}
});
```

### Cookie-backed session

```typescript
import {CookieJar} from 'tough-cookie';

const cookieJar = new CookieJar();
const res = await fetchx('https://example.com/me', {cookieJar});
```

### Request signing / auth header

```typescript
const client = fetchx.extend({
  async beforeRequest(url, opts) {
    opts.headers.set('authorization', `Bearer ${process.env.TOKEN}`);
    return {url, opts};
  }
});

await client('https://api.example.com/secure');
```

## Options

The module accepts all standard `fetch` options plus these additional features:

### Basic Options

- `json`: `boolean` - Automatically parse response as JSON
- `throwOnHttpError`: `boolean` - Throw `HttpError` for non-2xx responses (default: true)
- `jsonBody`: `unknown` - Automatically JSON.stringify request body and set JSON headers
- `timeout`: `number` - Per-request-attempt timeout in milliseconds
- `prefixUrl`: `string` - Base URL to prepend to all request URLs
- `searchParams`: `string | URLSearchParams | Record<string, string> | string[][]` - Query parameters to append to URL, accepts same types as URLSearchParams
- `signal`: `AbortSignal` - Cancels the whole operation, including retry delays and future attempts

### Retry Options

```typescript
{
  retry: {
    retries: number;           // Number of retry attempts (default: 2)
    factor: number;            // Backoff multiplier (default: 2, use 1 for constant delays)
    minTimeout: number;        // Minimum time between retries in ms (default: 50)
    maxRetryAfter: number;     // Maximum retry-after time to respect in ms
    statusCodes: number[];     // Status codes to retry (default: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524])
    networkErrors: boolean;    // Whether to retry on network errors (default: true)
    onFailedAttempt: (context: {error: Error; attemptNumber: number; retriesLeft: number;}) => void | Promise<void> | undefined

    /**
     * Should retry will only be called for non HTTPError
     * The exception being if networkErrors is true it will not be called with network related errors
     */
    shouldRetry: (context: {error: Error; attemptNumber: number; retriesLeft: number;}) => boolean | Promise<boolean>
  }
}
```

### Advanced Options

- `cookieJar`: Cookie jar instance for handling cookies across requests
- `beforeRequest`: Hook function called before the request is made
- `afterResponse`: Hook function called after receiving the response

### Hook semantics

Hooks receive normalized request state:

- `headers` is always a mutable `Headers` instance
- `beforeRequest` runs after `searchParams` has already been applied to `url`
- `beforeRequest` runs after `jsonBody` has already been serialized into `body`
- `beforeRequest` can mutate `url`, `headers`, `body`, `method`, `signal`, and other live request fields
- `afterResponse` can mutate request options for later retry attempts

Some original input fields are already consumed before hooks run:

- changing `opts.searchParams` in `beforeRequest` has no effect; update `url.searchParams` instead
- changing `opts.jsonBody` in `beforeRequest` has no effect; update `opts.body` instead

Retry-time hook mutations are preserved for later attempts. This includes:

- mutating or replacing `opts.headers`
- replacing `opts.signal`
- reassigning `opts.cookieJar`
- deleting options like `opts.afterResponse` to disable them on retries

### Hooks Example

```typescript
const client = fetchx.extend({
  beforeRequest: async (url, opts) => {
    // url/search params and body are already normalized here
    url.searchParams.set('trace', '1');
    opts.headers.set('authorization', 'Bearer token');
    return { url, opts };
  },
  afterResponse: async (response, url, opts) => {
    // Mutations here affect later retry attempts
    return response;
  }
});
```

### Custom Retry Logic with HttpError

You can throw `HttpError` with `isRetryable: true` from the `afterResponse` hook to implement custom retry logic based on response content or specific conditions:

```typescript
import fetchx, { HttpError } from '@martinj/fetchx';

const client = fetchx.extend({
  retry: {
    retries: 3,
    minTimeout: 1000
  },
  afterResponse: async (response, url, opts) => {
    // Retry on specific response conditions
    if (response.ok) {
      const data = await response.json();

      // Custom retry logic based on response body
      if (data.status === 'processing' || data.requiresRetry) {
        throw new HttpError(response, 'Resource not ready, retrying...', {
          isRetryable: true,
          jsonBody: data
        });
      }

      // Return a new Response with the parsed data
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: response.headers
      });
    }

    return response;
  }
});

// The request will automatically retry if the response indicates processing
const result = await client('https://api.example.com/async-job', { json: true });
```

This is particularly useful for:
- Polling async operations until complete
- Retrying on specific error codes in the response body
- Implementing custom backoff strategies based on response headers
- Handling rate limits with custom logic

Note: The `jsonBody` property on `HttpError` allows you to access the parsed response body in error handlers without consuming the response stream again.

## TypeScript

Return type depends on `json` and `throwOnHttpError`:
- `json: true` (or `extend({json: true})`) + `throwOnHttpError: true` (default) => `Promise<T>`
- `json: true` + `throwOnHttpError: false` => `Promise<T | Response>`
- otherwise => `Promise<Response>`

```typescript
// json: true => typed JSON
const user = await fetchx<User>('https://api.example.com/users/1', {json: true});

// no json => Response
const res = await fetchx('https://api.example.com/users/1');

// extend default json, override per call
const api = fetchx.extend({json: true});
const a = await api<User>('/users/1'); // Promise<User>
const b = await api('/users/1', {json: false}); // Promise<Response>
const c = await api('/users/1', {throwOnHttpError: false}); // Promise<User | Response>
```

## Error Handling

The module throws `HttpError` for non-2xx responses:

```typescript
try {
  await fetchx('https://api.example.com/data');
} catch (error) {
  if (error instanceof HttpError) {
    console.log(error.statusCode);  // HTTP status code
    console.log(error.response);    // Original Response object
  }
}
```

To handle non-2xx responses without exceptions, set `throwOnHttpError: false`:

```typescript
const res = await fetchx('https://example.com', {
  redirect: 'manual',
  throwOnHttpError: false
});

if (res.status >= 300 && res.status < 400) {
  console.log(res.headers.get('location'));
}
```

Note: When `json: true` and `throwOnHttpError: false`, non-2xx responses return a raw `Response` (not parsed JSON).

## Runtime

- Node.js 22+ (global `fetch` / `Response`)
- Works in Bun (uses standard `fetch` APIs)
