import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import { MAX, decodeVli, encodeVli, vliEncodedLength } from "../src/vli.ts";

describe("VLI", () => {
	describe("vliEncodedLength", () => {
		it("returns 1 for values 0-63", () => {
			assertEquals(vliEncodedLength(0), 1);
			assertEquals(vliEncodedLength(63), 1);
		});

		it("returns 2 for values 64-16383", () => {
			assertEquals(vliEncodedLength(64), 2);
			assertEquals(vliEncodedLength(16383), 2);
		});

		it("returns 4 for values 16384-1073741823", () => {
			assertEquals(vliEncodedLength(16384), 4);
			assertEquals(vliEncodedLength(1073741823), 4);
		});

		it("returns 8 for values up to MAX", () => {
			assertEquals(vliEncodedLength(1073741824), 8);
			assertEquals(vliEncodedLength(MAX), 8);
		});
	});

	describe("encodeVli + decodeVli roundtrip", () => {
		const testValues = [
			0,
			1,
			63, // max 1-byte
			64, // min 2-byte
			16383, // max 2-byte
			16384, // min 4-byte
			1073741823, // max 4-byte
			1073741824, // min 8-byte
			MAX, // max supported
		];

		for (const value of testValues) {
			it(`roundtrips ${value}`, () => {
				const encoded = encodeVli(value);
				const decoded = decodeVli(encoded, 0);
				assertEquals(decoded?.value, value);
				assertEquals(decoded?.bytesRead, encoded.length);
			});
		}
	});

	describe("decodeVli streaming", () => {
		it("returns undefined when buffer is empty", () => {
			assertEquals(decodeVli(new Uint8Array(0), 0), undefined);
		});

		it("returns undefined when not enough bytes for 2-byte VLI", () => {
			const encoded = encodeVli(64); // 2-byte encoding
			assertEquals(encoded.length, 2);
			assertEquals(decodeVli(encoded.subarray(0, 1), 0), undefined);
		});

		it("returns undefined when not enough bytes for 4-byte VLI", () => {
			const encoded = encodeVli(16384); // 4-byte encoding
			assertEquals(encoded.length, 4);
			assertEquals(decodeVli(encoded.subarray(0, 3), 0), undefined);
		});

		it("returns undefined when not enough bytes for 8-byte VLI", () => {
			const encoded = encodeVli(MAX); // 8-byte encoding
			assertEquals(encoded.length, 8);
			assertEquals(decodeVli(encoded.subarray(0, 7), 0), undefined);
		});

		it("decodes with offset", () => {
			const padding = new Uint8Array([0xff, 0xff]);
			const encoded = encodeVli(42);
			const buf = new Uint8Array(padding.length + encoded.length);
			buf.set(padding);
			buf.set(encoded, padding.length);

			const result = decodeVli(buf, padding.length);
			assertEquals(result?.value, 42);
			assertEquals(result?.bytesRead, 1);
		});
	});
});
