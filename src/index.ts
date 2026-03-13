export { BHttpDecoder } from "./decoder";
export { BHttpEncoder } from "./encoder";
export * from "./errors";

// Streaming API
export {
	BHttpRequestStreamEncoder,
	BHttpResponseStreamEncoder,
} from "./stream-encoder";
export {
	BHttpStreamDecoder,
	type BHttpEvent,
	type BHttpRequestPreambleEvent,
	type BHttpResponsePreambleEvent,
	type BHttpInformationalEvent,
	type BHttpContentEvent,
	type BHttpTrailersEvent,
	type BHttpEndEvent,
} from "./stream-decoder";

// VLI utilities (for advanced use)
export {
	encodeVli,
	decodeVli,
	vliEncodedLength,
	type VliDecodeResult,
} from "./vli";
