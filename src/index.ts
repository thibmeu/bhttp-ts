export { BHttpDecoder } from "./decoder";
export { BHttpEncoder } from "./encoder";
export * from "./errors";
export {
	type BHttpContentEvent,
	type BHttpEndEvent,
	type BHttpEvent,
	type BHttpInformationalEvent,
	type BHttpRequestPreambleEvent,
	type BHttpResponsePreambleEvent,
	BHttpStreamDecoder,
	type BHttpTrailersEvent,
} from "./stream-decoder";
// Streaming API
export {
	BHttpRequestStreamEncoder,
	BHttpResponseStreamEncoder,
} from "./stream-encoder";

// VLI utilities (for advanced use)
export {
	decodeVli,
	encodeVli,
	type VliDecodeResult,
	vliEncodedLength,
} from "./vli";
