import { describe, expect, it } from "vitest";

import { decodeVli, encodeVli, MAX, vliEncodedLength } from "../src/vli";

describe("VLI", () => {
	describe("vliEncodedLength", () => {
		it("returns 1 for values 0-63", () => {
			expect(vliEncodedLength(0)).toBe(1);
			expect(vliEncodedLength(63)).toBe(1);
		});

		it("returns 2 for values 64-16383", () => {
			expect(vliEncodedLength(64)).toBe(2);
			expect(vliEncodedLength(16383)).toBe(2);
		});

		it("returns 4 for values 16384-1073741823", () => {
			expect(vliEncodedLength(16384)).toBe(4);
			expect(vliEncodedLength(1073741823)).toBe(4);
		});

		it("returns 8 for values up to MAX", () => {
			expect(vliEncodedLength(1073741824)).toBe(8);
			expect(vliEncodedLength(MAX)).toBe(8);
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
				expect(decoded?.value).toBe(value);
				expect(decoded?.bytesRead).toBe(encoded.length);
			});
		}
	});

	describe("decodeVli streaming", () => {
		it("returns undefined when buffer is empty", () => {
			expect(decodeVli(new Uint8Array(0), 0)).toBeUndefined();
		});

		it("returns undefined when not enough bytes for 2-byte VLI", () => {
			const encoded = encodeVli(64); // 2-byte encoding
			expect(encoded.length).toBe(2);
			expect(decodeVli(encoded.subarray(0, 1), 0)).toBeUndefined();
		});

		it("returns undefined when not enough bytes for 4-byte VLI", () => {
			const encoded = encodeVli(16384); // 4-byte encoding
			expect(encoded.length).toBe(4);
			expect(decodeVli(encoded.subarray(0, 3), 0)).toBeUndefined();
		});

		it("returns undefined when not enough bytes for 8-byte VLI", () => {
			const encoded = encodeVli(MAX); // 8-byte encoding
			expect(encoded.length).toBe(8);
			expect(decodeVli(encoded.subarray(0, 7), 0)).toBeUndefined();
		});

		it("decodes with offset", () => {
			const padding = new Uint8Array([0xff, 0xff]);
			const encoded = encodeVli(42);
			const buf = new Uint8Array(padding.length + encoded.length);
			buf.set(padding);
			buf.set(encoded, padding.length);

			const result = decodeVli(buf, padding.length);
			expect(result?.value).toBe(42);
			expect(result?.bytesRead).toBe(1);
		});
	});
});
