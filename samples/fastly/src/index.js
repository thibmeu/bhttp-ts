/// <reference types="@fastly/js-compute" />

import { BHttpDecoder, BHttpEncoder } from "bhttp-ts";

addEventListener("fetch", (event) => event.respondWith(handler()));

// Encode then decode a sample Request entirely on the Fastly Compute runtime
// to prove the library round-trips there.
async function handler() {
	const original = new Request("https://www.example.com/hello.txt", {
		method: "GET",
		headers: { "User-Agent": "fastly-bhttp-sample" },
	});

	const encoder = new BHttpEncoder();
	const encoded = await encoder.encodeRequest(original);

	const decoder = new BHttpDecoder();
	const decoded = decoder.decodeRequest(encoded);

	const body = JSON.stringify({
		ok: decoded.url === "https://www.example.com/hello.txt" && decoded.method === "GET",
		method: decoded.method,
		url: decoded.url,
		bytes: encoded.length,
	});

	return new Response(body, {
		headers: { "Content-Type": "application/json" },
	});
}
