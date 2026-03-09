/**
 * Variable-Length Integer utilities for streaming decode.
 *
 * quicvarint throws on insufficient bytes; this module provides
 * decodeVli() which returns undefined instead (streaming-friendly).
 */

import { MAX, MIN, encode, length, decode as quicDecode } from "quicvarint";

export { MAX, MIN, encode as encodeVli, length as vliEncodedLength };

/**
 * Result of decoding a VLI.
 */
export interface VliDecodeResult {
	/** The decoded value */
	readonly value: number;
	/** Number of bytes consumed */
	readonly bytesRead: number;
}

/**
 * Get expected byte length from VLI first byte.
 */
export function vliExpectedLength(firstByte: number): number {
	const prefix = firstByte >> 6;
	return 1 << prefix; // 0->1, 1->2, 2->4, 3->8
}

/**
 * Decode a VLI from buffer at offset.
 *
 * Returns undefined if not enough bytes available (enables streaming).
 * Throws if value exceeds MAX.
 */
export function decodeVli(buf: Uint8Array, offset: number): VliDecodeResult | undefined {
	if (offset >= buf.length) {
		return undefined;
	}

	const expectedLen = vliExpectedLength(buf[offset]);
	if (offset + expectedLen > buf.length) {
		return undefined;
	}

	const slice = buf.subarray(offset, offset + expectedLen);
	const result = quicDecode(slice);

	return {
		value: result.value,
		bytesRead: result.usize,
	};
}
