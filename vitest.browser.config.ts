import { defineConfig } from "vitest/config";

// Runs the same test suite as vitest.config.ts, but inside a real browser
// (headless Chromium via Playwright) to validate the library works against a
// browser's native Fetch API / streams. The tests use no Node-only APIs.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		browser: {
			enabled: true,
			provider: "playwright",
			headless: true,
			name: "chromium",
		},
	},
});
