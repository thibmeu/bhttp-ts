/**
 * Variable-Length Integer utilities.
 *
 * Re-exports quicvarint and adds streaming decode support.
 */

import {
	MAX,
	MIN,
	decode as quicDecode,
	encode as quicEncode,
	length as quicLength,
} from "quicvarint";

export { MAX, MIN };

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
 * Calculate the encoded length of a VLI value.
 */
export const vliEncodedLength = quicLength;

/**
 * Encode a value as a VLI.
 */
export const encodeVli = quicEncode;

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

	// Create subarray view for quicvarint
	const slice = buf.subarray(offset, offset + expectedLen);
	const result = quicDecode(slice);

	return {
		value: result.value,
		bytesRead: result.usize,
	};
}
