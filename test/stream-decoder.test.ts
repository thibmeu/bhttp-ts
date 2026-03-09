import { assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import { BHttpEncoder } from "../src/encoder.ts";
import {
	type BHttpContentEvent,
	type BHttpEvent,
	type BHttpRequestPreambleEvent,
	type BHttpResponsePreambleEvent,
	BHttpStreamDecoder,
} from "../src/stream-decoder.ts";
import { BHttpRequestStreamEncoder, BHttpResponseStreamEncoder } from "../src/stream-encoder.ts";

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

			assertEquals(events.length, 1);
			assertEquals(events[0].type, "request-preamble");
			const preambleEvent = events[0] as BHttpRequestPreambleEvent;
			assertEquals(preambleEvent.method, "GET");
			assertEquals(preambleEvent.scheme, "https");
			assertEquals(preambleEvent.authority, "example.com");
			assertEquals(preambleEvent.path, "/path");

			assertEquals(endEvents.length, 1);
			assertEquals(endEvents[0].type, "end");
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

			assertEquals(events.length, 3);
			assertEquals(events[0].type, "request-preamble");
			assertEquals(events[1].type, "content");
			assertEquals(events[2].type, "content");

			const content1 = events[1] as BHttpContentEvent;
			const content2 = events[2] as BHttpContentEvent;
			assertEquals(new TextDecoder().decode(content1.data), "Hello");
			assertEquals(new TextDecoder().decode(content2.data), "World");
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
			assertEquals(allEvents.filter((e) => e.type === "request-preamble").length, 1);
			assertEquals(allEvents.filter((e) => e.type === "end").length, 1);
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

			assertEquals(events.length, 1);
			assertEquals(events[0].type, "response-preamble");
			const preambleEvent = events[0] as BHttpResponsePreambleEvent;
			assertEquals(preambleEvent.status, 200);
			assertEquals(preambleEvent.headers.get("content-type"), "application/json");
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

			assertEquals(infos.length, 2);
			assertEquals(preambles.length, 1);
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
			assertEquals(trailerEvents.length, 1);
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

			assertEquals(events.length, 2); // preamble + content
			assertEquals(events[0].type, "request-preamble");
			assertEquals(events[1].type, "content");

			const preambleEvent = events[0] as BHttpRequestPreambleEvent;
			assertEquals(preambleEvent.method, "POST");
			assertEquals(preambleEvent.path, "/api?q=test");
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

			assertEquals(events.length, 2); // preamble + content
			assertEquals(events[0].type, "response-preamble");

			const preambleEvent = events[0] as BHttpResponsePreambleEvent;
			assertEquals(preambleEvent.status, 201);
			assertEquals(preambleEvent.headers.get("x-custom"), "value");
		});
	});

	describe("error handling", () => {
		it("throws on invalid framing indicator", () => {
			const decoder = new BHttpStreamDecoder();

			// Framing indicator 4 is invalid
			assertThrows(() => decoder.push(new Uint8Array([4])), Error, "Invalid framing indicator");
		});

		it("throws on incomplete message at end()", () => {
			const encoder = new BHttpRequestStreamEncoder();
			const preamble = encoder.encodePreamble("GET", "https", "example.com", "/", new Headers());
			// Don't include end

			const decoder = new BHttpStreamDecoder();
			decoder.push(preamble);

			assertThrows(() => decoder.end(), Error, "Incomplete message");
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

			assertThrows(
				() => decoder.push(new Uint8Array([1, 2, 3])),
				Error,
				"Decoder already finished",
			);
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

			// Verify we got all expected events
			assertEquals(allEvents.filter((e) => e.type === "response-preamble").length, 1);
			assertEquals(allEvents.filter((e) => e.type === "content").length, 1);
			assertEquals(allEvents.filter((e) => e.type === "end").length, 1);
		});
	});
});
