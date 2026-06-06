import * as consts from "./consts";
import * as errors from "./errors";

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
		if (v < 64) {
			return 1;
		}
		if (v < 16384) {
			return 2;
		}
		if (v < 1073741824) {
			return 4;
		}
		if (v <= Number.MAX_SAFE_INTEGER) {
			return 8;
		}
		throw new errors.NotSupportedError("Over MAX_SAFE_INTEGER length value is not supported.");
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
		if (v < 64) {
			ctx.buf[ctx.p++] = consts.VLI_LEN_1 + v;
			return;
		}
		if (v < 16384) {
			ctx.buf[ctx.p++] = consts.VLI_LEN_2 + (v >> 8);
			ctx.buf[ctx.p++] = consts.VLI_MASK_LSB & v;
			return;
		}
		if (v < 1073741824) {
			ctx.buf[ctx.p++] = consts.VLI_LEN_4 + (v >> 24);
			ctx.buf[ctx.p++] = consts.VLI_MASK_LSB & (v >> 16);
			ctx.buf[ctx.p++] = consts.VLI_MASK_LSB & (v >> 8);
			ctx.buf[ctx.p++] = consts.VLI_MASK_LSB & v;
			return;
		}
		if (v <= Number.MAX_SAFE_INTEGER) {
			// ctx.buf[ctx.p++] = consts.VLI_LEN_8 + (v >> 56);
			ctx.buf[ctx.p++] = consts.VLI_LEN_8;
			ctx.buf[ctx.p++] = consts.VLI_MASK_LSB & (v >> 48);
			ctx.buf[ctx.p++] = consts.VLI_MASK_LSB & (v >> 40);
			ctx.buf[ctx.p++] = consts.VLI_MASK_LSB & (v >> 32);
			ctx.buf[ctx.p++] = consts.VLI_MASK_LSB & (v >> 24);
			ctx.buf[ctx.p++] = consts.VLI_MASK_LSB & (v >> 16);
			ctx.buf[ctx.p++] = consts.VLI_MASK_LSB & (v >> 8);
			ctx.buf[ctx.p++] = consts.VLI_MASK_LSB & v;
			return;
		}
		throw new errors.NotSupportedError("Over MAX_SAFE_INTEGER-length value is not supported.");
	}
}
