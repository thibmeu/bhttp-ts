import { tryReadFrom, MAX as VLI_MAX } from "quicvarint";
import * as errors from "./errors";
import { BHttpStreamDecoder, type BHttpStreamDecoderOptions } from "./stream-decoder";

class InformationalResponse {
	public status: number;
	public headers: Headers;

	constructor(status: number) {
		this.status = status;
		this.headers = new Headers();
	}
}

class DecoderContext {
	public buf: Uint8Array;
	public p = 0;
	public framingIndicator = 0;
	public headers: Headers;
	public content: Uint8Array;
	public trailers: Headers;

	constructor(buf: Uint8Array) {
		this.buf = buf;
		this.headers = new Headers();
		this.content = new Uint8Array(0);
		this.trailers = new Headers();
	}
}

class RequestDecoderContext extends DecoderContext {
	public method = "";
	public scheme = "";
	public authority = "";
	public path = "";

	public createRequest(): Request {
		const input = `${this.scheme}://${this.authority}${this.path}`;
		let req: Request;

		if (this.method === "GET" || this.method === "HEAD") {
			req = new Request(input, {
				method: this.method,
			});
		} else {
			// Create a new Uint8Array copy to ensure we have a clean ArrayBuffer
			const bodyBuffer = new Uint8Array(this.content).buffer as ArrayBuffer;
			req = new Request(input, {
				method: this.method,
				body: bodyBuffer,
			});
		}
		this.headers.forEach((value, key) => {
			req.headers.set(key, value);
		});
		return req;
	}
}

class ResponseDecoderContext extends DecoderContext {
	public status = 0;
	public informationalResponses: InformationalResponse[];

	constructor(buf: Uint8Array) {
		super(buf);
		this.informationalResponses = new Array(0);
	}

	public createResponse(): Response {
		// Create a new Uint8Array copy to ensure we have a clean ArrayBuffer
		const bodyBuffer = new Uint8Array(this.content).buffer as ArrayBuffer;
		return new Response(bodyBuffer, {
			status: this.status,
			headers: this.headers,
		});
	}
}

export class BHttpDecoder {
	private _td: TextDecoder;

	constructor() {
		this._td = new TextDecoder();
	}

	public decodeRequest(src: ArrayBuffer | Uint8Array): Request {
		const bytes = src instanceof ArrayBuffer ? new Uint8Array(src) : src;
		const ctx = new RequestDecoderContext(bytes);
		ctx.framingIndicator = this.decodeVli(ctx);

		switch (ctx.framingIndicator) {
			case 0:
				return this.decodeKnownLengthRequest(ctx);
			case 2:
				return this.decodeIndeterminateLengthRequest(ctx);
			default:
				throw new errors.InvalidMessageError("Invalid framing indicator.");
		}
	}

	public decodeResponse(src: ArrayBuffer | Uint8Array): Response {
		const bytes = src instanceof ArrayBuffer ? new Uint8Array(src) : src;
		const ctx = new ResponseDecoderContext(bytes);
		ctx.framingIndicator = this.decodeVli(ctx);

		switch (ctx.framingIndicator) {
			case 1:
				return this.decodeKnownLengthResponse(ctx);
			case 3:
				return this.decodeIndeterminateLengthResponse(ctx);
			default:
				throw new errors.InvalidMessageError("Invalid framing indicator.");
		}
	}

	/** Decode a BHTTP byte stream into a Request whose body remains streaming. */
	public async decodeRequestStream(
		src: ReadableStream<Uint8Array>,
		options: BHttpStreamDecoderOptions = {},
	): Promise<Request> {
		const decoded = await decodeStream(src, "request", options);
		const bodyless =
			decoded.method.toUpperCase() === "GET" || decoded.method.toUpperCase() === "HEAD";
		if (bodyless) await decoded.body.cancel();
		return new Request(`${decoded.scheme}://${decoded.authority}${decoded.path}`, {
			method: decoded.method,
			headers: decoded.headers,
			body: bodyless ? null : decoded.body,
			duplex: "half",
		} as RequestInit & { duplex: "half" });
	}

	/** Decode a BHTTP byte stream into a Response whose body remains streaming. */
	public async decodeResponseStream(
		src: ReadableStream<Uint8Array>,
		options: BHttpStreamDecoderOptions = {},
	): Promise<Response> {
		const decoded = await decodeStream(src, "response", options);
		const bodyless = decoded.status === 204 || decoded.status === 304;
		if (bodyless) await decoded.body.cancel();
		return new Response(bodyless ? null : decoded.body, {
			status: decoded.status,
			headers: decoded.headers,
		});
	}

	private decodeKnownLengthRequest(ctx: RequestDecoderContext): Request {
		this.decodeRequestControlData(ctx);
		this.decodeKnownLengthRequestHeaders(ctx);
		this.decodeKnownLengthContent(ctx);
		this.decodeKnownLengthTrailers(ctx);
		this.checkPadding(ctx);
		return ctx.createRequest();
	}

	private decodeIndeterminateLengthRequest(ctx: RequestDecoderContext): Request {
		this.decodeRequestControlData(ctx);
		this.decodeIndeterminateLengthRequestHeaders(ctx);
		this.decodeIndeterminateLengthContent(ctx);
		this.decodeIndeterminateLengthTrailers(ctx);
		this.checkPadding(ctx);
		return ctx.createRequest();
	}

	private decodeKnownLengthResponse(ctx: ResponseDecoderContext): Response {
		this.decodeKnownLengthInformationalResponsesAndHeaders(ctx);
		this.decodeKnownLengthContent(ctx);
		this.decodeKnownLengthTrailers(ctx);
		this.checkPadding(ctx);
		return ctx.createResponse();
	}

	private decodeIndeterminateLengthResponse(ctx: ResponseDecoderContext): Response {
		this.decodeIndeterminateLengthInformationalResponsesAndHeaders(ctx);
		this.decodeIndeterminateLengthContent(ctx);
		this.decodeIndeterminateLengthTrailers(ctx);
		this.checkPadding(ctx);
		return ctx.createResponse();
	}

	private decodeRequestControlData(ctx: RequestDecoderContext) {
		ctx.method = this.decodeVliAndValue(ctx);
		ctx.scheme = this.decodeVliAndValue(ctx);
		ctx.authority = this.decodeVliAndValue(ctx);
		ctx.path = this.decodeVliAndValue(ctx);
		return;
	}

	private decodeKnownLengthInformationalResponsesAndHeaders(ctx: ResponseDecoderContext) {
		let status = this.decodeVli(ctx);
		while (status >= 100 && status < 200) {
			this.decodeKnownLengthInformationalResponse(ctx, status);
			status = this.decodeVli(ctx);
		}
		if (status < 100 && status >= 600) {
			throw new errors.InvalidMessageError("Invalid status code.");
		}
		ctx.status = status;
		this.decodeKnownLengthResponseHeaders(ctx);
		return;
	}

	private decodeIndeterminateLengthInformationalResponsesAndHeaders(ctx: ResponseDecoderContext) {
		let status = this.decodeVli(ctx);
		while (status >= 100 && status < 200) {
			this.decodeIndeterminateLengthInformationalResponse(ctx, status);
			status = this.decodeVli(ctx);
		}
		if (status < 100 && status >= 600) {
			throw new errors.InvalidMessageError("Invalid status code.");
		}
		ctx.status = status;
		this.decodeIndeterminateLengthResponseHeaders(ctx);
		return;
	}

	private decodeKnownLengthInformationalResponse(ctx: ResponseDecoderContext, status: number) {
		const ir = new InformationalResponse(status);

		const len = this.decodeVli(ctx);
		let name = "";
		let value = "";
		const base = ctx.p;
		while (ctx.p < base + len) {
			name = this.decodeVliAndValue(ctx);
			value = this.decodeVliAndValue(ctx);
			ir.headers.set(name, value);
		}
		ctx.informationalResponses.push(ir);
		return;
	}

	private decodeIndeterminateLengthInformationalResponse(
		ctx: ResponseDecoderContext,
		status: number,
	) {
		const ir = new InformationalResponse(status);

		let name = "";
		let value = "";
		let terminator = this.decodeVli(ctx);
		while (terminator !== 0) {
			ctx.p--;
			name = this.decodeVliAndValue(ctx);
			value = this.decodeVliAndValue(ctx);
			ir.headers.set(name, value);
			terminator = this.decodeVli(ctx);
		}
		ctx.informationalResponses.push(ir);
		return;
	}

	private decodeKnownLengthRequestHeaders(ctx: RequestDecoderContext) {
		let name = "";
		let value = "";
		const len = this.decodeVli(ctx);
		const base = ctx.p;
		while (ctx.p < base + len) {
			name = this.decodeVliAndValue(ctx);
			value = this.decodeVliAndValue(ctx);
			if (
				name.localeCompare("host", undefined, { sensitivity: "accent" }) === 0 &&
				ctx.authority === ""
			) {
				ctx.authority = value;
			}
			ctx.headers.set(name, value);
		}
		return;
	}

	private decodeKnownLengthResponseHeaders(ctx: ResponseDecoderContext) {
		let name = "";
		let value = "";
		const base = ctx.p;
		const len = this.decodeVli(ctx);
		while (ctx.p < base + len) {
			name = this.decodeVliAndValue(ctx);
			value = this.decodeVliAndValue(ctx);
			ctx.headers.set(name, value);
		}
		return;
	}

	private decodeIndeterminateLengthRequestHeaders(ctx: RequestDecoderContext) {
		let name = "";
		let value = "";
		let terminator = this.decodeVli(ctx);
		while (terminator !== 0) {
			ctx.p--;
			name = this.decodeVliAndValue(ctx);
			value = this.decodeVliAndValue(ctx);
			if (
				name.localeCompare("host", undefined, { sensitivity: "accent" }) === 0 &&
				ctx.authority === ""
			) {
				ctx.authority = value;
			}
			ctx.headers.set(name, value);
			terminator = this.decodeVli(ctx);
		}
		return;
	}

	private decodeIndeterminateLengthResponseHeaders(ctx: ResponseDecoderContext) {
		let name = "";
		let value = "";
		let terminator = this.decodeVli(ctx);
		while (terminator !== 0) {
			ctx.p--;
			name = this.decodeVliAndValue(ctx);
			value = this.decodeVliAndValue(ctx);
			ctx.headers.set(name, value);
			terminator = this.decodeVli(ctx);
		}
		return;
	}

	private decodeKnownLengthContent(ctx: DecoderContext) {
		if (this.isAtEnd(ctx)) {
			return;
		}
		const len = this.decodeVli(ctx);
		// View into the input buffer; createRequest/createResponse copies it once
		// into an owned buffer, so an extra copy here would be redundant.
		ctx.content = ctx.buf.subarray(ctx.p, ctx.p + len);
		ctx.p += len;
		return;
	}

	private decodeIndeterminateLengthContent(ctx: DecoderContext) {
		if (this.isAtEnd(ctx)) {
			return;
		}
		let len = 0;
		const p = ctx.p;
		let terminator = this.decodeVli(ctx);
		while (terminator !== 0) {
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

	private decodeKnownLengthTrailers(ctx: DecoderContext) {
		if (this.isAtEnd(ctx)) {
			return;
		}
		const len = this.decodeVli(ctx);
		let name = "";
		let value = "";
		const base = ctx.p;
		while (ctx.p < base + len) {
			name = this.decodeVliAndValue(ctx);
			value = this.decodeVliAndValue(ctx);
			ctx.trailers.set(name, value);
		}
		return;
	}

	private decodeIndeterminateLengthTrailers(ctx: DecoderContext) {
		if (this.isAtEnd(ctx)) {
			return;
		}
		let name = "";
		let value = "";
		let terminator = this.decodeVli(ctx);
		while (terminator !== 0) {
			ctx.p--;
			name = this.decodeVliAndValue(ctx);
			value = this.decodeVliAndValue(ctx);
			ctx.trailers.set(name, value);
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
		return ctx.p >= ctx.buf.byteLength;
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

	private decodeVliAndValue(ctx: DecoderContext): string {
		const len = this.decodeVli(ctx);
		// TextDecoder does not retain the input, so a view is safe and avoids a
		// copy on every header/control/trailer field.
		const res = this._td.decode(ctx.buf.subarray(ctx.p, ctx.p + len));
		ctx.p += len;
		return res;
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
