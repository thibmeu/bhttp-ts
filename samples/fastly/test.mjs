// Smoke test for the Fastly Compute sample: hits the local Viceroy server
// started by `fastly compute serve` and checks the BHTTP round-trip succeeded.
const url = process.env.SAMPLE_URL ?? "http://127.0.0.1:7676/";

const res = await fetch(url);
if (!res.ok) {
	console.error(`Request failed: HTTP ${res.status}`);
	process.exit(1);
}

const body = await res.json();
if (!body.ok) {
	console.error("BHTTP round-trip failed on Fastly Compute:", body);
	process.exit(1);
}

console.log("Fastly Compute sample OK:", body);
