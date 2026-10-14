import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			miniflare: {
				compatibilityDate: "2026-08-01",
			},
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 30_000,
		// workerd can't read vitest 5's on-disk module cache
		// (ENOENT readAll in node_modules/.vitest-cache); re-enable once
		// @cloudflare/vitest-plugin supports it.
		fsModuleCache: false,
	},
});
