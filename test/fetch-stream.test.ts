import { describe, expect, it } from "vitest";

import { BHttpDecoder } from "../src/decoder";
import { BHttpEncoder } from "../src/encoder";
import { BHttpRequestStreamEncoder, BHttpResponseStreamEncoder } from "../src/stream-encoder";

describe("Fetch streaming API", () => {
	it("should round-trip a streaming Request", async () => {
		// Arrange
		const encoder = new BHttpEncoder();
		const decoder = new BHttpDecoder();
		const request = new Request("https://example.com/upload?q=1", {
			method: "POST",
			headers: { "x-test": "stream" },
			body: streamOf(new TextEncoder().encode("hello")),
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		// Act
		const decoded = await decoder.decodeRequestStream(encoder.encodeRequestStream(request));

		// Assert
		expect(decoded.url).toBe("https://example.com/upload?q=1");
		expect(decoded.method).toBe("POST");
		expect(decoded.headers.get("x-test")).toBe("stream");
		expect(await decoded.text()).toBe("hello");
	});

	it("should round-trip a streaming Response", async () => {
		// Arrange
		const encoder = new BHttpEncoder();
		const decoder = new BHttpDecoder();
		const response = new Response(streamOf(new TextEncoder().encode("hello")), {
			status: 201,
			headers: { "x-test": "stream" },
		});

		// Act
		const decoded = await decoder.decodeResponseStream(encoder.encodeResponseStream(response));

		// Assert
		expect(decoded.status).toBe(201);
		expect(decoded.headers.get("x-test")).toBe("stream");
		expect(await decoded.text()).toBe("hello");
	});

	it("should keep encoding read-ahead bounded and propagate cancellation", async () => {
		// Arrange
		const source = finiteBody(100);
		const request = new Request("https://example.com/upload", {
			method: "POST",
			body: source.stream,
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		// Act
		const encoded = new BHttpEncoder().encodeRequestStream(request);
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Assert
		expect(source.pulls).toBeLessThanOrEqual(2);
		await encoded.cancel("consumer stopped");
		expect(source.cancelled).toBe(true);
	});

	it("should keep decoding read-ahead bounded and propagate cancellation", async () => {
		// Arrange
		const encoder = new BHttpRequestStreamEncoder();
		const preamble = encoder.encodePreamble(
			"POST",
			"https",
			"example.com",
			"/upload",
			new Headers(),
		);
		const source = framedBody(preamble, encoder, 100);

		// Act
		const request = await new BHttpDecoder().decodeRequestStream(source.stream);
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Assert
		expect(source.pulls).toBeLessThanOrEqual(3);
		await request.body?.cancel("consumer stopped");
		expect(source.cancelled).toBe(true);
	});

	it.each([
		["GET request", () => requestPreamble("GET")],
		["HEAD request", () => requestPreamble("HEAD")],
		["204 response", () => responsePreamble(204)],
		["205 response", () => responsePreamble(205)],
		["304 response", () => responsePreamble(304)],
	])("should cancel the input for a bodyless %s", async (_name, preamble) => {
		// Arrange
		const source = bodylessMessage(preamble());

		// Act
		if (_name.endsWith("request")) {
			await new BHttpDecoder().decodeRequestStream(source.stream);
		} else {
			await new BHttpDecoder().decodeResponseStream(source.stream);
		}

		// Assert
		expect(source.cancelled).toBe(true);
		expect(source.stream.locked).toBe(false);
	});

	it.each([
		["CONNECT request", () => requestPreamble("CONNECT")],
		["invalid response status", invalidResponsePreamble],
	])("should cancel the input when constructing an %s fails", async (name, preamble) => {
		// Arrange
		const source = bodylessMessage(preamble());

		// Act / Assert
		if (name.endsWith("request")) {
			await expect(new BHttpDecoder().decodeRequestStream(source.stream)).rejects.toThrow();
		} else {
			await expect(new BHttpDecoder().decodeResponseStream(source.stream)).rejects.toThrow();
		}
		expect(source.cancelled).toBe(true);
		expect(source.stream.locked).toBe(false);
	});

	it("should reject a response when a request is expected", async () => {
		// Arrange
		const encoded = new BHttpEncoder().encodeResponseStream(new Response("wrong kind"));

		// Act / Assert
		await expect(new BHttpDecoder().decodeRequestStream(encoded)).rejects.toThrow(
			"Expected a BHTTP request",
		);
	});

	it("should cancel malformed input", async () => {
		// Arrange
		let cancelled = false;
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([0x04]));
			},
			cancel() {
				cancelled = true;
			},
		});

		// Act / Assert
		await expect(new BHttpDecoder().decodeRequestStream(source)).rejects.toThrow(
			"Invalid framing indicator",
		);
		expect(cancelled).toBe(true);
	});
});

// Helpers

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function finiteBody(totalChunks: number) {
	let pulls = 0;
	let cancelled = false;
	return {
		stream: new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pulls === totalChunks) return controller.close();
				pulls++;
				controller.enqueue(new Uint8Array(64 * 1024));
			},
			cancel() {
				cancelled = true;
			},
		}),
		get pulls() {
			return pulls;
		},
		get cancelled() {
			return cancelled;
		},
	};
}

function framedBody(preamble: Uint8Array, encoder: BHttpRequestStreamEncoder, totalChunks: number) {
	let pulls = 0;
	let cancelled = false;
	return {
		stream: new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pulls === 0) controller.enqueue(preamble);
				else if (pulls <= totalChunks) {
					controller.enqueue(encoder.encodeContentChunk(new Uint8Array(64 * 1024)));
				} else controller.enqueue(encoder.encodeEnd());
				pulls++;
			},
			cancel() {
				cancelled = true;
			},
		}),
		get pulls() {
			return pulls;
		},
		get cancelled() {
			return cancelled;
		},
	};
}

function requestPreamble(method: string): Uint8Array {
	return new BHttpRequestStreamEncoder().encodePreamble(
		method,
		"https",
		"example.com",
		"/",
		new Headers(),
	);
}

function responsePreamble(status: number): Uint8Array {
	return new BHttpResponseStreamEncoder().encodePreamble(status, new Headers());
}

function invalidResponsePreamble(): Uint8Array {
	// Indeterminate response, final status 700, empty headers.
	return new Uint8Array([3, 0x42, 0xbc, 0]);
}

function bodylessMessage(preamble: Uint8Array) {
	let pulls = 0;
	let cancelled = false;
	return {
		stream: new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(pulls++ === 0 ? preamble : new Uint8Array([1, 0]));
			},
			cancel() {
				cancelled = true;
			},
		}),
		get cancelled() {
			return cancelled;
		},
	};
}
