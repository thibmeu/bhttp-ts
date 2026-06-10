/**
 * Streaming BHTTP decoder for incremental parsing.
 *
 * Accepts bytes incrementally via push(), yields events as they're parsed.
 * Supports both known-length (0/1) and indeterminate-length (2/3) messages.
 */

import { InvalidMessageError } from "./errors";
import { decodeVli } from "./vli";

// Framing indicators
const FRAMING_REQUEST_KNOWN = 0;
const FRAMING_RESPONSE_KNOWN = 1;
const FRAMING_REQUEST_INDETERMINATE = 2;
const FRAMING_RESPONSE_INDETERMINATE = 3;

const textDecoder = new TextDecoder();

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
	/** Content bytes. May be a view into a buffer passed to push(); valid as
	 * long as the caller does not mutate buffers it has pushed. */
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
	private _buffer: Uint8Array = new Uint8Array(0);
	private _offset = 0;
	private _phase: DecoderPhase = "framing";

	// Message type determined from framing indicator
	private _isRequest = false;
	private _isKnownLength = false;

	// Request control data (accumulated across calls)
	private _method = "";
	private _scheme = "";
	private _authority = "";
	private _path = "";
	private _controlStep = 0; // 0=method, 1=scheme, 2=authority, 3=path

	// Response status
	private _status = 0;

	// Known-length section tracking
	private _knownSectionLen = 0;
	private _knownSectionEnd = 0;
	private _knownSectionLenRead = false;

	// Accumulated headers/trailers
	private _headers = new Headers();
	private _pendingHeaderName: string | null = null;

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

		if (data.length > 0) {
			const remaining = this._buffer.length - this._offset;
			// Rebase persisted absolute offsets by the dropped prefix. _offset and
			// _knownSectionEnd are the only positions that survive across pushes;
			// _knownSectionEnd is stale (and recomputed) while _knownSectionLenRead
			// is false, so rebasing it unconditionally is safe.
			this._knownSectionEnd -= this._offset;
			if (remaining === 0) {
				// Previous buffer fully consumed (the common case when pushes keep
				// pace with parsing): adopt the incoming buffer without copying.
				this._buffer = data;
			} else {
				// A field spans pushes: copy the unconsumed remainder + new data.
				// Dropping the consumed prefix keeps each copy proportional to the
				// remainder; carrying it forward would make chunked decode O(n^2)
				// in the number of pushes.
				const newBuf = new Uint8Array(remaining + data.length);
				newBuf.set(this._buffer.subarray(this._offset), 0);
				newBuf.set(data, remaining);
				this._buffer = newBuf;
			}
			this._offset = 0;
		}

		const events: BHttpEvent[] = [];

		// Process as much as possible
		// Note: _processPhase() mutates _phase, so we re-check each iteration
		while (this._shouldContinueProcessing()) {
			const event = this._processPhase();
			if (event === undefined) {
				break; // Need more data
			}
			if (event !== null) {
				events.push(event);
			}
		}

		return events;
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
			this._phase === "content-indeterminate" || this._phase === "trailers-indeterminate";
		const atKnownBoundary =
			(this._phase === "content-known" || this._phase === "trailers-known") &&
			!this._knownSectionLenRead;
		if (atIndeterminateBoundary || atKnownBoundary) {
			this._phase = "padding";
		}

		// Check padding
		if (this._phase === "padding") {
			while (this._offset < this._buffer.length) {
				if (this._buffer[this._offset] !== 0x00) {
					throw new InvalidMessageError("Invalid padding data");
				}
				this._offset++;
			}
			this._phase = "done";
			return [{ type: "end" }];
		}

		throw new InvalidMessageError("Incomplete message");
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

	private _processFraming(): null | undefined {
		const result = decodeVli(this._buffer, this._offset);
		if (result === undefined) return undefined;

		const framing = result.value;
		this._offset += result.bytesRead;

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
		this._headers = new Headers();
		this._phase = this._isKnownLength ? "headers-known" : "headers-indeterminate";
		return null;
	}

	private _processResponseStatus(): BHttpInformationalEvent | null | undefined {
		const saveOffset = this._offset;

		const result = decodeVli(this._buffer, this._offset);
		if (result === undefined) return undefined;

		const status = result.value;
		this._offset += result.bytesRead;

		// Check for informational response (1xx)
		if (status >= 100 && status < 200) {
			this._headers = new Headers();

			// Try to parse headers for informational response
			const complete = this._isKnownLength
				? this._tryParseKnownLengthHeaders()
				: this._tryParseIndeterminateLengthHeaders();

			if (!complete) {
				// Rollback
				this._offset = saveOffset;
				this._headers = new Headers();
				this._knownSectionLenRead = false;
				this._pendingHeaderName = null;
				return undefined;
			}

			const event: BHttpInformationalEvent = {
				type: "informational",
				status,
				headers: this._headers,
			};
			this._headers = new Headers();
			this._knownSectionLenRead = false;
			return event;
		}

		// Final status
		if (status < 100 || status >= 600) {
			throw new InvalidMessageError("Invalid status code");
		}

		this._status = status;
		this._headers = new Headers();
		this._phase = this._isKnownLength ? "headers-known" : "headers-indeterminate";

		return null;
	}

	private _processHeadersKnown():
		| BHttpRequestPreambleEvent
		| BHttpResponsePreambleEvent
		| null
		| undefined {
		const saveOffset = this._offset;
		const saveHeaders = new Headers();
		this._headers.forEach((v, k) => {
			saveHeaders.set(k, v);
		});

		const complete = this._tryParseKnownLengthHeaders();
		if (!complete) {
			this._offset = saveOffset;
			this._headers = saveHeaders;
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
		const saveOffset = this._offset;
		const saveHeaders = new Headers();
		this._headers.forEach((v, k) => {
			saveHeaders.set(k, v);
		});
		const savePendingName = this._pendingHeaderName;

		const complete = this._tryParseIndeterminateLengthHeaders();
		if (!complete) {
			this._offset = saveOffset;
			this._headers = saveHeaders;
			this._pendingHeaderName = savePendingName;
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
			const lenResult = decodeVli(this._buffer, this._offset);
			if (lenResult === undefined) return false;
			this._knownSectionLen = lenResult.value;
			this._offset += lenResult.bytesRead;
			this._knownSectionEnd = this._offset + this._knownSectionLen;
			this._knownSectionLenRead = true;
		}

		// Check if we have all header bytes
		if (this._buffer.length < this._knownSectionEnd) {
			return false;
		}

		// Parse headers until we reach the end
		while (this._offset < this._knownSectionEnd) {
			const name = this._tryDecodeVliString();
			if (name === undefined) return false;
			const value = this._tryDecodeVliString();
			if (value === undefined) return false;

			if (
				this._isRequest &&
				name.localeCompare("host", undefined, { sensitivity: "accent" }) === 0 &&
				this._authority === ""
			) {
				this._authority = value;
			}
			this._headers.set(name, value);
		}

		return true;
	}

	private _tryParseIndeterminateLengthHeaders(): boolean {
		// Headers terminated by Name Length = 0
		while (true) {
			// If we have a pending header name, try to get value
			if (this._pendingHeaderName !== null) {
				const value = this._tryDecodeVliString();
				if (value === undefined) return false;

				if (
					this._isRequest &&
					this._pendingHeaderName.localeCompare("host", undefined, { sensitivity: "accent" }) ===
						0 &&
					this._authority === ""
				) {
					this._authority = value;
				}
				this._headers.set(this._pendingHeaderName, value);
				this._pendingHeaderName = null;
				continue;
			}

			// Try to read next name length (or terminator)
			const lenResult = decodeVli(this._buffer, this._offset);
			if (lenResult === undefined) return false;

			if (lenResult.value === 0) {
				// Terminator
				this._offset += lenResult.bytesRead;
				return true;
			}

			// Read the name
			const name = this._tryDecodeVliString();
			if (name === undefined) return false;

			// Save name and try to get value on next iteration
			this._pendingHeaderName = name;
		}
	}

	private _emitPreambleEvent(): BHttpRequestPreambleEvent | BHttpResponsePreambleEvent {
		if (this._isRequest) {
			return {
				type: "request-preamble",
				method: this._method,
				scheme: this._scheme,
				authority: this._authority,
				path: this._path,
				headers: this._headers,
			};
		}
		return {
			type: "response-preamble",
			status: this._status,
			headers: this._headers,
		};
	}

	private _processContentKnown(): BHttpContentEvent | null | undefined {
		// Read the content length if not yet read
		if (!this._knownSectionLenRead) {
			const lenResult = decodeVli(this._buffer, this._offset);
			if (lenResult === undefined) return undefined;
			this._knownSectionLen = lenResult.value;
			this._offset += lenResult.bytesRead;
			this._knownSectionEnd = this._offset + this._knownSectionLen;
			this._knownSectionLenRead = true;

			if (this._knownSectionLen === 0) {
				this._phase = "trailers-known";
				this._knownSectionLenRead = false;
				return null;
			}
		}

		// Check if we have all content bytes
		if (this._buffer.length < this._knownSectionEnd) {
			return undefined;
		}

		// Emit content event (a view into the buffer, not a copy; see push())
		const data = this._buffer.subarray(this._offset, this._knownSectionEnd);
		this._offset = this._knownSectionEnd;
		this._phase = "trailers-known";
		this._knownSectionLenRead = false;

		return { type: "content", data };
	}

	private _processContentIndeterminate(): BHttpContentEvent | null | undefined {
		const lenResult = decodeVli(this._buffer, this._offset);
		if (lenResult === undefined) return undefined;

		if (lenResult.value === 0) {
			// Terminator - move to trailers
			this._offset += lenResult.bytesRead;
			this._phase = "trailers-indeterminate";
			return null;
		}

		const chunkLen = lenResult.value;
		const chunkStart = this._offset + lenResult.bytesRead;
		const chunkEnd = chunkStart + chunkLen;

		if (this._buffer.length < chunkEnd) {
			// Not enough data for full chunk
			return undefined;
		}

		this._offset = chunkEnd;
		// A view into the buffer, not a copy; see push()
		const data = this._buffer.subarray(chunkStart, chunkEnd);

		return { type: "content", data };
	}

	private _processTrailersKnown(): BHttpTrailersEvent | null | undefined {
		const saveOffset = this._offset;

		// Read the trailers length if not yet read
		if (!this._knownSectionLenRead) {
			const lenResult = decodeVli(this._buffer, this._offset);
			if (lenResult === undefined) return undefined;
			this._knownSectionLen = lenResult.value;
			this._offset += lenResult.bytesRead;
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
			return undefined;
		}

		// Parse trailers
		const trailers = new Headers();
		while (this._offset < this._knownSectionEnd) {
			const name = this._tryDecodeVliString();
			if (name === undefined) {
				this._offset = saveOffset;
				this._knownSectionLenRead = false;
				return undefined;
			}
			const value = this._tryDecodeVliString();
			if (value === undefined) {
				this._offset = saveOffset;
				this._knownSectionLenRead = false;
				return undefined;
			}
			trailers.set(name, value);
		}

		this._phase = "padding";
		this._knownSectionLenRead = false;
		return { type: "trailers", headers: trailers };
	}

	private _processTrailersIndeterminate(): BHttpTrailersEvent | null | undefined {
		const saveOffset = this._offset;
		const trailers = new Headers();
		let hasTrailers = false;

		while (true) {
			const lenResult = decodeVli(this._buffer, this._offset);
			if (lenResult === undefined) {
				this._offset = saveOffset;
				return undefined;
			}

			if (lenResult.value === 0) {
				// Terminator
				this._offset += lenResult.bytesRead;
				break;
			}

			const name = this._tryDecodeVliString();
			if (name === undefined) {
				this._offset = saveOffset;
				return undefined;
			}
			const value = this._tryDecodeVliString();
			if (value === undefined) {
				this._offset = saveOffset;
				return undefined;
			}
			trailers.set(name, value);
			hasTrailers = true;
		}

		this._phase = "padding";

		// Only emit trailers event if there are any
		if (!hasTrailers) {
			return null;
		}

		return { type: "trailers", headers: trailers };
	}

	/**
	 * Try to decode a VLI-prefixed string. Returns undefined if not enough data.
	 * Does NOT rollback offset on failure - caller must handle.
	 */
	private _tryDecodeVliString(): string | undefined {
		const lenResult = decodeVli(this._buffer, this._offset);
		if (lenResult === undefined) return undefined;

		const strLen = lenResult.value;
		const strStart = this._offset + lenResult.bytesRead;
		const strEnd = strStart + strLen;

		if (this._buffer.length < strEnd) {
			return undefined;
		}

		const str = textDecoder.decode(this._buffer.subarray(strStart, strEnd));
		this._offset = strEnd;
		return str;
	}
}
