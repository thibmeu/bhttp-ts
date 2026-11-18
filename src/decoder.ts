import { tryReadFrom, MAX as VLI_MAX } from "quicvarint";
import * as errors from "./errors";
import {
	BHttpStreamDecoder,
	type BHttpStreamDecoderOptions,
	decodeByteString,
	FieldSection,
	metadataSizeLimit,
} from "./stream-decoder";

const EMPTY_CONTENT = new Uint8Array(0);

function isBodylessRequest(method: string): boolean {
	const upper = method.toUpperCase();
	return upper === "GET" || upper === "HEAD";
}

function requestUrl(scheme: string, authority: string, path: string, headers: Headers): string {
	if (!/^https?$/i.test(scheme)) {
		throw new errors.InvalidMessageError("Request scheme must be http or https");
	}
	if (!path.startsWith("/")) {
		throw new errors.InvalidMessageError("Invalid path");
	}

	const host = headers.get("host");
	authority ||= host ?? "";
	const origin = requestOrigin(scheme, authority);
	if (
		host !== null &&
		host !== authority &&
		new URL(requestOrigin(scheme, host)).host !== new URL(origin).host
	) {
		throw new errors.InvalidMessageError("Host header does not match request authority");
	}
	return origin + path;
}

function requestOrigin(scheme: string, authority: string): string {
	if (authority === "" || /[/\\?#@,\s]/.test(authority)) {
		throw new errors.InvalidMessageError("Invalid authority");
	}
	return `${scheme}://${authority}`;
}

function createRequest(
	{ scheme, authority, path, method, headers }: RequestStreamPreamble,
	body: BodyInit | null,
): Request {
	try {
		return new Request(requestUrl(scheme, authority, path, headers), {
			method,
			headers,
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" });
	} catch (cause) {
		if (!(cause instanceof TypeError)) throw cause;
		throw new errors.InvalidMessageError("Invalid HTTP request", { cause });
	}
}

class DecoderContext {
	public p = 0;
	public framingIndicator = 0;
	public content: Uint8Array = EMPTY_CONTENT;

	constructor(
		public buf: Uint8Array,
		public metadataRemaining: number,
	) {}

	public chargeMetadata(size: number): void {
		this.metadataRemaining -= size;
		if (this.metadataRemaining < 0) {
			throw new errors.MetadataLimitExceededError("BHTTP metadata exceeds the configured limit");
		}
	}
}

function copyContent(content: Uint8Array): ArrayBuffer {
	return content.length === 0 ? EMPTY_CONTENT.buffer : new Uint8Array(content).buffer;
}

export class BHttpDecoder {
	private readonly _td = new TextDecoder();
	private readonly _maxMetadataSize: number;

	constructor(options: BHttpStreamDecoderOptions = {}) {
		this._maxMetadataSize = metadataSizeLimit(options);
	}

	public decodeRequest(src: ArrayBuffer | Uint8Array): Request {
		const bytes = src instanceof ArrayBuffer ? new Uint8Array(src) : src;
		const ctx = new DecoderContext(bytes, this._maxMetadataSize);
		ctx.framingIndicator = this.decodeVli(ctx);
		ctx.chargeMetadata(ctx.p);

		switch (ctx.framingIndicator) {
			case 0:
				return this.decodeRequestMessage(ctx, true);
			case 2:
				return this.decodeRequestMessage(ctx, false);
			default:
				throw new errors.InvalidMessageError("Invalid framing indicator.");
		}
	}

	public decodeResponse(src: ArrayBuffer | Uint8Array): Response {
		const bytes = src instanceof ArrayBuffer ? new Uint8Array(src) : src;
		const ctx = new DecoderContext(bytes, this._maxMetadataSize);
		ctx.framingIndicator = this.decodeVli(ctx);
		ctx.chargeMetadata(ctx.p);

		switch (ctx.framingIndicator) {
			case 1:
				return this.decodeResponseMessage(ctx, true);
			case 3:
				return this.decodeResponseMessage(ctx, false);
			default:
				throw new errors.InvalidMessageError("Invalid framing indicator.");
		}
	}

	/** Decode a BHTTP byte stream into a Request whose body remains streaming. */
	public async decodeRequestStream(
		src: ReadableStream<Uint8Array>,
		options: BHttpStreamDecoderOptions = { maxMetadataSize: this._maxMetadataSize },
	): Promise<Request> {
		const decoded = await decodeStream(src, "request", options);
		const bodyless = isBodylessRequest(decoded.method);
		try {
			const request = createRequest(decoded, bodyless ? null : decoded.body);
			if (bodyless) {
				const reader = decoded.body.getReader();
				try {
					if (!(await reader.read()).done) {
						throw new errors.InvalidMessageError("GET and HEAD requests cannot have content");
					}
				} finally {
					reader.releaseLock();
				}
			}
			return request;
		} catch (error) {
			await cancelQuietly(decoded.body, error);
			throw error;
		}
	}

	/** Decode a BHTTP byte stream into a Response whose body remains streaming. */
	public async decodeResponseStream(
		src: ReadableStream<Uint8Array>,
		options: BHttpStreamDecoderOptions = { maxMetadataSize: this._maxMetadataSize },
	): Promise<Response> {
		const decoded = await decodeStream(src, "response", options);
		const bodyless = decoded.status === 204 || decoded.status === 205 || decoded.status === 304;
		if (bodyless) await decoded.body.pipeTo(new WritableStream());
		try {
			return new Response(bodyless ? null : decoded.body, {
				status: decoded.status,
				headers: decoded.headers,
			});
		} catch (error) {
			await cancelQuietly(decoded.body, error);
			throw error;
		}
	}

	private decodeRequestMessage(ctx: DecoderContext, knownLength: boolean): Request {
		const method = this.decodeVliAndValue(ctx);
		const scheme = this.decodeVliAndValue(ctx);
		const authority = this.decodeVliAndValue(ctx);
		const path = this.decodeVliAndValue(ctx);
		const headers = this.decodeFields(ctx, knownLength);
		const bodyless = isBodylessRequest(method);
		this.decodePayload(ctx, knownLength, bodyless);
		return createRequest(
			{ method, scheme, authority, path, headers },
			bodyless ? null : copyContent(ctx.content),
		);
	}

	private decodeResponseMessage(ctx: DecoderContext, knownLength: boolean): Response {
		for (;;) {
			const start = ctx.p;
			const status = this.decodeVli(ctx);
			ctx.chargeMetadata(ctx.p - start);
			if (status < 100 || status >= 600) {
				throw new errors.InvalidMessageError("Invalid status code.");
			}
			const headers = this.decodeFields(ctx, knownLength);
			if (status < 200) continue;

			this.decodePayload(ctx, knownLength);
			const bodyless = status === 204 || status === 205 || status === 304;
			return new Response(bodyless ? null : copyContent(ctx.content), { status, headers });
		}
	}

	private decodePayload(ctx: DecoderContext, knownLength: boolean, bodyless = false): void {
		if (knownLength) this.decodeKnownLengthContent(ctx, bodyless);
		else this.decodeIndeterminateLengthContent(ctx, bodyless);
		if (!this.isAtEnd(ctx)) this.decodeFields(ctx, knownLength);
		this.checkPadding(ctx);
	}

	private decodeFields(ctx: DecoderContext, knownLength: boolean): Headers {
		const fields = new FieldSection();
		if (knownLength) {
			const start = ctx.p;
			const len = this.decodeVli(ctx);
			const end = ctx.p + len;
			ctx.chargeMetadata(end - start);
			const buf = ctx.buf;
			if (end > buf.length) {
				throw new errors.InvalidMessageError("Unexpected end of buffer");
			}
			ctx.buf = buf.subarray(0, end);
			while (ctx.p < end) {
				fields.append(
					this.decodeVliAndValue(ctx, true, false),
					this.decodeVliAndValue(ctx, true, false),
				);
			}
			ctx.buf = buf;
		} else {
			for (;;) {
				const name = this.decodeVliAndValue(ctx, true);
				if (name === "") break;
				fields.append(name, this.decodeVliAndValue(ctx, true));
			}
		}
		return fields.finish();
	}

	private decodeKnownLengthContent(ctx: DecoderContext, bodyless: boolean) {
		if (this.isAtEnd(ctx)) {
			return;
		}
		const len = this.decodeVli(ctx);
		if (bodyless && len !== 0) {
			throw new errors.InvalidMessageError("GET and HEAD requests cannot have content");
		}
		if (len > ctx.buf.length - ctx.p) {
			throw new errors.InvalidMessageError("Unexpected end of buffer");
		}
		// View into the input buffer; createRequest/createResponse copies it once
		// into an owned buffer, so an extra copy here would be redundant.
		ctx.content = ctx.buf.subarray(ctx.p, ctx.p + len);
		ctx.p += len;
		return;
	}

	private decodeIndeterminateLengthContent(ctx: DecoderContext, bodyless: boolean) {
		if (this.isAtEnd(ctx)) {
			return;
		}
		let len = 0;
		const p = ctx.p;
		let terminator = this.decodeVli(ctx);
		if (bodyless && terminator !== 0) {
			throw new errors.InvalidMessageError("GET and HEAD requests cannot have content");
		}
		while (terminator !== 0) {
			if (terminator > ctx.buf.length - ctx.p) {
				throw new errors.InvalidMessageError("Unexpected end of buffer");
			}
			len += terminator;
			ctx.p += terminator;
			terminator = this.decodeVli(ctx);
		}
		if (len === 0) {
			return;
		}
		ctx.p = p;
		ctx.content = new Uint8Array(len);
		len = 0;
		terminator = this.decodeVli(ctx);
		while (terminator !== 0) {
			ctx.content.set(ctx.buf.subarray(ctx.p, ctx.p + terminator), len);
			len += terminator;
			ctx.p += terminator;
			terminator = this.decodeVli(ctx);
		}
		return;
	}

	// RFC 9292 Section 3.8 lets the encoder drop an empty trailer section, plus an
	// empty content section when the trailers are dropped too. A decoder reads
	// those missing fields as a length of zero. Only the trailing sections can go;
	// a message cut off anywhere earlier (mid control data or headers) is invalid,
	// so only the content and trailer decoders check isAtEnd().
	private isAtEnd(ctx: DecoderContext): boolean {
		return ctx.p === ctx.buf.byteLength;
	}

	private checkPadding(ctx: DecoderContext) {
		while (ctx.p < ctx.buf.byteLength) {
			const byte = ctx.buf[ctx.p++];
			if (byte !== 0x00) {
				throw new errors.InvalidMessageError("Invalid padding data.");
			}
		}
		return;
	}

	private decodeVliAndValue(
		ctx: DecoderContext,
		byteString = false,
		chargeMetadata = true,
	): string {
		const start = ctx.p;
		const len = this.decodeVli(ctx);
		const end = ctx.p + len;
		if (chargeMetadata) ctx.chargeMetadata(end - start);
		if (end > ctx.buf.length) {
			throw new errors.InvalidMessageError("Unexpected end of buffer");
		}
		// A view avoids a field copy.
		const bytes = ctx.buf.subarray(ctx.p, end);
		ctx.p = end;
		return byteString ? decodeByteString(bytes) : this._td.decode(bytes);
	}

	private decodeVli(ctx: DecoderContext): number {
		// tryReadFrom separates the two failures: undefined for a VLI the buffer
		// cuts short, throw for one whose value this package cannot represent.
		let value: number | undefined;
		try {
			value = tryReadFrom(ctx);
		} catch (e) {
			throw new errors.NotSupportedError(`Over ${VLI_MAX}-length value is not supported.`, {
				cause: e,
			});
		}
		if (value === undefined) {
			throw new errors.InvalidMessageError("Unexpected end of buffer");
		}
		return value;
	}
}

interface DecodedRequestStream {
	readonly method: string;
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	readonly headers: Headers;
	readonly body: ReadableStream<Uint8Array>;
}

interface DecodedResponseStream {
	readonly status: number;
	readonly headers: Headers;
	readonly body: ReadableStream<Uint8Array>;
}

type RequestStreamPreamble = Omit<DecodedRequestStream, "body">;
type ResponseStreamPreamble = Omit<DecodedResponseStream, "body">;

async function cancelQuietly(body: ReadableStream<Uint8Array>, reason?: unknown): Promise<void> {
	try {
		await body.cancel(reason);
	} catch {}
}

function decodeStream(
	src: ReadableStream<Uint8Array>,
	kind: "request",
	options: BHttpStreamDecoderOptions,
): Promise<DecodedRequestStream>;
function decodeStream(
	src: ReadableStream<Uint8Array>,
	kind: "response",
	options: BHttpStreamDecoderOptions,
): Promise<DecodedResponseStream>;
async function decodeStream(
	src: ReadableStream<Uint8Array>,
	kind: "request" | "response",
	options: BHttpStreamDecoderOptions,
): Promise<DecodedRequestStream | DecodedResponseStream> {
	const decoder = new BHttpStreamDecoder(options);
	const reader = src.getReader();
	let preamble: RequestStreamPreamble | ResponseStreamPreamble | undefined;
	const pending: Uint8Array[] = [];
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		reader.releaseLock();
	};

	try {
		while (preamble === undefined) {
			const { done, value } = await reader.read();
			if (done) throw new errors.InvalidMessageError("Missing BHTTP preamble");
			for (const event of decoder.push(value)) {
				if (event.type === "content") pending.push(event.data);
				else if (event.type === "request-preamble" && kind === "request") {
					preamble = {
						method: event.method,
						scheme: event.scheme,
						authority: event.authority,
						path: event.path,
						headers: event.headers,
					};
				} else if (event.type === "response-preamble" && kind === "response") {
					preamble = { status: event.status, headers: event.headers };
				} else if (event.type === "request-preamble" || event.type === "response-preamble") {
					throw new errors.InvalidMessageError(`Expected a BHTTP ${kind}`);
				}
			}
		}
	} catch (error) {
		try {
			await reader.cancel(error);
		} catch {}
		release();
		throw error;
	}

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of pending) controller.enqueue(chunk);
		},
		async pull(controller) {
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) {
						decoder.end();
						release();
						controller.close();
						return;
					}
					let emitted = false;
					for (const event of decoder.push(value)) {
						if (event.type === "content") {
							controller.enqueue(event.data);
							emitted = true;
						}
					}
					if (emitted) return;
				}
			} catch (error) {
				try {
					await reader.cancel(error);
				} catch {}
				release();
				throw error;
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				release();
			}
		},
	});

	return { ...preamble, body } as DecodedRequestStream | DecodedResponseStream;
}
