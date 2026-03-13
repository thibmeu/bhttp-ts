import { describe, expect, it } from "vitest";

import { BHttpDecoder } from "../src/decoder";
import { BHttpRequestStreamEncoder, BHttpResponseStreamEncoder } from "../src/stream-encoder";

describe("BHttpRequestStreamEncoder", () => {
	it("encodes empty body request", () => {
		const encoder = new BHttpRequestStreamEncoder();
		const headers = new Headers({ "content-type": "text/plain" });

		const preamble = encoder.encodePreamble("GET", "https", "example.com", "/path", headers);
		const end = encoder.encodeEnd();

		// Concatenate and decode
		const full = new Uint8Array(preamble.length + end.length);
		full.set(preamble);
		full.set(end, preamble.length);

		const decoder = new BHttpDecoder();
		const request = decoder.decodeRequest(full);

		expect(request.method).toBe("GET");
		expect(new URL(request.url).pathname).toBe("/path");
		expect(new URL(request.url).hostname).toBe("example.com");
	});

	it("encodes request with body chunks", async () => {
		const encoder = new BHttpRequestStreamEncoder();
		const headers = new Headers({ "content-type": "text/plain" });

		const preamble = encoder.encodePreamble("POST", "https", "example.com", "/api", headers);

		const chunk1 = new TextEncoder().encode("Hello, ");
		const chunk2 = new TextEncoder().encode("World!");

		const encChunk1 = encoder.encodeContentChunk(chunk1);
		const encChunk2 = encoder.encodeContentChunk(chunk2);
		const end = encoder.encodeEnd();

		// Concatenate
		const totalLen = preamble.length + encChunk1.length + encChunk2.length + end.length;
		const full = new Uint8Array(totalLen);
		let offset = 0;
		for (const part of [preamble, encChunk1, encChunk2, end]) {
			full.set(part, offset);
			offset += part.length;
		}

		const decoder = new BHttpDecoder();
		const request = decoder.decodeRequest(full);

		expect(request.method).toBe("POST");
		expect(await request.text()).toBe("Hello, World!");
	});

	it("encodes request with query parameters", () => {
		const encoder = new BHttpRequestStreamEncoder();
		const headers = new Headers();

		const preamble = encoder.encodePreamble(
			"GET",
			"https",
			"example.com",
			"/search?q=test&page=1",
			headers,
		);
		const end = encoder.encodeEnd();

		const full = new Uint8Array(preamble.length + end.length);
		full.set(preamble);
		full.set(end, preamble.length);

		const decoder = new BHttpDecoder();
		const request = decoder.decodeRequest(full);

		expect(new URL(request.url).search).toBe("?q=test&page=1");
	});

	it("throws if preamble encoded twice", () => {
		const encoder = new BHttpRequestStreamEncoder();
		encoder.encodePreamble("GET", "https", "example.com", "/", new Headers());

		expect(() =>
			encoder.encodePreamble("GET", "https", "example.com", "/", new Headers()),
		).toThrow("Preamble already encoded");
	});

	it("throws if chunk encoded before preamble", () => {
		const encoder = new BHttpRequestStreamEncoder();

		expect(() => encoder.encodeContentChunk(new Uint8Array([1, 2, 3]))).toThrow(
			"Preamble must be encoded first",
		);
	});

	it("throws if chunk encoded after end", () => {
		const encoder = new BHttpRequestStreamEncoder();
		encoder.encodePreamble("GET", "https", "example.com", "/", new Headers());
		encoder.encodeEnd();

		expect(() => encoder.encodeContentChunk(new Uint8Array([1, 2, 3]))).toThrow(
			"Encoding already ended",
		);
	});

	it("throws on empty chunk", () => {
		const encoder = new BHttpRequestStreamEncoder();
		encoder.encodePreamble("GET", "https", "example.com", "/", new Headers());

		expect(() => encoder.encodeContentChunk(new Uint8Array(0))).toThrow(
			"Content chunk cannot be empty",
		);
	});
});

describe("BHttpResponseStreamEncoder", () => {
	it("encodes empty body response", () => {
		const encoder = new BHttpResponseStreamEncoder();
		const headers = new Headers({ "content-type": "text/plain" });

		const preamble = encoder.encodePreamble(200, headers);
		const end = encoder.encodeEnd();

		const full = new Uint8Array(preamble.length + end.length);
		full.set(preamble);
		full.set(end, preamble.length);

		const decoder = new BHttpDecoder();
		const response = decoder.decodeResponse(full);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/plain");
	});

	it("encodes response with body chunks", async () => {
		const encoder = new BHttpResponseStreamEncoder();
		const headers = new Headers({ "content-type": "application/json" });

		const preamble = encoder.encodePreamble(200, headers);

		const chunk1 = new TextEncoder().encode('{"message":');
		const chunk2 = new TextEncoder().encode('"ok"}');

		const encChunk1 = encoder.encodeContentChunk(chunk1);
		const encChunk2 = encoder.encodeContentChunk(chunk2);
		const end = encoder.encodeEnd();

		const totalLen = preamble.length + encChunk1.length + encChunk2.length + end.length;
		const full = new Uint8Array(totalLen);
		let offset = 0;
		for (const part of [preamble, encChunk1, encChunk2, end]) {
			full.set(part, offset);
			offset += part.length;
		}

		const decoder = new BHttpDecoder();
		const response = decoder.decodeResponse(full);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ message: "ok" });
	});

	it("encodes response with trailers", async () => {
		const encoder = new BHttpResponseStreamEncoder();
		const headers = new Headers({ "content-type": "text/plain" });

		const preamble = encoder.encodePreamble(200, headers);
		const chunk = encoder.encodeContentChunk(new TextEncoder().encode("body"));
		const trailers = new Headers({ "x-checksum": "abc123" });
		const end = encoder.encodeEnd(trailers);

		const full = new Uint8Array(preamble.length + chunk.length + end.length);
		full.set(preamble);
		full.set(chunk, preamble.length);
		full.set(end, preamble.length + chunk.length);

		const decoder = new BHttpDecoder();
		const response = decoder.decodeResponse(full);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("body");
		// Note: trailers are parsed but Response API doesn't expose them easily
	});

	it("encodes response with informational responses", () => {
		const encoder = new BHttpResponseStreamEncoder();
		const headers = new Headers();

		const informational = [
			{ status: 100, headers: new Headers() },
			{ status: 103, headers: new Headers({ link: "</style.css>; rel=preload" }) },
		];

		const preamble = encoder.encodePreamble(200, headers, informational);
		const end = encoder.encodeEnd();

		const full = new Uint8Array(preamble.length + end.length);
		full.set(preamble);
		full.set(end, preamble.length);

		const decoder = new BHttpDecoder();
		const response = decoder.decodeResponse(full);

		expect(response.status).toBe(200);
	});

	it("throws on invalid final status", () => {
		const encoder = new BHttpResponseStreamEncoder();

		expect(() => encoder.encodePreamble(100, new Headers())).toThrow(
			"Final status must be 200-599",
		);
	});

	it("throws on invalid informational status", () => {
		const encoder = new BHttpResponseStreamEncoder();

		expect(() =>
			encoder.encodePreamble(200, new Headers(), [{ status: 200, headers: new Headers() }]),
		).toThrow("Informational status must be 100-199");
	});
});
