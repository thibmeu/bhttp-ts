import { describe, expect, it } from "vitest";

import { BHttpDecoder } from "../src/decoder";
import { BHttpEncoder } from "../src/encoder";
import { InvalidMessageError } from "../src/errors";
import {
	type BHttpContentEvent,
	type BHttpEvent,
	type BHttpRequestPreambleEvent,
	type BHttpResponsePreambleEvent,
	BHttpStreamDecoder,
} from "../src/stream-decoder";
import { BHttpRequestStreamEncoder, BHttpResponseStreamEncoder } from "../src/stream-encoder";
import { encodeVli } from "../src/vli";

describe("BHttpStreamDecoder", () => {
	it.each([8191, 8192, 8193, 131073])("preserves a %i-byte header value", async (length) => {
		const value = "a\u0080\u00ff".repeat(Math.ceil(length / 3)).slice(0, length);
		const bytes = await new BHttpEncoder().encodeResponse(
			new Response(null, {
				headers: { "x-long": value },
			}),
		);
		expect(new BHttpDecoder().decodeResponse(bytes).headers.get("x-long")).toBe(value);
		const decoder = new BHttpStreamDecoder({ maxMetadataSize: bytes.length });
		const event = decoder.push(bytes).find((event) => event.type === "response-preamble");
		expect(event?.headers.get("x-long")).toBe(value);
		decoder.end();
	});

	describe("maxMetadataSize", () => {
		it("rejects an oversized request control string from its length prefix", () => {
			const decoder = new BHttpStreamDecoder({ maxMetadataSize: 16 });
			const prefix = new Uint8Array([2, ...encodeVli(1024)]);

			expect(() => decoder.push(prefix)).toThrow("metadata exceeds the configured limit");
		});

		it("rejects an oversized indeterminate header from its length prefix", () => {
			const decoder = new BHttpStreamDecoder({ maxMetadataSize: 16 });
			// Indeterminate request framing, four empty control strings, then a
			// declared header name without its payload.
			const prefix = new Uint8Array([2, 0, 0, 0, 0, ...encodeVli(1024)]);

			expect(() => decoder.push(prefix)).toThrow("metadata exceeds the configured limit");
		});

		it("accepts metadata exactly at the configured limit", () => {
			const preamble = new BHttpRequestStreamEncoder().encodePreamble(
				"GET",
				"https",
				"example.com",
				"/",
				new Headers({ "x-test": "value" }),
			);
			const decoder = new BHttpStreamDecoder({ maxMetadataSize: preamble.length });

			const events = decoder.push(preamble);
			const end = decoder.end();

			expect(events.some((event) => event.type === "request-preamble")).toBe(true);
			expect(end.some((event) => event.type === "end")).toBe(true);
		});

		it("rejects a known-length field section before receiving its bytes", async () => {
			const encoded = new Uint8Array(
				await new BHttpEncoder().encodeResponse(
					new Response(null, { headers: { "x-large": "v".repeat(1024) } }),
				),
			);
			const decoder = new BHttpStreamDecoder({ maxMetadataSize: 32 });

			let rejectedAt = encoded.length;
			const decodeDeclaredLength = () => {
				for (let i = 0; i < encoded.length; i++) {
					try {
						decoder.push(encoded.subarray(i, i + 1));
					} catch (error) {
						rejectedAt = i + 1;
						throw error;
					}
				}
			};

			expect(decodeDeclaredLength).toThrow("metadata exceeds the configured limit");
			expect(rejectedAt).toBeLessThan(encoded.length);
		});

		it("rejects indeterminate metadata accumulated across pushes", () => {
			const preamble = new BHttpRequestStreamEncoder().encodePreamble(
				"GET",
				"https",
				"example.com",
				"/resource",
				new Headers({ "x-test": "value" }),
			);
			const decoder = new BHttpStreamDecoder({ maxMetadataSize: preamble.length - 1 });

			const pushByteByByte = () => {
				for (const byte of preamble) decoder.push(new Uint8Array([byte]));
			};

			expect(pushByteByByte).toThrow("metadata exceeds the configured limit");
		});

		it("does not charge body content to the metadata limit", () => {
			const encoder = new BHttpRequestStreamEncoder();
			const preamble = encoder.encodePreamble("POST", "https", "example.com", "/", new Headers());
			const content = encoder.encodeContentChunk(new Uint8Array(1024 * 1024));
			const end = encoder.encodeEnd();
			const decoder = new BHttpStreamDecoder({
				maxMetadataSize: preamble.length + 1, // trailer terminator
			});

			decoder.push(preamble);
			decoder.push(content);
			const events = [...decoder.push(end), ...decoder.end()];

			expect(events.some((event) => event.type === "end")).toBe(true);
		});

		it("counts fragmented informational, final, and trailer fields once", () => {
			const encoder = new BHttpResponseStreamEncoder();
			const preamble = encoder.encodePreamble(200, new Headers({ final: "b" }), [
				{ status: 103, headers: new Headers({ info: "a" }) },
			]);
			const bytes = new Uint8Array([
				...preamble,
				...encoder.encodeEnd(new Headers({ trailer: "c" })),
			]);
			const metadataSize = bytes.length - 1; // content terminator
			const decoder = new BHttpStreamDecoder({ maxMetadataSize: metadataSize });
			const events = [...bytes].flatMap((byte) => decoder.push(new Uint8Array([byte])));
			expect([...events, ...decoder.end()].map((event) => event.type)).toEqual([
				"informational",
				"response-preamble",
				"trailers",
				"end",
			]);

			const limited = new BHttpStreamDecoder({ maxMetadataSize: metadataSize - 1 });
			expect(() => {
				for (const byte of bytes) limited.push(new Uint8Array([byte]));
			}).toThrow("metadata exceeds the configured limit");
		});
	});

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
		it("does not append completed fields again as the section grows", () => {
			const headers = new Headers(
				Array.from({ length: 16 }, (_, index) => [`x-${index}`, `${index}`]),
			);
			const encoder = new BHttpResponseStreamEncoder();
			const bytes = new Uint8Array([
				...encoder.encodePreamble(200, headers, [{ status: 103, headers }]),
				...encoder.encodeEnd(headers),
			]);
			const append = Headers.prototype.append;
			let calls = 0;
			Headers.prototype.append = function (name, value) {
				calls++;
				return append.call(this, name, value);
			};
			try {
				const decoder = new BHttpStreamDecoder();
				const events = [...bytes].flatMap((byte) => decoder.push(new Uint8Array([byte])));
				expect(events.filter((event) => "headers" in event)).toHaveLength(3);
				decoder.end();
				expect(calls).toBe(48);
			} finally {
				Headers.prototype.append = append;
			}
		});

		it("preserves high octets in informational, final, and trailer fields", () => {
			const high = Array.from({ length: 128 }, (_, index) =>
				String.fromCharCode(index + 0x80),
			).join("");
			const encoder = new BHttpResponseStreamEncoder();
			const preamble = encoder.encodePreamble(200, new Headers({ final: high }), [
				{ status: 103, headers: new Headers({ info: high }) },
			]);
			const bytes = new Uint8Array([
				...preamble,
				...encoder.encodeEnd(new Headers({ trailer: high })),
			]);
			const decoder = new BHttpStreamDecoder();
			const events = [...bytes].flatMap((byte) => decoder.push(new Uint8Array([byte])));
			decoder.end();
			expect(
				events
					.filter((event) => "headers" in event)
					.map((event) => event.headers.values().next().value),
			).toEqual([high, high, high]);
		});

		it.each([1, 3])("decodes raw high octets in every field section with framing %i", (framing) => {
			const valueBytes = Array.from({ length: 128 }, (_, index) => index + 0x80);
			const value = valueBytes.map((byte) => String.fromCharCode(byte)).join("");
			const field = [1, 120, ...encodeVli(valueBytes.length), ...valueBytes];
			const section = framing === 1 ? [...encodeVli(field.length), ...field] : [...field, 0];
			const bytes = new Uint8Array([
				framing,
				...encodeVli(103),
				...section,
				...encodeVli(200),
				...section,
				0,
				...section,
			]);
			const decoder = new BHttpStreamDecoder();
			const events = [...bytes].flatMap((byte) => decoder.push(new Uint8Array([byte])));
			decoder.end();
			expect(
				events.filter((event) => "headers" in event).map((event) => event.headers.get("x")),
			).toEqual([value, value, value]);
		});
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

describe("known-length messages split mid-headers", () => {
	const collect = (decoder: BHttpStreamDecoder, chunks: Uint8Array[]): BHttpEvent[] => {
		const events: BHttpEvent[] = [];
		for (const c of chunks) events.push(...decoder.push(c));
		events.push(...decoder.end());
		return events;
	};

	// Content arrives as a byte stream, so event counts vary with the split;
	// compare the reassembled message instead.
	const summarise = (events: BHttpEvent[]) => {
		const preamble = events.find(
			(e) => e.type === "request-preamble" || e.type === "response-preamble",
		) as BHttpRequestPreambleEvent | BHttpResponsePreambleEvent | undefined;
		const body = events
			.filter((e): e is BHttpContentEvent => e.type === "content")
			.map((e) => new TextDecoder().decode(e.data))
			.join("");
		return JSON.stringify({
			preamble: preamble && { ...preamble, headers: [...preamble.headers].sort() },
			body,
			ended: events.some((e) => e.type === "end"),
		});
	};

	it("decodes identically at every split point", async () => {
		const bytes = new Uint8Array(
			await new BHttpEncoder().encodeRequest(
				new Request("https://example.com/x", {
					method: "POST",
					body: "hello",
					headers: { "x-k": "v" },
				}),
			),
		);

		const reference = summarise(collect(new BHttpStreamDecoder(), [bytes]));
		expect(reference).toContain('"body":"hello"');
		expect(reference).toContain("x-k");

		for (let split = 1; split < bytes.length; split++) {
			const events = collect(new BHttpStreamDecoder(), [
				bytes.subarray(0, split),
				bytes.subarray(split),
			]);
			expect(summarise(events), `split at ${split}`).toBe(reference);
		}
	});

	it("decodes a known-length message fed one byte at a time", async () => {
		const bytes = new Uint8Array(
			await new BHttpEncoder().encodeResponse(
				new Response("hello", { status: 404, headers: { "x-k": "v" } }),
			),
		);

		const events = collect(
			new BHttpStreamDecoder(),
			Array.from(bytes, (b) => new Uint8Array([b])),
		);
		expect(summarise(events)).toBe(summarise(collect(new BHttpStreamDecoder(), [bytes])));

		const preamble = events.find((e) => e.type === "response-preamble");
		expect(preamble).toMatchObject({ status: 404 });
		expect((preamble as BHttpResponsePreambleEvent).headers.get("x-k")).toBe("v");
	});
});

describe("decoder length validation", () => {
	const response = [1, 0x40, 200, 0];
	const malformed = [
		[...response, 5, 104, 105],
		[...response, 0x40],
		[...response, 0, 0x40],
		[1, 0x40, 200, 3, 1, 120, 2, 97, 98],
		[1, 0x40, 200, 1, 0x40, 1, 120, 0],
		[1, 0x40, 200, 2, 1, 120],
		[1, 0x40, 103, 3, 1, 120, 2, 97, 98, ...response.slice(1)],
		[...response, 0, 3, 1, 120, 2, 97, 98],
		[3, 0x40, 200, 0, 2, 104],
		[3, 0x40, 200, 0, 2, 104, 105],
		[3, 0x40, 200, 0, 0, 1, 120],
		[3, 0x40, 200, 0, 0, 1, 120, 1, 97],
		[3, 0x40, 200, 0, 0, 0x40],
	];
	it.each(malformed.map((bytes, i) => [i, new Uint8Array(bytes)] as const))(
		"rejects malformed response %i at every split",
		(_, bytes) => {
			expect(() => new BHttpDecoder().decodeResponse(bytes)).toThrow(InvalidMessageError);
			for (let split = 0; split <= bytes.length; split++) {
				expect(() => {
					const decoder = new BHttpStreamDecoder();
					decoder.push(bytes.subarray(0, split));
					decoder.push(bytes.subarray(split));
					decoder.end();
				}).toThrow(InvalidMessageError);
			}
		},
	);

	it.each([1, 3])("preserves valid trailing omissions for framing %i", (framing) => {
		for (const tail of [[], [0], [0, 0]]) {
			const bytes = new Uint8Array([framing, 0x40, 200, 0, ...tail]);
			expect(new BHttpDecoder().decodeResponse(bytes).status).toBe(200);
			const decoder = new BHttpStreamDecoder();
			for (const byte of bytes) decoder.push(new Uint8Array([byte]));
			expect(decoder.end()).toEqual([{ type: "end" }]);
		}
	});

	it("decodes a field section with a two-byte length", async () => {
		const bytes = await new BHttpEncoder().encodeResponse(
			new Response("hi", { headers: { x: "a".repeat(70) } }),
		);
		for (let split = 0; split <= bytes.length; split++) {
			const decoder = new BHttpStreamDecoder();
			const events = [
				...decoder.push(bytes.subarray(0, split)),
				...decoder.push(bytes.subarray(split)),
				...decoder.end(),
			];
			expect((events[0] as BHttpResponsePreambleEvent).headers.get("x")).toBe("a".repeat(70));
			const body = events
				.filter((e): e is BHttpContentEvent => e.type === "content")
				.flatMap((e) => [...e.data]);
			expect(new TextDecoder().decode(new Uint8Array(body))).toBe("hi");
		}
		const decoded = new BHttpDecoder().decodeResponse(bytes);
		expect(decoded.headers.get("x")).toBe("a".repeat(70));
		expect(await decoded.text()).toBe("hi");
	});

	it("accepts multi-byte name lengths in indeterminate fields", () => {
		const bytes = new Uint8Array([3, 0x40, 200, 0x40, 1, 120, 1, 97, 0]);
		expect(new BHttpDecoder().decodeResponse(bytes).headers.get("x")).toBe("a");
		const decoder = new BHttpStreamDecoder();
		const events = [...bytes].flatMap((byte) => decoder.push(new Uint8Array([byte])));
		decoder.end();
		expect((events[0] as BHttpResponsePreambleEvent).headers.get("x")).toBe("a");
	});
});

describe("repeated fields and bodyless responses", () => {
	const field = (name: string, value: string) => {
		const n = new TextEncoder().encode(name);
		const v = new TextEncoder().encode(value);
		return [...encodeVli(n.length), ...n, ...encodeVli(v.length), ...v];
	};
	it.each([1, 3])("preserves repeated fields with framing %i at every split", async (framing) => {
		const fields = [
			...field("set-cookie", "a=1"),
			...field("set-cookie", "b=2"),
			...field("x", "a"),
			...field("x", "b"),
			...field("cookie", " a=1 "),
			...field("cookie", "\tb=2\t"),
		];
		const section = framing === 1 ? [...encodeVli(fields.length), ...fields] : [...fields, 0];
		const bytes = new Uint8Array([
			framing,
			...encodeVli(103),
			...section,
			...encodeVli(200),
			...section,
			0,
			...section,
		]);
		const check = (headers: Headers, cookies = ["a=1", "b=2"]) => {
			expect(headers.getSetCookie()).toEqual(cookies);
			expect(headers.get("x")).toBe("a, b");
			expect(headers.get("cookie")).toBe("a=1; b=2");
		};
		const buffered = new BHttpDecoder().decodeResponse(bytes);
		// Browser Response headers filter Set-Cookie; raw decoder events retain it.
		const cookies = new Response(null, {
			headers: [
				["set-cookie", "a=1"],
				["set-cookie", "b=2"],
			],
		}).headers.getSetCookie();
		check(buffered.headers, cookies);
		const roundTrip = await new BHttpEncoder().encodeResponse(buffered);
		check(new BHttpDecoder().decodeResponse(roundTrip).headers, cookies);
		for (let split = 0; split <= bytes.length; split++) {
			const decoder = new BHttpStreamDecoder();
			const events = [
				...decoder.push(bytes.subarray(0, split)),
				...decoder.push(bytes.subarray(split)),
				...decoder.end(),
			];
			const metadata = events.filter((e) => "headers" in e);
			expect(metadata).toHaveLength(3);
			for (const event of metadata) if ("headers" in event) check(event.headers);
		}
	});

	it.each([204, 205, 304])("round trips status %i with no body", async (status) => {
		const encoder = new BHttpEncoder();
		const known = await encoder.encodeResponse(new Response(null, { status }));
		const indeterminate = new Uint8Array([3, ...encodeVli(status), 0, 0, 0]);
		for (const bytes of [known, indeterminate]) {
			const response = new BHttpDecoder().decodeResponse(bytes);
			expect(response.status).toBe(status);
			expect(response.body).toBeNull();
			expect(await response.text()).toBe("");
		}
	});
});

describe("decoder padding", () => {
	it.each([1, 3])("discards padding on every push for framing %i", (framing) => {
		const decoder = new BHttpStreamDecoder();
		decoder.push(new Uint8Array([framing, 0x40, 200, 0, 0, 0, 0, 0]));
		// Inspect retained storage: successful decoding alone cannot catch accumulation.
		const retained = () => (decoder as unknown as { _buffer: Uint8Array })._buffer.byteLength;
		expect(retained()).toBe(0);
		const padding = new Uint8Array(4096);
		for (let i = 0; i < 256; i++) {
			expect(decoder.push(padding)).toEqual([]);
			expect(retained()).toBe(0);
		}
		expect(decoder.end()).toEqual([{ type: "end" }]);
		expect(decoder.end()).toEqual([]);
		expect(() => decoder.push(padding)).toThrow("Decoder already finished");
	});
	it.each([1, 3])("rejects nonzero padding during push for framing %i", (framing) => {
		const bytes = new Uint8Array([framing, 0x40, 200, 0, 0, 0, 0, 1]);
		for (let split = 0; split < bytes.length; split++) {
			const decoder = new BHttpStreamDecoder();
			decoder.push(bytes.subarray(0, split));
			expect(() => decoder.push(bytes.subarray(split))).toThrow(InvalidMessageError);
		}
	});
});

describe("request length validation", () => {
	const control = [...new TextEncoder().encode("\u0004POST\u0005https\u000bexample.com\u0001/")];
	it.each([0, 2])("rejects truncated control data for framing %i", (framing) => {
		for (let end = 1; end <= control.length; end++) {
			const bytes = new Uint8Array([framing, ...control]).subarray(0, end);
			expect(() => new BHttpDecoder().decodeRequest(bytes)).toThrow(InvalidMessageError);
			const decoder = new BHttpStreamDecoder();
			for (const byte of bytes) decoder.push(new Uint8Array([byte]));
			expect(() => decoder.end()).toThrow(InvalidMessageError);
		}
	});
	it.each([
		[0, 3, 1, 120, 2, 97, 98],
		[0, 0, 5, 104, 105],
		[0, 0, 0, 3, 1, 120, 2, 97, 98],
		[2, 0, 2, 104],
		[2, 0, 2, 104, 105],
	])("rejects malformed request %j", (framing, ...tail) => {
		const bytes = new Uint8Array([framing, ...control, ...tail]);
		expect(() => new BHttpDecoder().decodeRequest(bytes)).toThrow(InvalidMessageError);
		for (let split = 0; split <= bytes.length; split++) {
			expect(() => {
				const decoder = new BHttpStreamDecoder();
				decoder.push(bytes.subarray(0, split));
				decoder.push(bytes.subarray(split));
				decoder.end();
			}).toThrow(InvalidMessageError);
		}
	});
});
