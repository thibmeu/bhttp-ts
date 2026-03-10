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
 * Decode a VLI from buffer at offset.
 *
 * Returns undefined if not enough bytes available (enables streaming).
 * Throws if value exceeds MAX.
 */
export function decodeVli(buf: Uint8Array, offset: number): VliDecodeResult | undefined {
	if (offset >= buf.length) {
		return undefined;
	}

	try {
		const result = quicDecode(buf.subarray(offset));
		return { value: result.value, bytesRead: result.usize };
	} catch {
		return undefined;
	}
}
