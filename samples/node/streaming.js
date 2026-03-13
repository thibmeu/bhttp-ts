/**
 * Node.js streaming BHTTP example
 *
 * Demonstrates incremental encoding/decoding for streaming scenarios.
 */

const {
	BHttpRequestStreamEncoder,
	BHttpResponseStreamEncoder,
	BHttpStreamDecoder,
} = require("bhttp-ts");

/**
 * Streaming request encoding example
 */
function encodeStreamingRequest() {
	console.log("=== Streaming Request Encoding ===\n");

	const encoder = new BHttpRequestStreamEncoder();

	// Encode preamble (method, scheme, authority, path, headers)
	const headers = new Headers({ "Content-Type": "application/json" });
	const preamble = encoder.encodePreamble("POST", "https", "api.example.com", "/v1/data", headers);
	console.log("Preamble bytes:", preamble.length);

	// Encode body chunks incrementally
	const chunk1 = encoder.encodeContentChunk(new TextEncoder().encode('{"part":'));
	console.log("Chunk 1 bytes:", chunk1.length);

	const chunk2 = encoder.encodeContentChunk(new TextEncoder().encode('"one"}'));
	console.log("Chunk 2 bytes:", chunk2.length);

	// Encode end (with optional trailers)
	const end = encoder.encodeEnd();
	console.log("End bytes:", end.length);

	// Combine all parts
	const full = new Uint8Array(preamble.length + chunk1.length + chunk2.length + end.length);
	let offset = 0;
	for (const part of [preamble, chunk1, chunk2, end]) {
		full.set(part, offset);
		offset += part.length;
	}

	console.log("\nTotal encoded bytes:", full.length);
	return full;
}

/**
 * Streaming response encoding example
 */
function encodeStreamingResponse() {
	console.log("\n=== Streaming Response Encoding ===\n");

	const encoder = new BHttpResponseStreamEncoder();

	// Encode preamble with optional informational responses
	const informational = [
		{ status: 103, headers: new Headers({ Link: "</style.css>; rel=preload" }) },
	];
	const headers = new Headers({ "Content-Type": "text/plain" });
	const preamble = encoder.encodePreamble(200, headers, informational);
	console.log("Preamble bytes (with 103 Early Hints):", preamble.length);

	// Encode body
	const chunk = encoder.encodeContentChunk(new TextEncoder().encode("Hello, World!"));
	console.log("Body chunk bytes:", chunk.length);

	// Encode end with trailers
	const trailers = new Headers({ "X-Checksum": "abc123" });
	const end = encoder.encodeEnd(trailers);
	console.log("End bytes (with trailers):", end.length);

	const full = new Uint8Array(preamble.length + chunk.length + end.length);
	full.set(preamble);
	full.set(chunk, preamble.length);
	full.set(end, preamble.length + chunk.length);

	console.log("\nTotal encoded bytes:", full.length);
	return full;
}

/**
 * Streaming decode example - byte-by-byte simulation
 */
function decodeStreaming(encoded, type) {
	console.log(`\n=== Streaming ${type} Decoding ===\n`);

	const decoder = new BHttpStreamDecoder();
	const allEvents = [];

	// Simulate streaming: feed data in small chunks
	const chunkSize = 10; // Small chunks to demonstrate streaming
	for (let i = 0; i < encoded.length; i += chunkSize) {
		const slice = encoded.subarray(i, Math.min(i + chunkSize, encoded.length));
		const events = decoder.push(slice);

		for (const event of events) {
			allEvents.push(event);
			console.log(`Event: ${event.type}`);

			switch (event.type) {
				case "request-preamble":
					console.log(`  ${event.method} ${event.scheme}://${event.authority}${event.path}`);
					break;
				case "response-preamble":
					console.log(`  Status: ${event.status}`);
					break;
				case "informational":
					console.log(`  Informational: ${event.status}`);
					break;
				case "content":
					console.log(
						`  Content: "${new TextDecoder().decode(event.data)}" (${event.data.length} bytes)`,
					);
					break;
				case "trailers":
					console.log(`  Trailers received`);
					break;
			}
		}
	}

	// Finalize
	const endEvents = decoder.end();
	for (const event of endEvents) {
		allEvents.push(event);
		console.log(`Event: ${event.type}`);
	}

	console.log(`\nTotal events: ${allEvents.length}`);
	return allEvents;
}

// Run examples
const encodedRequest = encodeStreamingRequest();
decodeStreaming(encodedRequest, "Request");

const encodedResponse = encodeStreamingResponse();
decodeStreaming(encodedResponse, "Response");
