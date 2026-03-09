/**
 * Streaming BHTTP encoder for indeterminate-length messages.
 *
 * RFC 9292 Section 3.2: Indeterminate-Length Messages
 * - Framing indicator 2 = request, 3 = response
 * - Headers terminated by 0 (Name Length = 0)
 * - Content chunks: varint length + data, terminated by 0
 * - Trailers terminated by 0
 */

import { encodeVli, vliEncodedLength } from "./vli.ts";

const FRAMING_REQUEST_INDETERMINATE = 2;
const FRAMING_RESPONSE_INDETERMINATE = 3;

const textEncoder = new TextEncoder();

/**
 * Encode a string with VLI length prefix.
 */
function encodeVliString(s: string): Uint8Array {
	const bytes = textEncoder.encode(s);
	const lenVli = encodeVli(bytes.length);
	const result = new Uint8Array(lenVli.length + bytes.length);
	result.set(lenVli);
	result.set(bytes, lenVli.length);
	return result;
}

/**
 * Encode headers as indeterminate-length field section.
 * Each field: Name Length (i), Name, Value Length (i), Value
 * Terminated by Name Length = 0
 */
function encodeIndeterminateHeaders(headers: Headers): Uint8Array {
	const parts: Uint8Array[] = [];
	let totalLen = 0;

	headers.forEach((value, name) => {
		const nameBytes = encodeVliString(name);
		const valueBytes = encodeVliString(value);
		parts.push(nameBytes, valueBytes);
		totalLen += nameBytes.length + valueBytes.length;
	});

	// Terminator: Name Length = 0
	const terminator = encodeVli(0);
	totalLen += terminator.length;

	const result = new Uint8Array(totalLen);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	result.set(terminator, offset);

	return result;
}

/**
 * Streaming encoder for BHTTP requests (indeterminate-length).
 *
 * Usage:
 * ```ts
 * const encoder = new BHttpRequestStreamEncoder();
 * yield encoder.encodePreamble("POST", "https", "example.com", "/api", headers);
 * yield encoder.encodeContentChunk(chunk1);
 * yield encoder.encodeContentChunk(chunk2);
 * yield encoder.encodeEnd();
 * ```
 */
export class BHttpRequestStreamEncoder {
	private _preambleEncoded = false;
	private _ended = false;

	/**
	 * Encode request preamble: framing indicator + control data + headers.
	 *
	 * @param method - HTTP method (e.g., "GET", "POST")
	 * @param scheme - URL scheme (e.g., "https")
	 * @param authority - Host and optional port (e.g., "example.com:8080")
	 * @param path - Request path with query (e.g., "/api?foo=bar")
	 * @param headers - Request headers
	 */
	encodePreamble(
		method: string,
		scheme: string,
		authority: string,
		path: string,
		headers: Headers,
	): Uint8Array {
		if (this._preambleEncoded) {
			throw new Error("Preamble already encoded");
		}
		this._preambleEncoded = true;

		const parts: Uint8Array[] = [];

		// Framing indicator
		parts.push(encodeVli(FRAMING_REQUEST_INDETERMINATE));

		// Request Control Data
		parts.push(encodeVliString(method));
		parts.push(encodeVliString(scheme));
		parts.push(encodeVliString(authority));
		parts.push(encodeVliString(path));

		// Headers (indeterminate-length)
		parts.push(encodeIndeterminateHeaders(headers));

		// Concatenate
		const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
		const result = new Uint8Array(totalLen);
		let offset = 0;
		for (const part of parts) {
			result.set(part, offset);
			offset += part.length;
		}

		return result;
	}

	/**
	 * Encode a content chunk.
	 *
	 * @param data - Chunk data (must be non-empty)
	 */
	encodeContentChunk(data: Uint8Array): Uint8Array {
		if (!this._preambleEncoded) {
			throw new Error("Preamble must be encoded first");
		}
		if (this._ended) {
			throw new Error("Encoding already ended");
		}
		if (data.length === 0) {
			throw new Error("Content chunk cannot be empty");
		}

		const lenVli = encodeVli(data.length);
		const result = new Uint8Array(lenVli.length + data.length);
		result.set(lenVli);
		result.set(data, lenVli.length);
		return result;
	}

	/**
	 * Encode end: content terminator + trailers.
	 *
	 * @param trailers - Optional trailing headers
	 */
	encodeEnd(trailers?: Headers): Uint8Array {
		if (!this._preambleEncoded) {
			throw new Error("Preamble must be encoded first");
		}
		if (this._ended) {
			throw new Error("Encoding already ended");
		}
		this._ended = true;

		const parts: Uint8Array[] = [];

		// Content terminator: length = 0
		parts.push(encodeVli(0));

		// Trailers (indeterminate-length)
		if (trailers) {
			parts.push(encodeIndeterminateHeaders(trailers));
		} else {
			// Empty trailers: just terminator
			parts.push(encodeVli(0));
		}

		const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
		const result = new Uint8Array(totalLen);
		let offset = 0;
		for (const part of parts) {
			result.set(part, offset);
			offset += part.length;
		}

		return result;
	}
}

/**
 * Streaming encoder for BHTTP responses (indeterminate-length).
 *
 * Usage:
 * ```ts
 * const encoder = new BHttpResponseStreamEncoder();
 * yield encoder.encodePreamble(200, headers);
 * yield encoder.encodeContentChunk(chunk1);
 * yield encoder.encodeEnd();
 * ```
 */
export class BHttpResponseStreamEncoder {
	private _preambleEncoded = false;
	private _ended = false;

	/**
	 * Encode response preamble: framing indicator + status + headers.
	 *
	 * @param status - HTTP status code (e.g., 200, 404)
	 * @param headers - Response headers
	 * @param informationalResponses - Optional 1xx informational responses
	 */
	encodePreamble(
		status: number,
		headers: Headers,
		informationalResponses?: Array<{ status: number; headers: Headers }>,
	): Uint8Array {
		if (this._preambleEncoded) {
			throw new Error("Preamble already encoded");
		}
		if (status < 200 || status >= 600) {
			throw new Error("Final status must be 200-599");
		}
		this._preambleEncoded = true;

		const parts: Uint8Array[] = [];

		// Framing indicator
		parts.push(encodeVli(FRAMING_RESPONSE_INDETERMINATE));

		// Informational responses (1xx)
		if (informationalResponses) {
			for (const ir of informationalResponses) {
				if (ir.status < 100 || ir.status >= 200) {
					throw new Error("Informational status must be 100-199");
				}
				parts.push(encodeVli(ir.status));
				parts.push(encodeIndeterminateHeaders(ir.headers));
			}
		}

		// Final status
		parts.push(encodeVli(status));

		// Headers (indeterminate-length)
		parts.push(encodeIndeterminateHeaders(headers));

		// Concatenate
		const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
		const result = new Uint8Array(totalLen);
		let offset = 0;
		for (const part of parts) {
			result.set(part, offset);
			offset += part.length;
		}

		return result;
	}

	/**
	 * Encode a content chunk.
	 *
	 * @param data - Chunk data (must be non-empty)
	 */
	encodeContentChunk(data: Uint8Array): Uint8Array {
		if (!this._preambleEncoded) {
			throw new Error("Preamble must be encoded first");
		}
		if (this._ended) {
			throw new Error("Encoding already ended");
		}
		if (data.length === 0) {
			throw new Error("Content chunk cannot be empty");
		}

		const lenVli = encodeVli(data.length);
		const result = new Uint8Array(lenVli.length + data.length);
		result.set(lenVli);
		result.set(data, lenVli.length);
		return result;
	}

	/**
	 * Encode end: content terminator + trailers.
	 *
	 * @param trailers - Optional trailing headers
	 */
	encodeEnd(trailers?: Headers): Uint8Array {
		if (!this._preambleEncoded) {
			throw new Error("Preamble must be encoded first");
		}
		if (this._ended) {
			throw new Error("Encoding already ended");
		}
		this._ended = true;

		const parts: Uint8Array[] = [];

		// Content terminator: length = 0
		parts.push(encodeVli(0));

		// Trailers (indeterminate-length)
		if (trailers) {
			parts.push(encodeIndeterminateHeaders(trailers));
		} else {
			// Empty trailers: just terminator
			parts.push(encodeVli(0));
		}

		const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
		const result = new Uint8Array(totalLen);
		let offset = 0;
		for (const part of parts) {
			result.set(part, offset);
			offset += part.length;
		}

		return result;
	}
}
