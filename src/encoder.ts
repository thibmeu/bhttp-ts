import { MAX as VLI_MAX, MIN as VLI_MIN, length as vliLength, writeTo } from "quicvarint";
import * as errors from "./errors";
import { BHttpRequestStreamEncoder, BHttpResponseStreamEncoder } from "./stream-encoder";

// Request control data uses UTF-8. Header fields use opaque ByteString octets.
const te = new TextEncoder();

function encodeByteString(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length);
	for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i);
	return bytes;
}

class EncoderContext {
	public buf: Uint8Array;
	public p = 0;
	public framingIndicator = 0;
	public headerSize: number;
	public body: Uint8Array[];
	public bodySize = 0;
	// Header name/value pairs, pre-encoded as opaque octets.
	public headerPairs: Array<[Uint8Array, Uint8Array]> = [];

	constructor() {
		this.buf = new Uint8Array(0);
		this.headerSize = 0;
		this.body = [];
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

	// Header field values are opaque octets represented by Fetch ByteStrings.
	protected encodeHeaders(headers: Headers) {
		this.headerPairs = [];
		this.headerSize = 0;
		headers.forEach((value, key) => {
			const k = encodeByteString(key);
			const v = encodeByteString(value);
			this.headerPairs.push([k, v]);
			this.headerSize += this.fieldSize(k) + this.fieldSize(v);
		});
	}

	protected async readBody(
		body: ReadableStream<Uint8Array> | null | undefined,
		arrayBuffer: () => Promise<ArrayBuffer>,
		encodedSize: (bodySize: number) => number,
		maxMessageSize: number,
	) {
		const emptySize = encodedSize(0);
		if (emptySize > maxMessageSize) {
			const error = messageLimitExceeded(emptySize, maxMessageSize);
			try {
				await body?.cancel(error);
			} catch {}
			throw error;
		}
		if (body == null) {
			const value = new Uint8Array(await arrayBuffer());
			this.body = value.byteLength === 0 ? [] : [value];
			this.bodySize = value.byteLength;
			const messageSize = encodedSize(this.bodySize);
			if (messageSize > maxMessageSize) {
				throw messageLimitExceeded(messageSize, maxMessageSize);
			}
			return;
		}

		const reader = body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				this.bodySize += value.byteLength;
				const messageSize = encodedSize(this.bodySize);
				if (messageSize > maxMessageSize) {
					const error = messageLimitExceeded(messageSize, maxMessageSize);
					try {
						await reader.cancel(error);
					} catch {}
					throw error;
				}
				if (value.byteLength > 0) this.body.push(value);
			}
		} finally {
			reader.releaseLock();
		}
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

	public async setup(maxMessageSize: number, padding: number) {
		// Request control data is UTF-8; header fields are opaque octets.
		this.method = te.encode(this.request.method);
		this.scheme = te.encode(this.url.protocol.slice(0, this.url.protocol.length - 1));
		this.authority = te.encode(this.url.host);
		this.path = te.encode(this.url.pathname + this.url.search);
		this.encodeHeaders(this.request.headers);
		await this.readBody(
			this.request.body,
			() => this.request.arrayBuffer(),
			(bodySize) => paddedSize(this.calculateEncodedRequestSize(bodySize), padding),
			maxMessageSize,
		);
		// Setup the output buffer.
		this.buf = new Uint8Array(paddedSize(this.calculateEncodedRequestSize(this.bodySize), padding));
	}

	private calculateEncodedRequestSize(bodySize: number): number {
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
		len += this.calculateVliSize(bodySize);
		len += bodySize;

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

	public async setup(maxMessageSize: number, padding: number) {
		// Pre-encode header fields as opaque octets.
		this.encodeHeaders(this.response.headers);
		await this.readBody(
			this.response.body,
			() => this.response.arrayBuffer(),
			(bodySize) => paddedSize(this.calculateEncodedResponseSize(bodySize), padding),
			maxMessageSize,
		);
		// Setup the output buffer.
		this.buf = new Uint8Array(
			paddedSize(this.calculateEncodedResponseSize(this.bodySize), padding),
		);
	}

	private calculateEncodedResponseSize(bodySize: number): number {
		let len = 1; // framing indicator

		// Response Control Data
		len += 2;

		// Known Length Headers
		len += this.calculateVliSize(this.headerSize);
		len += this.headerSize;

		// Known Length Content
		len += this.calculateVliSize(bodySize);
		len += bodySize;

		// Known Length Trailers
		len += 1; // The trailer size = 0;

		// No padding
		return len;
	}
}

export class BHttpEncoder {
	public async encodeRequest(src: Request, options: BHttpEncoderOptions = {}): Promise<Uint8Array> {
		// Setup RequestEncoderContext.
		const ctx = new RequestEncoderContext(src);
		await ctx.setup(resolveMaxMessageSize(options.maxMessageSize), resolvePadding(options.padding));

		// Do BHTTP encoding.
		return this.encodeKnownLengthRequest(ctx);
	}

	public async encodeResponse(
		src: Response,
		options: BHttpEncoderOptions = {},
	): Promise<Uint8Array> {
		if (!Number.isInteger(src.status) || src.status < 200 || src.status >= 600) {
			throw new Error("Final status must be 200-599");
		}
		// Setup ResponseEncoderContext.
		const ctx = new ResponseEncoderContext(src);
		await ctx.setup(resolveMaxMessageSize(options.maxMessageSize), resolvePadding(options.padding));

		// Do BHTTP encoding.
		return this.encodeKnownLengthResponse(ctx);
	}

	/** Encode a Request as an indeterminate-length, backpressure-aware BHTTP stream. */
	public encodeRequestStream(
		src: Request,
		options: BHttpEncoderOptions = {},
	): ReadableStream<Uint8Array> {
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
			options,
		);
	}

	/** Encode a Response as an indeterminate-length, backpressure-aware BHTTP stream. */
	public encodeResponseStream(
		src: Response,
		options: BHttpEncoderOptions = {},
	): ReadableStream<Uint8Array> {
		const encoder = new BHttpResponseStreamEncoder();
		return this.encodeStream(
			encoder.encodePreamble(src.status, src.headers),
			src.body,
			encoder,
			options,
		);
	}

	private encodeStream(
		preamble: Uint8Array,
		body: ReadableStream<Uint8Array> | null,
		encoder: {
			encodeContentChunkParts(chunk: Uint8Array): [Uint8Array, Uint8Array];
			encodeEnd(): Uint8Array;
		},
		options: BHttpEncoderOptions,
	): ReadableStream<Uint8Array> {
		const padding = resolvePadding(options.padding);
		const maxMessageSize = resolveMaxMessageSize(options.maxMessageSize);
		let size = preamble.length;
		let remaining = 0;
		let ended = false;
		const checkSize = () => {
			const padded = paddedSize(size, padding);
			if (padded > maxMessageSize) throw messageLimitExceeded(padded, maxMessageSize);
		};
		const reader = body?.getReader();
		let released = false;
		const release = () => {
			if (released || reader === undefined) return;
			released = true;
			reader.releaseLock();
		};

		const fail = async (error: unknown): Promise<never> => {
			try {
				if (!released) await reader?.cancel(error);
			} catch {}
			release();
			throw error;
		};

		return new ReadableStream<Uint8Array>({
			start(controller) {
				try {
					checkSize();
					controller.enqueue(preamble);
				} catch (error) {
					return fail(error);
				}
			},
			async pull(controller) {
				try {
					if (ended) {
						// Bound padding allocation and emit only on readable demand.
						const length = Math.min(remaining, 16_384);
						controller.enqueue(new Uint8Array(length));
						remaining -= length;
						if (remaining === 0) controller.close();
						return;
					}
					if (reader !== undefined) {
						const { done, value } = await reader.read();
						if (!done) {
							if (value.length > 0) {
								const [prefix, data] = encoder.encodeContentChunkParts(value);
								size += prefix.length + data.length;
								checkSize();
								controller.enqueue(prefix);
								controller.enqueue(data);
							}
							return;
						}
					}
					const end = encoder.encodeEnd();
					size += end.length;
					checkSize();
					release();
					controller.enqueue(end);
					remaining = paddedSize(size, padding) - size;
					ended = true;
					if (remaining === 0) controller.close();
				} catch (error) {
					return fail(error);
				}
			},
			async cancel(reason) {
				try {
					if (!released) await reader?.cancel(reason);
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
		this.encodeVli(ctx, ctx.bodySize);
		for (const chunk of ctx.body) {
			ctx.buf.set(chunk, ctx.p);
			ctx.p += chunk.byteLength;
		}

		// Known Length Trailers
		this.encodeVli(ctx, 0);

		// The remaining bytes are zero padding.
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
		this.encodeVli(ctx, ctx.bodySize);
		for (const chunk of ctx.body) {
			ctx.buf.set(chunk, ctx.p);
			ctx.p += chunk.byteLength;
		}

		// Known Length Trailers
		this.encodeVli(ctx, 0);

		// The remaining bytes are zero padding.
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

export interface BHttpEncoderOptions {
	/** Maximum encoded bytes, including padding. */
	readonly maxMessageSize?: number;
	/** Pad the complete message to a multiple of this many bytes. 0 disables padding. @default 0 */
	readonly padding?: number;
}

function resolveMaxMessageSize(value = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`maxMessageSize must be a non-negative integer, got ${value}`);
	}
	return value;
}

function messageLimitExceeded(size: number, limit: number): errors.MessageLimitExceededError {
	return new errors.MessageLimitExceededError(
		`BHTTP message size ${size} exceeds maxMessageSize ${limit}`,
	);
}

function resolvePadding(value = 0): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`padding must be a non-negative safe integer, got ${value}`);
	}
	return value;
}

function paddedSize(size: number, padding: number): number {
	return padding === 0 ? size : size + ((padding - (size % padding)) % padding);
}
