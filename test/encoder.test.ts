import { describe, expect, it } from "vitest";

import { BHttpDecoder } from "../src/decoder";
import { BHttpEncoder } from "../src/encoder";
import { MessageLimitExceededError } from "../src/errors";

describe("BHttpEncoder", () => {
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

	describe("UTF-8", () => {
		// Latin-1 header values (U+0080..U+00FF) are valid Fetch ByteStrings but
		// encode to multiple UTF-8 bytes, so their UTF-8 byte length exceeds the
		// JS String length. The encoder previously sized the buffer and wrote the
		// VLI length prefix using String.length, corrupting the output. Emoji/CJK
		// in the body are fine because bodies are handled as raw bytes.
		const headerValue = "Ünïcödé-café-piñata"; // every accented char is 2 UTF-8 bytes
		const bodyText = "héllo 世界 \u{1f30d}"; // héllo 世界 🌍

		it("should round-trip multibyte UTF-8 in a request", async () => {
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

		it("should round-trip multibyte UTF-8 in a response", async () => {
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
	});
});
