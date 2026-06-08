import { describe, expect, it } from "vitest";

import { BHttpDecoder } from "../src/decoder";
import { BHttpEncoder } from "../src/encoder";

describe("BHttpDecoder/Encoder", () => {
	describe("GET", () => {
		it("should encode and decode a GET request.", async () => {
			const req = new Request("https://www.example.com/hello.txt", {
				method: "GET",
				headers: {
					"User-Agent": "curl/7.16.3 libcurl/7.16.3 OpenSSL/0.9.7l zlib/1.2.3",
					"Accept-Language": "en, mi",
				},
			});
			// Decode a Request object to a BHTTP binary string.
			const encoder = new BHttpEncoder();
			const binReq = await encoder.encodeRequest(req);

			// Decode the BHTTP binary string to a Request object.
			const decoder = new BHttpDecoder();
			let decodedReq = decoder.decodeRequest(binReq);
			// ArrayBuffer is also supported.
			decodedReq = decoder.decodeRequest(binReq.buffer as ArrayBuffer);

			// assert
			expect(decodedReq.headers.get("user-agent")).toBe(
				"curl/7.16.3 libcurl/7.16.3 OpenSSL/0.9.7l zlib/1.2.3",
			);
			expect(decodedReq.headers.get("accept-language")).toBe("en, mi");
		});

		it("should encode and decode a GET request with query parameters.", async () => {
			const req = new Request("https://www.example.com/query?foo=bar", {
				method: "GET",
				headers: {
					"User-Agent": "curl/7.16.3 libcurl/7.16.3 OpenSSL/0.9.7l zlib/1.2.3",
					"Accept-Language": "en, mi",
				},
			});
			// Decode a Request object to a BHTTP binary string.
			const encoder = new BHttpEncoder();
			const binReq = await encoder.encodeRequest(req);

			// Decode the BHTTP binary string to a Request object.
			const decoder = new BHttpDecoder();
			let decodedReq = decoder.decodeRequest(binReq);
			// ArrayBuffer is also supported.
			decodedReq = decoder.decodeRequest(binReq.buffer as ArrayBuffer);

			// assert
			expect(decodedReq.headers.get("user-agent")).toBe(
				"curl/7.16.3 libcurl/7.16.3 OpenSSL/0.9.7l zlib/1.2.3",
			);
			expect(decodedReq.headers.get("accept-language")).toBe("en, mi");
			expect(decodedReq.url).toBe("https://www.example.com/query?foo=bar");
		});
	});

	describe("POST", () => {
		it("should encode and decode a POST request.", async () => {
			const req = new Request("https://www.example.com/hello.txt", {
				method: "POST",
				headers: { "Content-Type": "text/plain" },
				body: "Hello world!",
			});
			const encoder = new BHttpEncoder();
			const binReq = await encoder.encodeRequest(req);

			const decoder = new BHttpDecoder();
			const decodedReq = decoder.decodeRequest(binReq);

			// assert
			expect(decodedReq.method).toBe("POST");
			expect(decodedReq.headers.get("content-type")).toBe("text/plain");
			expect(decodedReq.url).toBe("https://www.example.com/hello.txt");
			const body = await decodedReq.text();
			expect(body).toBe("Hello world!");
		});

		it("should encode and decode a POST request with string[][] headers.", async () => {
			const req = new Request("https://www.example.com/hello.txt", {
				method: "POST",
				headers: [["Content-Type", "text/plain"]],
				body: "Hello world!",
			});
			const encoder = new BHttpEncoder();
			const binReq = await encoder.encodeRequest(req);

			const decoder = new BHttpDecoder();
			const decodedReq = decoder.decodeRequest(binReq);

			// assert
			expect(decodedReq.method).toBe("POST");
			expect(decodedReq.headers.get("content-type")).toBe("text/plain");
			expect(decodedReq.url).toBe("https://www.example.com/hello.txt");
			const body = await decodedReq.text();
			expect(body).toBe("Hello world!");
		});

		it("should encode and decode a POST request with HeadersInit headers.", async () => {
			const headers = new Headers();
			headers.set("Content-Type", "text/plain");
			const req = new Request("https://www.example.com/hello.txt", {
				method: "POST",
				headers: headers,
				body: "Hello world!",
			});
			const encoder = new BHttpEncoder();
			const binReq = await encoder.encodeRequest(req);

			const decoder = new BHttpDecoder();
			const decodedReq = decoder.decodeRequest(binReq);

			// assert
			expect(decodedReq.method).toBe("POST");
			expect(decodedReq.headers.get("content-type")?.slice(0, "text/plain".length)).toBe(
				"text/plain",
			);
			expect(decodedReq.url).toBe("https://www.example.com/hello.txt");
			const body = await decodedReq.text();
			expect(body).toBe("Hello world!");
		});
	});

	// RFC 9292 Section 3.8: the encoder can omit an empty trailer section, and a
	// decoder reads a missing trailer section as if its length were zero.
	describe("truncated trailers", () => {
		it("decodes a known-length request whose empty trailer section is omitted", async () => {
			const encoder = new BHttpEncoder();
			const full = await encoder.encodeRequest(
				new Request("https://www.example.com/", { method: "GET" }),
			);
			// The final byte is the trailer length VLI (0); drop it to simulate truncation.
			const truncated = full.subarray(0, full.length - 1);

			const decoder = new BHttpDecoder();
			const req = decoder.decodeRequest(truncated);
			expect(req.method).toBe("GET");
			expect(req.url).toBe("https://www.example.com/");
		});

		it("decodes a known-length response whose empty trailer section is omitted", async () => {
			const encoder = new BHttpEncoder();
			const full = await encoder.encodeResponse(new Response("hi", { status: 200 }));
			const truncated = full.subarray(0, full.length - 1);

			const decoder = new BHttpDecoder();
			const res = decoder.decodeResponse(truncated);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe("hi");
		});

		it("treats an omitted content section (and trailers) as empty", async () => {
			const encoder = new BHttpEncoder();
			const headers = new Headers({ "content-type": "text/plain" });
			const full = await encoder.encodeRequest(
				new Request("https://www.example.com/", { method: "POST", headers, body: "Hello" }),
			);
			// Truncate everything after the header section: this drops the content
			// length, the content bytes and the trailer length in one go.
			const headerEnd = full.indexOf("Hello".charCodeAt(0));
			const truncated = full.subarray(0, headerEnd);

			const decoder = new BHttpDecoder();
			const req = decoder.decodeRequest(truncated);
			expect(req.method).toBe("POST");
			expect(req.headers.get("content-type")?.startsWith("text/plain")).toBe(true);
			expect(await req.text()).toBe("");
		});
	});
});
