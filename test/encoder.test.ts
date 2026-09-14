import { describe, expect, it } from "vitest";

import { BHttpDecoder } from "../src/decoder";
import { BHttpEncoder, type BHttpEncoderOptions } from "../src/encoder";
import { MessageLimitExceededError } from "../src/errors";
import { collectBytes } from "./utils";

describe("BHttpEncoder", () => {
	it("rejects error responses consistently in buffered and streaming encoding", async () => {
		const encoder = new BHttpEncoder();
		await expect(encoder.encodeResponse(Response.error())).rejects.toThrow(
			"Final status must be 200-599",
		);
		expect(() => encoder.encodeResponseStream(Response.error())).toThrow(
			"Final status must be 200-599",
		);
	});

	it.each(["request", "response"] as const)(
		"limits and cancels a known-length %s without joining body chunks",
		async (kind) => {
			const encoder = new BHttpEncoder();
			const emptySize =
				kind === "request"
					? (await encoder.encodeRequest(new Request("https://example.com"))).byteLength
					: (await encoder.encodeResponse(new Response())).byteLength;
			let cancelled = false;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(8));
					controller.enqueue(new Uint8Array(8));
				},
				cancel() {
					cancelled = true;
				},
			});
			const message =
				kind === "request"
					? {
							url: "https://example.com",
							method: "POST",
							headers: new Headers(),
							body,
							arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
						}
					: {
							status: 200,
							headers: new Headers(),
							body,
							arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
						};
			const encode =
				kind === "request"
					? encoder.encodeRequest(message as Request, { maxMessageSize: emptySize + 8 })
					: encoder.encodeResponse(message as Response, { maxMessageSize: emptySize + 8 });

			await expect(encode).rejects.toBeInstanceOf(MessageLimitExceededError);
			await expect(encode).rejects.toThrow(/BHTTP message size \d+ exceeds maxMessageSize \d+/);
			expect(cancelled).toBe(true);
		},
	);

	it("accepts a message at the exact encoded limit", async () => {
		const encoder = new BHttpEncoder();
		const bytes = await encoder.encodeResponse(new Response("body"));

		await expect(
			encoder.encodeResponse(new Response("body"), { maxMessageSize: bytes.byteLength }),
		).resolves.toEqual(bytes);
	});

	it.each([-1, 1.5, Number.NaN])("rejects maxMessageSize %p", async (maxMessageSize) => {
		await expect(
			new BHttpEncoder().encodeResponse(new Response(), { maxMessageSize }),
		).rejects.toBeInstanceOf(RangeError);
	});

	describe("POST", () => {
		it("should encode a POST request with over 16383 byte length content.", async () => {
			const req = new Request("https://www.example.com/hello.txt", {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: new Uint8Array(16384).fill(0),
			});
			const encoder = new BHttpEncoder();
			const binReq = await encoder.encodeRequest(req);

			const decoder = new BHttpDecoder();
			const decodedReq = decoder.decodeRequest(binReq);

			// assert
			expect(decodedReq.method).toBe("POST");
			expect(decodedReq.headers.get("content-type")).toBe("application/octet-stream");
			expect(decodedReq.url).toBe("https://www.example.com/hello.txt");
			const body = await decodedReq.arrayBuffer();
			expect(body.byteLength).toBe(16384);
		});

		it("should encode a POST request with over 1073741823 byte length content.", async () => {
			const req = new Request("https://www.example.com/hello.txt", {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: new Uint8Array(1073741824).fill(0),
			});
			const encoder = new BHttpEncoder();
			const binReq = await encoder.encodeRequest(req);

			const decoder = new BHttpDecoder();
			const decodedReq = decoder.decodeRequest(binReq);

			// assert
			expect(decodedReq.method).toBe("POST");
			expect(decodedReq.headers.get("content-type")).toBe("application/octet-stream");
			expect(decodedReq.url).toBe("https://www.example.com/hello.txt");
			const body = await decodedReq.arrayBuffer();
			expect(body.byteLength).toBe(1073741824);
		});
	});

	describe("header octets", () => {
		const headerValue = "Ünïcödé-café-piñata";
		const bodyText = "héllo 世界 \u{1f30d}"; // héllo 世界 🌍

		it("preserves ByteString headers and a UTF-8 request body", async () => {
			const req = new Request("https://www.example.com/hello.txt", {
				method: "POST",
				headers: { "x-greeting": headerValue },
				body: bodyText,
			});
			const encoder = new BHttpEncoder();
			const binReq = await encoder.encodeRequest(req);

			const decoder = new BHttpDecoder();
			const decodedReq = decoder.decodeRequest(binReq);

			expect(decodedReq.headers.get("x-greeting")).toBe(headerValue);
			expect(await decodedReq.text()).toBe(bodyText);
		});

		it("preserves ByteString headers and a UTF-8 response body", async () => {
			const res = new Response(bodyText, {
				status: 200,
				headers: { "x-greeting": headerValue },
			});
			const encoder = new BHttpEncoder();
			const binRes = await encoder.encodeResponse(res);

			const decoder = new BHttpDecoder();
			const decodedRes = decoder.decodeResponse(binRes);

			expect(decodedRes.headers.get("x-greeting")).toBe(headerValue);
			expect(await decodedRes.text()).toBe(bodyText);
		});

		// Workers accepts Unicode headers that other Fetch runtimes reject.
		const supportsUnicodeHeaders = (() => {
			try {
				new Headers({ x: "ā" });
				return true;
			} catch {
				return false;
			}
		})();
		describe.each([false, true])("streaming: %s", (streaming) => {
			it.skipIf(!supportsUnicodeHeaders).each(["\u0100", "ā", "🌍"])(
				"should reject non-ByteString header %s",
				async (value) => {
					// Arrange
					const response = new Response(null, { headers: { x: value } });
					const encoder = new BHttpEncoder();

					// Act / Assert
					if (streaming) {
						expect(() => encoder.encodeResponseStream(response)).toThrow(TypeError);
					} else {
						await expect(encoder.encodeResponse(response)).rejects.toThrow(TypeError);
					}
				},
			);
		});

		it("writes each header character as one wire octet", async () => {
			const bytes = await new BHttpEncoder().encodeResponse(
				new Response(null, { headers: { x: "é" } }),
			);
			expect(bytes).toEqual(new Uint8Array([1, 0x40, 200, 4, 1, 120, 1, 233, 0, 0]));
		});
	});
});

describe.each(["request", "response"] as const)("%s padding", (kind) => {
	describe.each([false, true])("streaming: %s", (streaming) => {
		const test = it.skipIf(
			streaming &&
				kind === "request" &&
				!new Request("https://example.com", { method: "POST", body: "hello" }).body,
		);
		const encode = async (options?: BHttpEncoderOptions) => {
			const encoder = new BHttpEncoder();
			const message =
				kind === "request"
					? new Request("https://example.com/upload", { method: "POST", body: "hello" })
					: new Response("hello");
			const bytes =
				kind === "request"
					? streaming
						? encoder.encodeRequestStream(message as Request, options)
						: encoder.encodeRequest(message as Request, options)
					: streaming
						? encoder.encodeResponseStream(message as Response, options)
						: encoder.encodeResponse(message as Response, options);
			return bytes instanceof ReadableStream ? await collectBytes(bytes) : await bytes;
		};

		test("should leave padding disabled when only maxMessageSize is set", async () => {
			const plain = await encode();
			expect(await encode({ maxMessageSize: plain.length })).toEqual(plain);
			expect(await encode({ padding: 0 })).toEqual(plain);
		});

		test.each([-1, 0, 1])("should pad around an exact boundary (%s)", async (offset) => {
			const plain = await encode();
			const padding = plain.length + offset;
			const padded = await encode({ padding });
			expect(padded.length).toBe(offset === -1 ? padding * 2 : padding);
			expect(padded.subarray(0, plain.length)).toEqual(plain);
			expect(padded.subarray(plain.length)).toEqual(new Uint8Array(padded.length - plain.length));
			const decoder = new BHttpDecoder();
			const decoded =
				kind === "request" ? decoder.decodeRequest(padded) : decoder.decodeResponse(padded);
			expect(await decoded.text()).toBe("hello");
		});

		test("should include padding in the message limit", async () => {
			await expect(encode({ padding: 1024, maxMessageSize: 1024 })).resolves.toHaveLength(1024);
			await expect(encode({ padding: 1024, maxMessageSize: 1023 })).rejects.toBeInstanceOf(
				MessageLimitExceededError,
			);
			await expect(
				encode({ padding: Number.MAX_SAFE_INTEGER, maxMessageSize: 1024 }),
			).rejects.toBeInstanceOf(MessageLimitExceededError);
		});

		test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
			"should reject padding %s",
			async (padding) => {
				await expect(encode({ padding })).rejects.toBeInstanceOf(RangeError);
			},
		);
	});
});
