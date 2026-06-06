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
});
