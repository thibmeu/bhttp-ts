import { describe, expect, it } from "vitest";

import { BHttpEncoder } from "../src/encoder";
import {
	type BHttpContentEvent,
	type BHttpEvent,
	type BHttpRequestPreambleEvent,
	type BHttpResponsePreambleEvent,
	BHttpStreamDecoder,
} from "../src/stream-decoder";
import { BHttpRequestStreamEncoder, BHttpResponseStreamEncoder } from "../src/stream-encoder";

describe("BHttpStreamDecoder", () => {
	describe("indeterminate-length request", () => {
		it("decodes empty body request in one push", () => {
			const encoder = new BHttpRequestStreamEncoder();
			const headers = new Headers({ "content-type": "text/plain" });

			const preamble = encoder.encodePreamble("GET", "https", "example.com", "/path", headers);
			const end = encoder.encodeEnd();

			const full = new Uint8Array(preamble.length + end.length);
			full.set(preamble);
			full.set(end, preamble.length);

			const decoder = new BHttpStreamDecoder();
			const events = decoder.push(full);
			const endEvents = decoder.end();

			expect(events.length).toBe(1);
			expect(events[0]?.type).toBe("request-preamble");
			const preambleEvent = events[0] as BHttpRequestPreambleEvent;
			expect(preambleEvent.method).toBe("GET");
			expect(preambleEvent.scheme).toBe("https");
			expect(preambleEvent.authority).toBe("example.com");
			expect(preambleEvent.path).toBe("/path");

			expect(endEvents.length).toBe(1);
			expect(endEvents[0]?.type).toBe("end");
		});

		it("decodes request with body chunks", () => {
			const encoder = new BHttpRequestStreamEncoder();
			const headers = new Headers();

			const preamble = encoder.encodePreamble("POST", "https", "example.com", "/api", headers);
			const chunk1 = encoder.encodeContentChunk(new TextEncoder().encode("Hello"));
			const chunk2 = encoder.encodeContentChunk(new TextEncoder().encode("World"));
			const end = encoder.encodeEnd();

			const full = new Uint8Array(preamble.length + chunk1.length + chunk2.length + end.length);
			let offset = 0;
			for (const part of [preamble, chunk1, chunk2, end]) {
				full.set(part, offset);
				offset += part.length;
			}

			const decoder = new BHttpStreamDecoder();
			const events = decoder.push(full);
			decoder.end();

			expect(events.length).toBe(3);
			expect(events[0]?.type).toBe("request-preamble");
			expect(events[1]?.type).toBe("content");
			expect(events[2]?.type).toBe("content");

			const content1 = events[1] as BHttpContentEvent;
			const content2 = events[2] as BHttpContentEvent;
			expect(new TextDecoder().decode(content1.data)).toBe("Hello");
			expect(new TextDecoder().decode(content2.data)).toBe("World");
		});

		it("decodes incrementally byte-by-byte", () => {
			const encoder = new BHttpRequestStreamEncoder();
			const headers = new Headers({ "x-test": "value" });

			const preamble = encoder.encodePreamble("GET", "https", "example.com", "/", headers);
			const end = encoder.encodeEnd();

			const full = new Uint8Array(preamble.length + end.length);
			full.set(preamble);
			full.set(end, preamble.length);

			const decoder = new BHttpStreamDecoder();
			const allEvents: BHttpEvent[] = [];

			// Feed byte by byte
			for (let i = 0; i < full.length; i++) {
				const events = decoder.push(full.subarray(i, i + 1));
				allEvents.push(...events);
			}
			allEvents.push(...decoder.end());

			// Should still get same events
			expect(allEvents.filter((e) => e.type === "request-preamble").length).toBe(1);
			expect(allEvents.filter((e) => e.type === "end").length).toBe(1);
		});
	});

	describe("indeterminate-length response", () => {
		it("decodes empty body response", () => {
			const encoder = new BHttpResponseStreamEncoder();
			const headers = new Headers({ "content-type": "application/json" });

			const preamble = encoder.encodePreamble(200, headers);
			const end = encoder.encodeEnd();

			const full = new Uint8Array(preamble.length + end.length);
			full.set(preamble);
			full.set(end, preamble.length);

			const decoder = new BHttpStreamDecoder();
			const events = decoder.push(full);
			decoder.end();

			expect(events.length).toBe(1);
			expect(events[0]?.type).toBe("response-preamble");
			const preambleEvent = events[0] as BHttpResponsePreambleEvent;
			expect(preambleEvent.status).toBe(200);
			expect(preambleEvent.headers.get("content-type")).toBe("application/json");
		});

		it("decodes response with informational responses", () => {
			const encoder = new BHttpResponseStreamEncoder();
			const headers = new Headers();

			const informational = [
				{ status: 100, headers: new Headers() },
				{ status: 103, headers: new Headers({ link: "</style.css>" }) },
			];

			const preamble = encoder.encodePreamble(200, headers, informational);
			const end = encoder.encodeEnd();

			const full = new Uint8Array(preamble.length + end.length);
			full.set(preamble);
			full.set(end, preamble.length);

			const decoder = new BHttpStreamDecoder();
			const events = decoder.push(full);
			decoder.end();

			// Should have 2 informational + 1 response preamble
			const infos = events.filter((e) => e.type === "informational");
			const preambles = events.filter((e) => e.type === "response-preamble");

			expect(infos.length).toBe(2);
			expect(preambles.length).toBe(1);
		});

		it("decodes response with body and trailers", () => {
			const encoder = new BHttpResponseStreamEncoder();
			const headers = new Headers();

			const preamble = encoder.encodePreamble(200, headers);
			const chunk = encoder.encodeContentChunk(new TextEncoder().encode("body"));
			const trailers = new Headers({ "x-checksum": "abc" });
			const end = encoder.encodeEnd(trailers);

			const full = new Uint8Array(preamble.length + chunk.length + end.length);
			full.set(preamble);
			full.set(chunk, preamble.length);
			full.set(end, preamble.length + chunk.length);

			const decoder = new BHttpStreamDecoder();
			const events = decoder.push(full);
			decoder.end();

			const trailerEvents = events.filter((e) => e.type === "trailers");
			expect(trailerEvents.length).toBe(1);
		});
	});

	describe("known-length messages", () => {
		it("decodes known-length request from BHttpEncoder", async () => {
			const request = new Request("https://example.com/api?q=test", {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: "Hello",
			});

			const encoder = new BHttpEncoder();
			const encoded = await encoder.encodeRequest(request);

			const decoder = new BHttpStreamDecoder();
			const events = decoder.push(encoded);
			decoder.end();

			expect(events.length).toBe(2); // preamble + content
			expect(events[0]?.type).toBe("request-preamble");
			expect(events[1]?.type).toBe("content");

			const preambleEvent = events[0] as BHttpRequestPreambleEvent;
			expect(preambleEvent.method).toBe("POST");
			expect(preambleEvent.path).toBe("/api?q=test");
		});

		it("decodes known-length response from BHttpEncoder", async () => {
			const response = new Response("Response body", {
				status: 201,
				headers: { "x-custom": "value" },
			});

			const encoder = new BHttpEncoder();
			const encoded = await encoder.encodeResponse(response);

			const decoder = new BHttpStreamDecoder();
			const events = decoder.push(encoded);
			decoder.end();

			expect(events.length).toBe(2); // preamble + content
			expect(events[0]?.type).toBe("response-preamble");

			const preambleEvent = events[0] as BHttpResponsePreambleEvent;
			expect(preambleEvent.status).toBe(201);
			expect(preambleEvent.headers.get("x-custom")).toBe("value");
		});

		// RFC 9292 Section 3.8: a missing trailer section is read as empty, so end()
		// still completes.
		it("decodes a known-length response whose empty trailer section is omitted", async () => {
			const encoder = new BHttpEncoder();
			const full = await encoder.encodeResponse(new Response("Response body", { status: 201 }));
			// The final byte is the trailer length VLI (0); drop it to simulate truncation.
			const truncated = full.subarray(0, full.length - 1);

			const decoder = new BHttpStreamDecoder();
			const events = decoder.push(truncated);
			const endEvents = decoder.end();

			expect(events[0]?.type).toBe("response-preamble");
			expect([...events, ...endEvents].some((e) => e.type === "end")).toBe(true);
		});
	});

	describe("error handling", () => {
		it("throws on invalid framing indicator", () => {
			const decoder = new BHttpStreamDecoder();

			// Framing indicator 4 is invalid
			expect(() => decoder.push(new Uint8Array([4]))).toThrow("Invalid framing indicator");
		});

		it("throws on incomplete message at end()", () => {
			const encoder = new BHttpRequestStreamEncoder();
			const preamble = encoder.encodePreamble("GET", "https", "example.com", "/", new Headers());
			// Cut the message off mid control data. Only the trailing content and
			// trailer sections may be dropped (RFC 9292 Section 3.8); a message cut
			// off anywhere else is invalid.
			const partial = preamble.subarray(0, 3);

			const decoder = new BHttpStreamDecoder();
			decoder.push(partial);

			expect(() => decoder.end()).toThrow("Incomplete message");
		});

		// RFC 9292 Section 3.8: a message can omit empty content when the trailers
		// are empty too, so a preamble with no content or trailer section is a valid
		// truncated message, not an incomplete one.
		it("completes when content and trailers are omitted", () => {
			const encoder = new BHttpRequestStreamEncoder();
			const preamble = encoder.encodePreamble("GET", "https", "example.com", "/", new Headers());

			const decoder = new BHttpStreamDecoder();
			const events = decoder.push(preamble);
			const endEvents = decoder.end();

			expect([...events, ...endEvents].some((e) => e.type === "end")).toBe(true);
		});

		it("throws if push called after end", () => {
			const encoder = new BHttpRequestStreamEncoder();
			const preamble = encoder.encodePreamble("GET", "https", "example.com", "/", new Headers());
			const end = encoder.encodeEnd();

			const full = new Uint8Array(preamble.length + end.length);
			full.set(preamble);
			full.set(end, preamble.length);

			const decoder = new BHttpStreamDecoder();
			decoder.push(full);
			decoder.end();

			expect(() => decoder.push(new Uint8Array([1, 2, 3]))).toThrow("Decoder already finished");
		});
	});

	describe("chunked input simulation", () => {
		it("handles input split at arbitrary boundaries", () => {
			const encoder = new BHttpResponseStreamEncoder();
			const headers = new Headers({ "content-type": "text/plain" });

			const preamble = encoder.encodePreamble(200, headers);
			const chunk = encoder.encodeContentChunk(new TextEncoder().encode("Test content"));
			const end = encoder.encodeEnd();

			const full = new Uint8Array(preamble.length + chunk.length + end.length);
			full.set(preamble);
			full.set(chunk, preamble.length);
			full.set(end, preamble.length + chunk.length);

			// Split at various points
			const splitPoints = [1, 3, 7, 15, 20];
			const decoder = new BHttpStreamDecoder();
			const allEvents: BHttpEvent[] = [];

			let start = 0;
			for (const point of splitPoints) {
				if (point <= full.length) {
					const events = decoder.push(full.subarray(start, point));
					allEvents.push(...events);
					start = point;
				}
			}
			// Push remainder
			allEvents.push(...decoder.push(full.subarray(start)));
			allEvents.push(...decoder.end());

			// Verify we got all expected events. Content may arrive as several
			// events (bytes are emitted as they arrive, not buffered per chunk);
			// what matters is the concatenated byte stream.
			expect(allEvents.filter((e) => e.type === "response-preamble").length).toBe(1);
			const content = allEvents.filter((e): e is BHttpContentEvent => e.type === "content");
			expect(content.length).toBeGreaterThanOrEqual(1);
			const joined = new Uint8Array(content.reduce((sum, e) => sum + e.data.length, 0));
			let offset = 0;
			for (const e of content) {
				joined.set(e.data, offset);
				offset += e.data.length;
			}
			expect(new TextDecoder().decode(joined)).toBe("Test content");
			expect(allEvents.filter((e) => e.type === "end").length).toBe(1);
		});
	});
});
