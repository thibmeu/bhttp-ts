export { BHttpDecoder } from "./src/decoder.ts";
export { BHttpEncoder } from "./src/encoder.ts";
export * from "./src/errors.ts";

// Streaming API
export {
	BHttpRequestStreamEncoder,
	BHttpResponseStreamEncoder,
} from "./src/stream-encoder.ts";
export {
	BHttpStreamDecoder,
	type BHttpEvent,
	type BHttpRequestPreambleEvent,
	type BHttpResponsePreambleEvent,
	type BHttpInformationalEvent,
	type BHttpContentEvent,
	type BHttpTrailersEvent,
	type BHttpEndEvent,
} from "./src/stream-decoder.ts";

// VLI utilities (for advanced use)
export {
	encodeVli,
	decodeVli,
	vliEncodedLength,
	type VliDecodeResult,
} from "./src/vli.ts";
