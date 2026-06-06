import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Runs the same test suite as vitest.config.ts, but inside a real browser
// (headless Chromium via Playwright) to validate the library works against a
// browser's native Fetch API / streams. The tests use no Node-only APIs.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Browsers forbid setting `User-Agent` (and other forbidden header
		// names) on a Request, so decodeRequest() cannot round-trip those
		// headers in-browser. These two suites assert the RFC 9292 curl
		// example vectors (which include User-Agent), so they only run
		// outside the browser.
		exclude: ["test/bhttp.test.ts", "test/example.test.ts"],
		browser: {
			enabled: true,
			provider: playwright(),
			headless: true,
			instances: [{ browser: "chromium" }],
		},
	},
});
