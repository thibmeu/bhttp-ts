/**
 * Performance benchmarks for the core (known-length) BHTTP encode/decode paths.
 *
 * Run with `npm run bench` (→ `vitest bench`).
 *
 * Pattern reused from quicvarint's test/index.bench.ts: a shared workload table
 * + `describe` suites that `forEach` over it, with all input generation hoisted
 * outside the `bench()` body.
 *
 * What this is meant to expose — the per-field / per-body buffer copies that
 * dominate a real round-trip, not the varint micro-layer:
 *   - decoder: ctx.buf.slice(...) per header field (src/decoder.ts:361) and for
 *     content (src/decoder.ts:290), plus a second body copy in
 *     createRequest/createResponse (src/decoder.ts:46, :70)
 *   - encoder: this._te.encode(v) allocates a throwaway array per field
 *     (src/encoder.ts:212)
 */

import { bench, describe } from "vitest";
import { BHttpDecoder, BHttpEncoder } from "../src";

interface Shape {
	name: string;
	method: string;
	status: number;
	headerCount: number;
	bodySize: number;
}

// Realistic spread of message shapes.
const shapes: Shape[] = [
	{ name: "small GET", method: "GET", status: 200, headerCount: 3, bodySize: 0 },
	{ name: "typical POST", method: "POST", status: 200, headerCount: 10, bodySize: 1024 },
	{ name: "header-heavy", method: "POST", status: 200, headerCount: 50, bodySize: 16 },
	{ name: "large body", method: "POST", status: 200, headerCount: 2, bodySize: 1024 * 1024 },
];

function makeHeaders(count: number): Headers {
	const h = new Headers();
	for (let i = 0; i < count; i++) {
		h.set(`x-header-${i}`, `value-${i}-${"v".repeat(8)}`);
	}
	return h;
}

function makeBody(size: number): Uint8Array {
	const b = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		b[i] = i & 0xff;
	}
	return b;
}

function buildRequest(shape: Shape): Request {
	const hasBody = shape.method !== "GET" && shape.method !== "HEAD" && shape.bodySize > 0;
	return new Request("https://example.com/api/resource?q=1", {
		method: shape.method,
		headers: makeHeaders(shape.headerCount),
		body: hasBody ? makeBody(shape.bodySize) : undefined,
	});
}

function buildResponse(shape: Shape): Response {
	const hasBody = shape.bodySize > 0;
	return new Response(hasBody ? makeBody(shape.bodySize) : null, {
		status: shape.status,
		headers: makeHeaders(shape.headerCount),
	});
}

const encoder = new BHttpEncoder();
const decoder = new BHttpDecoder();

// Encode: a fresh Request/Response is built each iteration because the Fetch
// body is single-use (arrayBuffer() consumes it). Construction cost is included
// and matches the realistic "given app data, produce BHTTP bytes" path.
describe("encode request", () => {
	for (const shape of shapes) {
		bench(shape.name, async () => {
			await encoder.encodeRequest(buildRequest(shape));
		});
	}
});

describe("encode response", () => {
	for (const shape of shapes) {
		bench(shape.name, async () => {
			await encoder.encodeResponse(buildResponse(shape));
		});
	}
});

// Decode: pre-encode bytes once (top-level await, hoisted like quicvarint's
// input generation) and reuse them every iteration — pure decoder cost, the
// cleanest signal for the slice() copies.
const requestBytes = await Promise.all(
	shapes.map(async (shape) => ({ shape, bytes: await encoder.encodeRequest(buildRequest(shape)) })),
);
const responseBytes = await Promise.all(
	shapes.map(async (shape) => ({
		shape,
		bytes: await encoder.encodeResponse(buildResponse(shape)),
	})),
);

describe("decode request", () => {
	for (const { shape, bytes } of requestBytes) {
		bench(shape.name, () => {
			decoder.decodeRequest(bytes);
		});
	}
});

describe("decode response", () => {
	for (const { shape, bytes } of responseBytes) {
		bench(shape.name, () => {
			decoder.decodeResponse(bytes);
		});
	}
});
