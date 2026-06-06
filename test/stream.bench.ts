/**
 * Performance benchmarks for the streaming (indeterminate-length) BHTTP path.
 *
 * Run with `npm run bench` (→ `vitest bench`).
 *
 * The streaming path is the one that exercises quicvarint via src/vli.ts, plus
 * the many small Uint8Array allocations + concatenations in src/stream-encoder.ts
 * and the incremental buffering in src/stream-decoder.ts.
 */

import { bench, describe } from "vitest";
import { BHttpRequestStreamEncoder, BHttpStreamDecoder } from "../src";

interface Shape {
	name: string;
	headerCount: number;
	chunkCount: number;
	chunkSize: number;
}

const shapes: Shape[] = [
	{ name: "small (no body)", headerCount: 3, chunkCount: 0, chunkSize: 0 },
	{ name: "typical (8 x 1KB)", headerCount: 10, chunkCount: 8, chunkSize: 1024 },
	{ name: "header-heavy", headerCount: 50, chunkCount: 1, chunkSize: 16 },
	{ name: "large (64 x 16KB)", headerCount: 2, chunkCount: 64, chunkSize: 16 * 1024 },
];

function makeHeaders(count: number): Headers {
	const h = new Headers();
	for (let i = 0; i < count; i++) {
		h.set(`x-header-${i}`, `value-${i}-${"v".repeat(8)}`);
	}
	return h;
}

function makeChunk(size: number): Uint8Array {
	const b = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		b[i] = i & 0xff;
	}
	return b;
}

// Pre-build a full streamed byte array for a shape (used to seed decode benches).
function streamEncode(shape: Shape): Uint8Array {
	const enc = new BHttpRequestStreamEncoder();
	const parts: Uint8Array[] = [];
	parts.push(
		enc.encodePreamble("POST", "https", "example.com", "/api", makeHeaders(shape.headerCount)),
	);
	const chunk = makeChunk(shape.chunkSize);
	for (let i = 0; i < shape.chunkCount; i++) {
		parts.push(enc.encodeContentChunk(chunk));
	}
	parts.push(enc.encodeEnd());

	const total = parts.reduce((sum, p) => sum + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

// Stream encode: a fresh encoder each iteration (single-use state machine).
describe("stream encode request", () => {
	for (const shape of shapes) {
		const headers = makeHeaders(shape.headerCount);
		const chunk = makeChunk(shape.chunkSize);
		bench(shape.name, () => {
			const enc = new BHttpRequestStreamEncoder();
			enc.encodePreamble("POST", "https", "example.com", "/api", headers);
			for (let i = 0; i < shape.chunkCount; i++) {
				enc.encodeContentChunk(chunk);
			}
			enc.encodeEnd();
		});
	}
});

// Stream decode (one push): whole message fed at once, fresh decoder per iter.
describe("stream decode (single push)", () => {
	for (const shape of shapes) {
		const bytes = streamEncode(shape);
		bench(shape.name, () => {
			const dec = new BHttpStreamDecoder();
			dec.push(bytes);
			dec.end();
		});
	}
});

// Stream decode (small slices): exercises the incremental buffering path by
// feeding the message in 256-byte pieces.
describe("stream decode (256B slices)", () => {
	for (const shape of shapes) {
		const bytes = streamEncode(shape);
		const step = 256;
		bench(shape.name, () => {
			const dec = new BHttpStreamDecoder();
			for (let off = 0; off < bytes.length; off += step) {
				dec.push(bytes.subarray(off, Math.min(off + step, bytes.length)));
			}
			dec.end();
		});
	}
});
