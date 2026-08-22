import { MAX as VLI_MAX, MIN as VLI_MIN, length as vliLength, writeTo } from "quicvarint";
import * as errors from "./errors";
import { BHttpRequestStreamEncoder, BHttpResponseStreamEncoder } from "./stream-encoder";

// Shared UTF-8 encoder. Strings are encoded to bytes once during setup() so
// that lengths and offsets are computed in UTF-8 bytes (not UTF-16 code units),
// which is what RFC 9292 requires for the VLI length prefixes.
const te = new TextEncoder();

class EncoderContext {
	public buf: Uint8Array;
	public p = 0;
	public framingIndicator = 0;
	public headerSize: number;
	public body: Uint8Array;
	// Header name/value pairs, pre-encoded to UTF-8 bytes.
	public headerPairs: Array<[Uint8Array, Uint8Array]> = [];

	constructor() {
		this.buf = new Uint8Array(0);
		this.headerSize = 0;
		this.body = new Uint8Array(0);
	}

	protected calculateVliSize(v: number): number {
		try {
			return vliLength(v);
		} catch (e) {
			throw new errors.NotSupportedError(`Over ${VLI_MAX}-length value is not supported.`, {
				cause: e,
			});
		}
	}

	// Bytes needed to encode a VLI-prefixed byte string.
	protected fieldSize(bytes: Uint8Array): number {
		return this.calculateVliSize(bytes.length) + bytes.length;
	}

	// Encode the header pairs to UTF-8 and record headerSize (in bytes).
	protected encodeHeaders(headers: Headers) {
		this.headerPairs = [];
		this.headerSize = 0;
		headers.forEach((value, key) => {
			const k = te.encode(key);
			const v = te.encode(value);
			this.headerPairs.push([k, v]);
			this.headerSize += this.fieldSize(k) + this.fieldSize(v);
		});
	}
}

class RequestEncoderContext extends EncoderContext {
	public request: Request;
	public url: URL;
	public method: Uint8Array = new Uint8Array(0);
	public scheme: Uint8Array = new Uint8Array(0);
	public authority: Uint8Array = new Uint8Array(0);
	public path: Uint8Array = new Uint8Array(0);

	constructor(request: Request) {
		super();
		this.request = request;
		this.url = new URL(request.url);
	}

	public async setup() {
		// Load requestBody.
		this.body = new Uint8Array(await this.request.arrayBuffer());
		// Pre-encode control data and headers to UTF-8.
		this.method = te.encode(this.request.method);
		this.scheme = te.encode(this.url.protocol.slice(0, this.url.protocol.length - 1));
		this.authority = te.encode(this.url.host);
		this.path = te.encode(this.url.pathname + this.url.search);
		this.encodeHeaders(this.request.headers);
		// Setup the output buffer.
		this.buf = new Uint8Array(this.calculateEncodedRequestSize());
	}

	private calculateEncodedRequestSize(): number {
		let len = 1; // framing indicator

		// Request Control Data
		len += this.fieldSize(this.method);
		len += this.fieldSize(this.scheme);
		len += this.fieldSize(this.authority);
		len += this.fieldSize(this.path);

		// Known Length Headers
		len += this.calculateVliSize(this.headerSize);
		len += this.headerSize;

		// Known Length Content
		len += this.calculateVliSize(this.body.byteLength);
		len += this.body.byteLength;

		// Known Length Trailers
		len += 1; // The trailer size = 0;

		// No padding
		return len;
	}
}

class ResponseEncoderContext extends EncoderContext {
	public response: Response;

	constructor(response: Response) {
		super();
		this.response = response;
	}

	public async setup() {
		// Load responseBody.
		this.body = new Uint8Array(await this.response.arrayBuffer());
		// Pre-encode headers to UTF-8.
		this.encodeHeaders(this.response.headers);
		// Setup the output buffer.
		this.buf = new Uint8Array(this.calculateEncodedResponseSize());
	}

	private calculateEncodedResponseSize(): number {
		let len = 1; // framing indicator

		// Response Control Data
		len += 2;

		// Known Length Headers
		len += this.calculateVliSize(this.headerSize);
		len += this.headerSize;

		// Known Length Content
		len += this.calculateVliSize(this.body.byteLength);
		len += this.body.byteLength;

		// Known Length Trailers
		len += 1; // The trailer size = 0;

		// No padding
		return len;
	}
}

export class BHttpEncoder {
	public async encodeRequest(src: Request): Promise<Uint8Array> {
		// Setup RequestEncoderContext.
		const ctx = new RequestEncoderContext(src);
		await ctx.setup();

		// Do BHTTP encoding.
		return this.encodeKnownLengthRequest(ctx);
	}

	public async encodeResponse(src: Response): Promise<Uint8Array> {
		// Setup ResponseEncoderContext.
		const ctx = new ResponseEncoderContext(src);
		await ctx.setup();

		// Do BHTTP encoding.
		return this.encodeKnownLengthResponse(ctx);
	}

	/** Encode a Request as an indeterminate-length, backpressure-aware BHTTP stream. */
	public encodeRequestStream(src: Request): ReadableStream<Uint8Array> {
		const url = new URL(src.url);
		const encoder = new BHttpRequestStreamEncoder();
		return this.encodeStream(
			encoder.encodePreamble(
				src.method,
				url.protocol.slice(0, -1),
				url.host,
				url.pathname + url.search,
				src.headers,
			),
			src.body,
			encoder,
		);
	}

	/** Encode a Response as an indeterminate-length, backpressure-aware BHTTP stream. */
	public encodeResponseStream(src: Response): ReadableStream<Uint8Array> {
		const encoder = new BHttpResponseStreamEncoder();
		return this.encodeStream(encoder.encodePreamble(src.status, src.headers), src.body, encoder);
	}

	private encodeStream(
		preamble: Uint8Array,
		body: ReadableStream<Uint8Array> | null,
		encoder: {
			encodeContentChunkParts(chunk: Uint8Array): [Uint8Array, Uint8Array];
			encodeEnd(): Uint8Array;
		},
	): ReadableStream<Uint8Array> {
		const reader = body?.getReader();
		let released = false;
		const release = () => {
			if (released || reader === undefined) return;
			released = true;
			reader.releaseLock();
		};

		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(preamble);
			},
			async pull(controller) {
				try {
					if (reader !== undefined) {
						const { done, value } = await reader.read();
						if (!done) {
							if (value.length > 0) {
								const [prefix, data] = encoder.encodeContentChunkParts(value);
								controller.enqueue(prefix);
								controller.enqueue(data);
							}
							return;
						}
					}
					release();
					controller.enqueue(encoder.encodeEnd());
					controller.close();
				} catch (error) {
					try {
						await reader?.cancel(error);
					} catch {}
					release();
					throw error;
				}
			},
			async cancel(reason) {
				try {
					await reader?.cancel(reason);
				} finally {
					release();
				}
			},
		});
	}

	private encodeKnownLengthRequest(ctx: RequestEncoderContext): Uint8Array {
		this.encodeVli(ctx, 0);

		// Request Control Data
		this.encodeVliAndValue(ctx, ctx.method);
		this.encodeVliAndValue(ctx, ctx.scheme);
		this.encodeVliAndValue(ctx, ctx.authority);
		this.encodeVliAndValue(ctx, ctx.path);

		// Known Length Headers
		this.encodeVli(ctx, ctx.headerSize);
		for (const [key, value] of ctx.headerPairs) {
			this.encodeVliAndValue(ctx, key);
			this.encodeVliAndValue(ctx, value);
		}

		// Known Length Content
		this.encodeVli(ctx, ctx.body.byteLength);
		ctx.buf.set(ctx.body, ctx.p);
		ctx.p += ctx.body.byteLength;

		// Known Length Trailers
		this.encodeVli(ctx, 0);

		// No padding
		return ctx.buf;
	}

	private encodeKnownLengthResponse(ctx: ResponseEncoderContext): Uint8Array {
		this.encodeVli(ctx, 1);

		// Response Control Data
		this.encodeVli(ctx, ctx.response.status);

		// Known Length Headers
		this.encodeVli(ctx, ctx.headerSize);
		for (const [key, value] of ctx.headerPairs) {
			this.encodeVliAndValue(ctx, key);
			this.encodeVliAndValue(ctx, value);
		}

		// Known Length Content
		this.encodeVli(ctx, ctx.body.byteLength);
		ctx.buf.set(ctx.body, ctx.p);
		ctx.p += ctx.body.byteLength;

		// Known Length Trailers
		this.encodeVli(ctx, 0);

		// No padding
		return ctx.buf;
	}

	private encodeVliAndValue(ctx: EncoderContext, bytes: Uint8Array) {
		this.encodeVli(ctx, bytes.length);
		ctx.buf.set(bytes, ctx.p);
		ctx.p += bytes.length;
		return;
	}

	private encodeVli(ctx: EncoderContext, v: number) {
		// Range-check here rather than catching, so a writeTo overflow -- which
		// means this encoder mis-sized its own buffer -- is not relabelled as
		// unsupported input.
		if (v < VLI_MIN || v > VLI_MAX) {
			throw new errors.NotSupportedError(`Over ${VLI_MAX}-length value is not supported.`);
		}
		writeTo(ctx, v);
	}
}
