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

## Options

The module accepts all standard `fetch` options plus these additional features:

### Basic Options

- `json`: `boolean` - Automatically parse response as JSON
- `jsonBody`: `unknown` - Automatically JSON.stringify request body and set JSON headers
- `timeout`: `number` - Request timeout in milliseconds
- `prefixUrl`: `string` - Base URL to prepend to all request URLs
- `searchParams`: `string | URLSearchParams | Record<string, string> | string[][]` - Query parameters to append to URL, accepts same types as URLSearchParams

### Retry Options

```typescript
{
  retry: {
    retries: number;           // Number of retry attempts (default: 2)
    minTimeout: number;        // Minimum time between retries in ms (default: 50)
    maxRetryAfter: number;     // Maximum retry-after time to respect in ms
    statusCodes: number[];     // Status codes to retry (default: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524])
    networkErrors: boolean;    // Wether do retries on network errors (default: true)
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

### Hooks Example

```typescript
const client = fetchx.extend({
  beforeRequest: async (url, opts) => {
    // Modify request before it's sent
    return { url, opts };
  },
  afterResponse: async (response, url, opts) => {
    // Handle response
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
