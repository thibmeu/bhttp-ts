# bhttp-ts

A [BHTTP (RFC 9292: Binary Representation of HTTP Messages)](https://datatracker.ietf.org/doc/html/rfc9292) encoder and decoder for the [Request](https://developer.mozilla.org/en-US/docs/Web/API/Request)/[Response](https://developer.mozilla.org/en-US/docs/Web/API/Response) interface of [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API).

This module works on Node.js, Cloudflare Workers, and other JavaScript runtimes supporting the Fetch API.

> **Note**: This is a fork of [dajiaji/bhttp-js](https://github.com/dajiaji/bhttp-js), converted from Deno to a standard npm package.

## Installation

```sh
npm install bhttp-ts
```

## Usage

### Encode/Decode Request

```ts
import { BHttpDecoder, BHttpEncoder } from "bhttp-ts";

const req = new Request("https://www.example.com/hello.txt", {
  method: "GET",
  headers: {
    "User-Agent": "curl/7.16.3 libcurl/7.16.3 OpenSSL/0.9.7l zlib/1.2.3",
    "Accept-Language": "en, mi",
  },
});

// Encode a Request object to a BHTTP binary
const encoder = new BHttpEncoder();
const binReq = await encoder.encodeRequest(req);

// Decode the BHTTP binary to a Request object
const decoder = new BHttpDecoder();
const decodedReq = decoder.decodeRequest(binReq);
```

### Encode/Decode Response

```ts
import { BHttpDecoder, BHttpEncoder } from "bhttp-ts";

const res = new Response("Hello World!", {
  status: 200,
  headers: { "Content-Type": "text/plain" },
});

// Encode a Response object to a BHTTP binary
const encoder = new BHttpEncoder();
const binRes = await encoder.encodeResponse(res);

// Decode the BHTTP binary to a Response object
const decoder = new BHttpDecoder();
const decodedRes = decoder.decodeResponse(binRes);
```

### Streaming API

For indeterminate-length messages, use the streaming encoders and decoder:

```ts
import {
  BHttpRequestStreamEncoder,
  BHttpResponseStreamEncoder,
  BHttpStreamDecoder,
} from "bhttp-ts";

// Streaming request encoding
const reqEncoder = new BHttpRequestStreamEncoder();
yield reqEncoder.encodePreamble("POST", "https", "example.com", "/api", headers);
yield reqEncoder.encodeContentChunk(chunk1);
yield reqEncoder.encodeContentChunk(chunk2);
yield reqEncoder.encodeEnd();

// Streaming response encoding
const resEncoder = new BHttpResponseStreamEncoder();
yield resEncoder.encodePreamble(200, headers);
yield resEncoder.encodeContentChunk(chunk1);
yield resEncoder.encodeEnd(trailers);

// Streaming decode
const decoder = new BHttpStreamDecoder();
for (const chunk of incomingData) {
  for (const event of decoder.push(chunk)) {
    switch (event.type) {
      case "request-preamble":
        // event.method, event.scheme, event.authority, event.path, event.headers
        break;
      case "response-preamble":
        // event.status, event.headers
        break;
      case "content":
        // event.data
        break;
      case "trailers":
        // event.headers
        break;
    }
  }
}
for (const event of decoder.end()) {
  // handle final events
}
```

## API

### BHttpEncoder

- `encodeRequest(request: Request): Promise<Uint8Array>` - Encode a Request to known-length BHTTP
- `encodeResponse(response: Response): Promise<Uint8Array>` - Encode a Response to known-length BHTTP

### BHttpDecoder

- `decodeRequest(data: ArrayBuffer | Uint8Array): Request` - Decode BHTTP to a Request
- `decodeResponse(data: ArrayBuffer | Uint8Array): Response` - Decode BHTTP to a Response

### BHttpRequestStreamEncoder / BHttpResponseStreamEncoder

For encoding indeterminate-length messages incrementally.

### BHttpStreamDecoder

For decoding BHTTP messages incrementally, emitting events as data arrives.

## References

- [RFC 9292: Binary Representation of HTTP Messages](https://datatracker.ietf.org/doc/html/rfc9292)
- [Fetch - Living Standard](https://fetch.spec.whatwg.org/)

## License

MIT - See [LICENSE](./LICENSE) for details.
