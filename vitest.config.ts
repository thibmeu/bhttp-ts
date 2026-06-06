import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// One encoder test allocates and encodes >1 GiB, which exceeds the
		// default 5s timeout on slower runners.
		testTimeout: 30_000,
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
		},
	},
});
