import * as consts from "./consts";
import * as errors from "./errors";

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
		const len = this.decodeVli(ctx);
		// View into the input buffer; createRequest/createResponse copies it once
		// into an owned buffer, so an extra copy here would be redundant.
		ctx.content = ctx.buf.subarray(ctx.p, ctx.p + len);
		ctx.p += len;
		return;
	}

	private decodeIndeterminateLengthContent(ctx: DecoderContext) {
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
		let res = 0;
		const firstByte = ctx.buf[ctx.p];
		if (firstByte === undefined) {
			throw new errors.InvalidMessageError("Unexpected end of buffer");
		}

		switch (firstByte & consts.VLI_MASK_VALUE) {
			case consts.VLI_LEN_1:
				ctx.p++;
				return firstByte & consts.VLI_MASK_HEADER;

			case consts.VLI_LEN_2:
				res = (firstByte & consts.VLI_MASK_HEADER) << 8;
				ctx.p++;
				res += ctx.buf[ctx.p++] ?? 0;
				return res;

			case consts.VLI_LEN_4:
				res = (firstByte & consts.VLI_MASK_HEADER) << 24;
				ctx.p++;
				res += (ctx.buf[ctx.p++] ?? 0) << 16;
				res += (ctx.buf[ctx.p++] ?? 0) << 8;
				res += ctx.buf[ctx.p++] ?? 0;
				return res;

			default: {
				// consts.VLI_LEN_8
				// res = (ctx.buf[ctx.p++] & consts.VLI_MASK_HEADER) << 56;
				res = 0;
				ctx.p++;
				const nextByte = ctx.buf[ctx.p];
				if (nextByte !== undefined && nextByte > 15) {
					throw new errors.NotSupportedError(
						"Over MAX_SAFE_INTEGER-length value is not supported.",
					);
				}
				res += (ctx.buf[ctx.p++] ?? 0) << 48;
				res += (ctx.buf[ctx.p++] ?? 0) << 40;
				res += (ctx.buf[ctx.p++] ?? 0) << 32;
				res += (ctx.buf[ctx.p++] ?? 0) << 24;
				res += (ctx.buf[ctx.p++] ?? 0) << 16;
				res += (ctx.buf[ctx.p++] ?? 0) << 8;
				res += ctx.buf[ctx.p++] ?? 0;
				return res;
			}
		}
	}
}
