import { existsSync } from "node:fs";
import type { TestContext } from "vitest";

/**
 * Runs one benchmark and writes its result to `bench-results/`. When
 * `BENCH_BASELINE=<dir>` is set (CI points it at results from main), the run
 * is also compared against the same-named result in that directory.
 */
export async function runBench(
	bench: TestContext["bench"],
	name: string,
	fn: () => unknown,
): Promise<void> {
	const file = `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`;
	const current = bench(name, { writeResult: `bench-results/${file}` }, fn);
	const baseline = process.env.BENCH_BASELINE && `${process.env.BENCH_BASELINE}/${file}`;
	if (baseline && existsSync(baseline)) {
		await bench.compare(current, bench.from(`${name} (baseline)`, baseline));
	} else {
		await current.run();
	}
}
