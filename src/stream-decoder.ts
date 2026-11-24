/**
 * Streaming BHTTP decoder for incremental parsing.
 *
 * Accepts bytes incrementally via push(), yields events as they're parsed.
 * Supports both known-length (0/1) and indeterminate-length (2/3) messages.
 */

import { type Cursor, tryReadFrom, MAX as VLI_MAX } from "quicvarint";
import {
	InvalidMessageError,
	MetadataLimitExceededError,
	metadataSizeLimit,
	NotSupportedError,
} from "./errors";

const EMPTY = new Uint8Array(0);

// Framing indicators
const FRAMING_REQUEST_KNOWN = 0;
const FRAMING_RESPONSE_KNOWN = 1;
const FRAMING_REQUEST_INDETERMINATE = 2;
const FRAMING_RESPONSE_INDETERMINATE = 3;

const textDecoder = new TextDecoder();
const fetchMessage = Symbol("Fetch message decoding");

export const BODYLESS_REQUEST_ERROR = "GET and HEAD requests cannot have content";
export const BODYLESS_RESPONSE_ERROR = "204, 205, and 304 responses cannot have content";

export function isBodylessRequest(method: string): boolean {
	return /^(?:GET|HEAD)$/i.test(method);
}

export function isBodylessResponse(status: number): boolean {
	return status === 204 || status === 205 || status === 304;
}

export function decodeByteString(bytes: Uint8Array): string {
	// Convert bytes in bounded calls to stay below engine argument limits.
	if (bytes.length <= 8192) return Reflect.apply(String.fromCharCode, null, bytes);
	let value = "";
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		value += Reflect.apply(String.fromCharCode, null, bytes.subarray(offset, offset + 8192));
	}
	return value;
}

/** Collect split Cookie fields for the RFC 9292 "; " join. */
export class FieldSection {
	private readonly headers = new Headers();
	private cookies: string[] | undefined;

	append(name: string, value: string): void {
		if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
			throw new InvalidMessageError("Invalid field name");
		}
		if (value.includes("\0") || value.includes("\r") || value.includes("\n")) {
			throw new InvalidMessageError("Invalid field value");
		}
		try {
			if (name.length === 6 && name.toLowerCase() === "cookie") {
				// Match Fetch's normalization for each field before combining them.
				value = value.replace(/^[ \t]+|(?<![ \t])[ \t]+$/g, "");
				this.cookies ??= [];
				this.cookies.push(value);
			} else {
				this.headers.append(name, value);
			}
		} catch (cause) {
			if (!(cause instanceof TypeError)) throw cause;
			throw new InvalidMessageError("Invalid field name or value", { cause });
		}
	}

	get empty(): boolean {
		return this.cookies === undefined && this.headers.keys().next().done === true;
	}

	finish(): Headers {
		if (this.cookies !== undefined) {
			this.headers.append("cookie", this.cookies.join("; "));
			this.cookies = undefined;
		}
		return this.headers;
	}
}

export interface BHttpStreamDecoderOptions {
	/**
	 * Maximum total encoded non-content bytes accepted in one message.
	 *
	 * This includes request control data, response status and informational
	 * responses, header fields, trailers, and their length encodings. Content
	 * and padding are excluded.
	 *
	 * @default 65536
	 */
	readonly maxMetadataSize?: number;
}

export function createFetchStreamDecoder(options: BHttpStreamDecoderOptions): BHttpStreamDecoder {
	const fetchOptions = { ...options, [fetchMessage]: true };
	return new BHttpStreamDecoder(fetchOptions);
}

/**
 * Events emitted by the streaming decoder.
 */
export type BHttpEvent =
	| BHttpRequestPreambleEvent
	| BHttpResponsePreambleEvent
	| BHttpInformationalEvent
	| BHttpContentEvent
	| BHttpTrailersEvent
	| BHttpEndEvent;

export interface BHttpRequestPreambleEvent {
	readonly type: "request-preamble";
	readonly method: string;
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	readonly headers: Headers;
}

export interface BHttpResponsePreambleEvent {
	readonly type: "response-preamble";
	readonly status: number;
	readonly headers: Headers;
}

export interface BHttpInformationalEvent {
	readonly type: "informational";
	readonly status: number;
	readonly headers: Headers;
}

export interface BHttpContentEvent {
	readonly type: "content";
	/** Content bytes. Events form a byte stream: one encoded content chunk may
	 * surface as several events (bytes are emitted as they arrive rather than
	 * buffered until the chunk completes), so chunk boundaries are not
	 * preserved. May be a view into a buffer passed to push(); valid as long
	 * as the caller does not mutate buffers it has pushed. */
	readonly data: Uint8Array;
}

export interface BHttpTrailersEvent {
	readonly type: "trailers";
	readonly headers: Headers;
}

export interface BHttpEndEvent {
	readonly type: "end";
}

/**
 * Decoder state machine phases.
 */
type DecoderPhase =
	| "framing"
	| "request-control"
	| "response-status"
	| "headers-known"
	| "headers-indeterminate"
	| "content-known"
	| "content-indeterminate"
	| "trailers-known"
	| "trailers-indeterminate"
	| "padding"
	| "done";

/**
 * Streaming BHTTP decoder.
 *
 * Usage:
 * ```ts
 * const decoder = new BHttpStreamDecoder();
 * for (const chunk of incomingData) {
 *   for (const event of decoder.push(chunk)) {
 *     switch (event.type) {
 *       case "request-preamble": // ...
 *       case "content": // ...
 *     }
 *   }
 * }
 * for (const event of decoder.end()) {
 *   // handle final events
 * }
 * ```
 */
export class BHttpStreamDecoder {
	private _buffer: Uint8Array = EMPTY;
	// Spare capacity for input that has not been exposed in a content event.
	private _ownedBuffer: Uint8Array | undefined;
	private _offset = 0;
	private _phase: DecoderPhase = "framing";

	// Message type determined from framing indicator
	private _isRequest = false;
	private _isKnownLength = false;

	private readonly _fetchMessage: boolean;
	private _contentError: string | undefined;

	// Request control data (accumulated across calls)
	private _method = "";
	private _scheme = "";
	private _authority = "";
	private _path = "";
	private _controlStep = 0; // 0=method, 1=scheme, 2=authority, 3=path

	// Response status
	private _status = 0;
	// Non-null while an informational field section is incomplete.
	private _informationalStatus: number | null = null;

	// Final header and trailer retries roll back the section length and metadata charge together.
	private _knownSectionLen = 0;
	private _knownSectionEnd = 0;
	private _knownSectionLenRead = false;

	// Bytes of the current indeterminate-length content chunk not yet emitted
	private _contentRemaining = 0;
	// Distinguishes an omitted content section from a started one at end of input.
	private _contentStarted = false;

	// Accumulated headers/trailers
	private _fields = new FieldSection();
	// A consumed name stays pending until its value arrives; completed fields are never reparsed.
	private _pendingHeaderName: string | null = null;
	private readonly _maxMetadataSize: number;
	// Counts committed encoded metadata bytes exactly once across pushes.
	private _metadataBytes = 0;

	constructor(options: BHttpStreamDecoderOptions = {}) {
		this._maxMetadataSize = metadataSizeLimit(options);
		this._fetchMessage = fetchMessage in options;
	}

	private _chargeMetadata(bytes: number): void {
		if (this._metadataBytes + bytes > this._maxMetadataSize) {
			throw new MetadataLimitExceededError("BHTTP metadata exceeds the configured limit");
		}
		this._metadataBytes += bytes;
	}

	private _shouldContinueProcessing(): boolean {
		return this._phase !== "done" && this._phase !== "padding";
	}

	/**
	 * Push bytes into the decoder and get parsed events.
	 *
	 * The decoder holds `data` by reference until it is consumed, and emitted
	 * content events may be views into it — the caller must not mutate or reuse
	 * a pushed buffer afterwards (copy first when filling a fixed read buffer,
	 * e.g. with a BYOB reader).
	 *
	 * @param data - Incoming bytes
	 * @returns Array of parsed events (may be empty if more data needed)
	 */
	push(data: Uint8Array): BHttpEvent[] {
		if (this._phase === "done") {
			throw new Error("Decoder already finished");
		}

		if (data.length > 0) this._appendInput(data);

		const events: BHttpEvent[] = [];

		// Process as much as possible
		// Note: _processPhase() mutates _phase, so we re-check each iteration
		while (this._shouldContinueProcessing()) {
			const event = this._processPhase();
			if (event === undefined) {
				return events; // Need more data
			}
			if (event !== null) {
				events.push(event);
			}
		}

		this._discardPadding();
		return events;
	}

	private _appendInput(data: Uint8Array): void {
		const remaining = this._buffer.length - this._offset;
		const newEnd = this._buffer.length + data.length;
		const owned = this._ownedBuffer;
		if (remaining > 0 && owned !== undefined && newEnd <= owned.length) {
			owned.set(data, this._buffer.length);
			this._buffer = owned.subarray(0, newEnd);
			return;
		}

		// Drop the consumed prefix and rebase the active known-length boundary.
		this._knownSectionEnd -= this._offset;
		if (remaining === 0) {
			this._buffer = data;
			this._ownedBuffer = undefined;
		} else {
			// Grow geometrically when metadata spans multiple pushes.
			const size = remaining + data.length;
			const buffer = new Uint8Array(Math.max(size, remaining * 2));
			buffer.set(this._buffer.subarray(this._offset));
			buffer.set(data, remaining);
			this._buffer = buffer.subarray(0, size);
			this._ownedBuffer = buffer;
		}
		this._offset = 0;
	}

	/**
	 * Signal end of input and get any remaining events.
	 *
	 * @returns Final events
	 * @throws InvalidMessageError if message is incomplete
	 */
	end(): BHttpEvent[] {
		if (this._phase === "done") {
			return [];
		}

		// RFC 9292 Section 3.8 lets the encoder drop an empty trailer section, plus
		// an empty content section when the trailers are dropped too. So if the
		// input ends while we are still waiting on the content or trailer section
		// and never read its length or terminator, treat it as empty and finish.
		// Anything cut off earlier (mid control data or headers) is invalid and
		// still throws below, and so does a section that started reading its length
		// but never delivered the bytes.
		const atIndeterminateBoundary =
			(this._phase === "content-indeterminate" && !this._contentStarted) ||
			(this._phase === "trailers-indeterminate" &&
				this._pendingHeaderName === null &&
				this._fields.empty);
		const atKnownBoundary =
			(this._phase === "content-known" || this._phase === "trailers-known") &&
			!this._knownSectionLenRead;
		if ((atIndeterminateBoundary || atKnownBoundary) && this._offset === this._buffer.length) {
			this._phase = "padding";
		}

		// Check padding
		if (this._phase === "padding") {
			this._discardPadding();
			this._phase = "done";
			return [{ type: "end" }];
		}

		throw new InvalidMessageError("Incomplete message");
	}

	private _discardPadding(): void {
		while (this._offset < this._buffer.length) {
			if (this._buffer[this._offset++] !== 0) {
				throw new InvalidMessageError("Invalid padding data");
			}
		}
		this._buffer = EMPTY;
		this._ownedBuffer = undefined;
		this._vli.buf = EMPTY;
		this._offset = 0;
	}

	/**
	 * Process current phase, returning event if complete.
	 * Returns undefined if more data needed, null if phase complete but no event.
	 */
	private _processPhase(): BHttpEvent | null | undefined {
		switch (this._phase) {
			case "framing":
				return this._processFraming();
			case "request-control":
				return this._processRequestControl();
			case "response-status":
				return this._processResponseStatus();
			case "headers-known":
				return this._processHeadersKnown();
			case "headers-indeterminate":
				return this._processHeadersIndeterminate();
			case "content-known":
				return this._processContentKnown();
			case "content-indeterminate":
				return this._processContentIndeterminate();
			case "trailers-known":
				return this._processTrailersKnown();
			case "trailers-indeterminate":
				return this._processTrailersIndeterminate();
			default:
				return undefined;
		}
	}

	private _vli: Cursor = { buf: EMPTY, p: 0 };

	/**
	 * Read the VLI at `_offset` without consuming it. `_vli.p` is left pointing
	 * just past it, so a caller that keeps the value assigns `_offset = _vli.p`.
	 *
	 * Returns undefined when the buffer ends mid-VLI. A VLI above quicvarint's
	 * MAX throws, since no amount of further data makes it valid.
	 */
	private _peekVli(): number | undefined {
		this._vli.buf = this._buffer;
		this._vli.p = this._offset;
		try {
			return tryReadFrom(this._vli);
		} catch (e) {
			throw new NotSupportedError(`Over ${VLI_MAX}-length value is not supported.`, {
				cause: e,
			});
		}
	}

	private _processFraming(): null | undefined {
		const start = this._offset;
		const framing = this._peekVli();
		if (framing === undefined) return undefined;
		this._offset = this._vli.p;
		this._chargeMetadata(this._offset - start);

		switch (framing) {
			case FRAMING_REQUEST_KNOWN:
				this._isRequest = true;
				this._isKnownLength = true;
				this._phase = "request-control";
				break;
			case FRAMING_RESPONSE_KNOWN:
				this._isRequest = false;
				this._isKnownLength = true;
				this._phase = "response-status";
				break;
			case FRAMING_REQUEST_INDETERMINATE:
				this._isRequest = true;
				this._isKnownLength = false;
				this._phase = "request-control";
				break;
			case FRAMING_RESPONSE_INDETERMINATE:
				this._isRequest = false;
				this._isKnownLength = false;
				this._phase = "response-status";
				break;
			default:
				throw new InvalidMessageError("Invalid framing indicator");
		}

		return null;
	}

	private _processRequestControl(): null | undefined {
		// Process control data fields one at a time, saving state between calls
		while (this._controlStep < 4) {
			const saveOffset = this._offset;
			const str = this._tryDecodeVliString();
			if (str === undefined) {
				this._offset = saveOffset;
				return undefined;
			}

			switch (this._controlStep) {
				case 0:
					this._method = str;
					if (this._fetchMessage && isBodylessRequest(str)) {
						this._contentError = BODYLESS_REQUEST_ERROR;
					}
					break;
				case 1:
					this._scheme = str;
					break;
				case 2:
					this._authority = str;
					break;
				case 3:
					this._path = str;
					break;
			}
			this._controlStep++;
		}

		// Move to headers
		this._phase = this._isKnownLength ? "headers-known" : "headers-indeterminate";
		return null;
	}

	private _processResponseStatus(): BHttpInformationalEvent | null | undefined {
		let status: number;
		if (this._informationalStatus === null) {
			const statusStart = this._offset;
			const parsedStatus = this._peekVli();
			if (parsedStatus === undefined) return undefined;
			status = parsedStatus;
			this._offset = this._vli.p;
			this._chargeMetadata(this._offset - statusStart);
		} else {
			status = this._informationalStatus;
		}

		// Check for informational response (1xx)
		if (status >= 100 && status < 200) {
			if (this._informationalStatus === null) {
				this._informationalStatus = status;
			}

			// Try to parse headers for informational response
			const complete = this._isKnownLength
				? this._tryParseKnownLengthHeaders()
				: this._tryParseIndeterminateLengthHeaders();

			if (!complete) {
				return undefined;
			}

			const event: BHttpInformationalEvent = {
				type: "informational",
				status,
				headers: this._fields.finish(),
			};
			this._fields = new FieldSection();
			this._knownSectionLenRead = false;
			this._informationalStatus = null;
			return event;
		}

		// Final status
		if (status < 200 || status >= 600) {
			throw new InvalidMessageError("Invalid status code");
		}

		this._status = status;
		if (this._fetchMessage && isBodylessResponse(status)) {
			this._contentError = BODYLESS_RESPONSE_ERROR;
		}
		this._phase = this._isKnownLength ? "headers-known" : "headers-indeterminate";

		return null;
	}

	private _processHeadersKnown():
		| BHttpRequestPreambleEvent
		| BHttpResponsePreambleEvent
		| null
		| undefined {
		const saveOffset = this._offset;
		const saveMetadataBytes = this._metadataBytes;

		const complete = this._tryParseKnownLengthHeaders();
		if (!complete) {
			this._offset = saveOffset;
			this._knownSectionLenRead = false;
			this._metadataBytes = saveMetadataBytes;
			return undefined;
		}

		const event = this._emitPreambleEvent();
		this._phase = "content-known";
		this._knownSectionLenRead = false;
		return event;
	}

	private _processHeadersIndeterminate():
		| BHttpRequestPreambleEvent
		| BHttpResponsePreambleEvent
		| null
		| undefined {
		const complete = this._tryParseIndeterminateLengthHeaders();
		if (!complete) {
			return undefined;
		}

		const event = this._emitPreambleEvent();
		this._phase = "content-indeterminate";
		this._pendingHeaderName = null;
		return event;
	}

	private _tryParseKnownLengthHeaders(): boolean {
		// Read the headers length if not yet read
		if (!this._knownSectionLenRead) {
			const lengthStart = this._offset;
			const sectionLen = this._peekVli();
			if (sectionLen === undefined) return false;
			this._chargeMetadata(this._vli.p - lengthStart + sectionLen);
			this._knownSectionLen = sectionLen;
			this._offset = this._vli.p;
			this._knownSectionEnd = this._offset + this._knownSectionLen;
			this._knownSectionLenRead = true;
		}

		// Check if we have all header bytes
		if (this._buffer.length < this._knownSectionEnd) {
			return false;
		}

		// Parse headers until we reach the end
		while (this._offset < this._knownSectionEnd) {
			const name = this._tryDecodeVliString(false, true);
			if (name === undefined) return false;
			const value = this._tryDecodeVliString(false, true);
			if (value === undefined) return false;

			this._fields.append(name, value);
		}

		return true;
	}

	private _tryParseIndeterminateLengthHeaders(): boolean {
		// Headers terminated by Name Length = 0
		while (true) {
			// If we have a pending header name, try to get value
			if (this._pendingHeaderName !== null) {
				const value = this._tryDecodeVliString(true, true);
				if (value === undefined) return false;

				this._fields.append(this._pendingHeaderName, value);
				this._pendingHeaderName = null;
				continue;
			}

			// Try to read next name length (or terminator)
			const nameLen = this._peekVli();
			if (nameLen === undefined) return false;

			if (nameLen === 0) {
				// Terminator
				this._chargeMetadata(this._vli.p - this._offset);
				this._offset = this._vli.p;
				return true;
			}

			// Read the name
			const name = this._tryDecodeVliString(true, true);
			if (name === undefined) return false;

			// Save name and try to get value on next iteration
			this._pendingHeaderName = name;
		}
	}

	private _emitPreambleEvent(): BHttpRequestPreambleEvent | BHttpResponsePreambleEvent {
		const headers = this._fields.finish();
		if (this._isRequest) {
			return {
				type: "request-preamble",
				method: this._method,
				scheme: this._scheme,
				authority: this._authority,
				path: this._path,
				headers,
			};
		}
		return {
			type: "response-preamble",
			status: this._status,
			headers,
		};
	}

	private _processContentKnown(): BHttpContentEvent | null | undefined {
		// Read the content length if not yet read
		if (!this._knownSectionLenRead) {
			const sectionLen = this._peekVli();
			if (sectionLen === undefined) return undefined;
			if (sectionLen !== 0 && this._contentError !== undefined) {
				throw new InvalidMessageError(this._contentError);
			}
			this._knownSectionLen = sectionLen;
			this._offset = this._vli.p;
			this._knownSectionEnd = this._offset + this._knownSectionLen;
			this._knownSectionLenRead = true;

			if (this._knownSectionLen === 0) {
				this._phase = "trailers-known";
				this._knownSectionLenRead = false;
				return null;
			}
		}

		// Emit available content without waiting for the rest of the section.
		const end = Math.min(this._buffer.length, this._knownSectionEnd);
		if (end <= this._offset) {
			return undefined;
		}
		const data = this._buffer.subarray(this._offset, end);
		this._ownedBuffer = undefined;
		this._offset = end;
		if (this._offset === this._knownSectionEnd) {
			this._phase = "trailers-known";
			this._knownSectionLenRead = false;
		}

		return { type: "content", data };
	}

	private _processContentIndeterminate(): BHttpContentEvent | null | undefined {
		if (this._contentRemaining === 0) {
			const chunkLen = this._peekVli();
			if (chunkLen === undefined) return undefined;

			if (chunkLen === 0) {
				// Terminator - move to trailers
				this._offset = this._vli.p;
				this._phase = "trailers-indeterminate";
				this._fields = new FieldSection();
				this._pendingHeaderName = null;
				return null;
			}

			if (this._contentError !== undefined) {
				throw new InvalidMessageError(this._contentError);
			}
			this._contentStarted = true;
			this._contentRemaining = chunkLen;
			this._offset = this._vli.p;
		}

		// Emit available content without waiting for the rest of the chunk.
		const take = Math.min(this._buffer.length - this._offset, this._contentRemaining);
		if (take === 0) {
			return undefined;
		}
		const data = this._buffer.subarray(this._offset, this._offset + take);
		this._ownedBuffer = undefined;
		this._offset += take;
		this._contentRemaining -= take;

		return { type: "content", data };
	}

	private _processTrailersKnown(): BHttpTrailersEvent | null | undefined {
		const saveOffset = this._offset;
		const saveMetadataBytes = this._metadataBytes;

		// Read the trailers length if not yet read
		if (!this._knownSectionLenRead) {
			const lengthStart = this._offset;
			const sectionLen = this._peekVli();
			if (sectionLen === undefined) return undefined;
			this._chargeMetadata(this._vli.p - lengthStart + sectionLen);
			this._knownSectionLen = sectionLen;
			this._offset = this._vli.p;
			this._knownSectionEnd = this._offset + this._knownSectionLen;
			this._knownSectionLenRead = true;

			if (this._knownSectionLen === 0) {
				this._phase = "padding";
				this._knownSectionLenRead = false;
				return null;
			}
		}

		// Check if we have all trailer bytes
		if (this._buffer.length < this._knownSectionEnd) {
			this._offset = saveOffset;
			this._knownSectionLenRead = false;
			this._metadataBytes = saveMetadataBytes;
			return undefined;
		}

		// Parse trailers
		const trailers = new FieldSection();
		while (this._offset < this._knownSectionEnd) {
			const name = this._tryDecodeVliString(false, true);
			if (name === undefined) {
				this._offset = saveOffset;
				this._knownSectionLenRead = false;
				return undefined;
			}
			const value = this._tryDecodeVliString(false, true);
			if (value === undefined) {
				this._offset = saveOffset;
				this._knownSectionLenRead = false;
				return undefined;
			}
			trailers.append(name, value);
		}

		this._phase = "padding";
		this._knownSectionLenRead = false;
		return { type: "trailers", headers: trailers.finish() };
	}

	private _processTrailersIndeterminate(): BHttpTrailersEvent | null | undefined {
		if (!this._tryParseIndeterminateLengthHeaders()) return undefined;

		this._phase = "padding";

		// Only emit trailers event if there are any
		if (this._fields.empty) {
			return null;
		}

		return { type: "trailers", headers: this._fields.finish() };
	}

	/**
	 * Try to decode a VLI-prefixed string. Returns undefined if not enough data.
	 * Does NOT rollback offset on failure - caller must handle.
	 */
	private _tryDecodeVliString(chargeMetadata = true, byteString = false): string | undefined {
		const start = this._offset;
		if (
			!chargeMetadata &&
			(this._offset >= this._knownSectionEnd ||
				1 << ((this._buffer[this._offset] ?? 0) >> 6) > this._knownSectionEnd - this._offset)
		) {
			throw new InvalidMessageError("Field exceeds section boundary");
		}
		const strLen = this._peekVli();
		if (strLen === undefined) return undefined;

		const strStart = this._vli.p;
		const strEnd = strStart + strLen;
		const encodedSize = strEnd - start;
		if (!chargeMetadata && strLen > this._knownSectionEnd - strStart) {
			throw new InvalidMessageError("Field exceeds section boundary");
		}

		// Validate the declaration without pending-charge state. The existing
		// charge is committed only after the complete string is available.
		if (chargeMetadata && this._metadataBytes + encodedSize > this._maxMetadataSize) {
			throw new MetadataLimitExceededError("BHTTP metadata exceeds the configured limit");
		}

		if (this._buffer.length < strEnd) {
			return undefined;
		}

		if (chargeMetadata) {
			this._chargeMetadata(encodedSize);
		}
		const bytes = this._buffer.subarray(strStart, strEnd);
		const str = byteString ? decodeByteString(bytes) : textDecoder.decode(bytes);
		this._offset = strEnd;
		return str;
	}
}
