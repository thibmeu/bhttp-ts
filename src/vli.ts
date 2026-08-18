/**
 * Variable-Length Integer utilities.
 */

import { encode, length, MAX, MIN, tryReadFrom } from "quicvarint";

export { encode as encodeVli, length as vliEncodedLength, MAX, MIN };

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
 * Returns undefined if not enough bytes are available (enables streaming).
 *
 * @throws if the encoded value exceeds {@link MAX}.
 */
export function decodeVli(buf: Uint8Array, offset: number): VliDecodeResult | undefined {
	if (offset >= buf.length) {
		return undefined;
	}

	const cursor = { buf, p: offset };
	const value = tryReadFrom(cursor);
	return value === undefined ? undefined : { value, bytesRead: cursor.p - offset };
}
