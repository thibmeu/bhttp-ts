import { fc, it } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import {
	BHttpDecoder,
	BHttpEncoder,
	MessageLimitExceededError,
	padme,
	padmeWithFloor,
} from "../src";
import { collectBytes } from "./utils";

describe("Padmé", () => {
	it.each([
		[0, 0],
		[1, 1],
		[2, 2],
		[1000, 1024],
		[1024, 1024],
		[1500, 1536],
		[20000, 20480],
		[1_000_000, 1_015_808],
		[100_000_000, 100_663_296],
	])("pads %i to %i", (size, expected) => {
		expect(padme(size)).toBe(expected);
	});
	it.prop([fc.integer({ min: 1, max: 2 ** 52 }), fc.integer({ min: 1, max: 2 ** 52 })])(
		"is bounded, monotone and idempotent",
		(a, b) => {
			const padded = padme(a);
			expect(padded).toBeGreaterThanOrEqual(a);
			expect(padded - a).toBeLessThanOrEqual(a * 0.12);
			expect(padme(padded)).toBe(padded);
			expect(padme(Math.min(a, b))).toBeLessThanOrEqual(padme(Math.max(a, b)));
		},
	);
	it("handles power boundaries without 32-bit truncation", () => {
		for (let e = 1; e <= 52; e++) {
			expect(padme(2 ** e - 1)).toBeLessThanOrEqual(2 ** e);
			expect(padme(2 ** e)).toBe(2 ** e);
			expect(padme(2 ** e + 1)).toBeGreaterThanOrEqual(2 ** e + 1);
		}
	});
	it.each([-1, NaN, 1.5, Infinity, Number.MAX_SAFE_INTEGER])(
		"rejects unsupported size %s",
		(size) => {
			expect(() => padme(size)).toThrow(RangeError);
		},
	);
	it.each([-1, NaN, 1.5, Infinity])("rejects invalid floor %s", (min) => {
		expect(() => padmeWithFloor(min)).toThrow(RangeError);
	});
});

describe("function padding", () => {
	it.each(["request", "response"] as const)(
		"pads and decodes buffered and streaming %s",
		async (kind) => {
			const encoder = new BHttpEncoder();
			const decoder = new BHttpDecoder();
			const padding = padmeWithFloor(1024);
			const message = () =>
				kind === "request" ? new Request("https://example.com/") : new Response("hello");
			const buffered = await (kind === "request"
				? encoder.encodeRequest(message() as Request, { padding })
				: encoder.encodeResponse(message() as Response, { padding }));
			const streamed = await collectBytes(
				kind === "request"
					? encoder.encodeRequestStream(message() as Request, { padding })
					: encoder.encodeResponseStream(message() as Response, { padding }),
			);
			// Known-length and indeterminate-length framing differ, but policy totals agree.
			expect(buffered.length).toBe(1024);
			expect(streamed.length).toBe(buffered.length);
			for (const bytes of [buffered, streamed]) {
				const decoded =
					kind === "request" ? decoder.decodeRequest(bytes) : decoder.decodeResponse(bytes);
				expect(await decoded.text()).toBe(kind === "request" ? "" : "hello");
			}
			// A non-multiple run of zero padding is also accepted.
			const arbitrary = new Uint8Array(buffered.length + 7);
			arbitrary.set(buffered);
			expect(
				await (kind === "request"
					? decoder.decodeRequest(arbitrary)
					: decoder.decodeResponse(arbitrary)
				).text(),
			).toBe(kind === "request" ? "" : "hello");
		},
	);
	it.each([
		(size: number) => size - 1,
		() => NaN,
		(size: number) => size + 0.5,
		() => Infinity,
		() => Number.MAX_SAFE_INTEGER + 1,
	])("rejects invalid policy results", async (padding) => {
		const encoder = new BHttpEncoder();
		await expect(
			encoder.encodeRequest(new Request("https://example.com"), { padding }),
		).rejects.toThrow(RangeError);
		await expect(encoder.encodeResponse(new Response(), { padding })).rejects.toThrow(RangeError);
		await expect(
			collectBytes(encoder.encodeRequestStream(new Request("https://example.com"), { padding })),
		).rejects.toThrow(RangeError);
		await expect(
			collectBytes(encoder.encodeResponseStream(new Response(), { padding })),
		).rejects.toThrow(RangeError);
	});
	it("checks padded limits before reading buffered bodies and during streaming", async () => {
		const encoder = new BHttpEncoder();
		let reads = 0;
		const body = () =>
			new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						reads++;
						controller.enqueue(new Uint8Array(100));
					},
				},
				{ highWaterMark: 0 },
			);
		const response = new Response(body());
		await expect(
			encoder.encodeResponse(response, { padding: padmeWithFloor(1024), maxMessageSize: 1000 }),
		).rejects.toThrow(MessageLimitExceededError);
		expect(reads).toBe(0);
		await expect(
			collectBytes(
				encoder.encodeResponseStream(new Response(body()), {
					padding: (size) => size + 100,
					maxMessageSize: 250,
				}),
			),
		).rejects.toThrow(MessageLimitExceededError);
		expect(reads).toBe(2);
	});
});

describe("buffered policy cleanup", () => {
	it.each(["request", "response"] as const)(
		"cancels %s bodies on policy failures",
		async (kind) => {
			for (const failAt of [1, 2]) {
				for (const invalidResult of [false, true]) {
					for (const cancelThrows of [false, true]) {
						let calls = 0;
						let reads = 0;
						let cancelled = false;
						let cancelReason: unknown;
						const reason = new Error("policy failed");
						const body = new ReadableStream<Uint8Array>(
							{
								pull(controller) {
									reads++;
									controller.enqueue(new Uint8Array(10));
								},
								cancel(error) {
									cancelled = true;
									cancelReason = error;
									if (cancelThrows) throw new Error("cancel failed");
								},
							},
							{ highWaterMark: 0 },
						);
						const message = {
							url: "https://example.com/",
							method: "POST",
							status: 200,
							headers: new Headers(),
							body,
							arrayBuffer: async () => new ArrayBuffer(0),
						};
						const padding = (size: number) => {
							if (++calls !== failAt) return size;
							if (invalidResult) return NaN;
							throw reason;
						};
						const encoder = new BHttpEncoder();
						const result =
							kind === "request"
								? encoder.encodeRequest(message as Request, { padding })
								: encoder.encodeResponse(message as Response, { padding });
						const error = await result.catch((error: unknown) => error);
						if (invalidResult) expect(error).toBeInstanceOf(RangeError);
						else expect(error).toBe(reason);
						expect(cancelled).toBe(true);
						expect(cancelReason).toBe(error);
						expect(body.locked).toBe(false);
						expect(reads).toBe(failAt - 1);
					}
				}
			}
		},
	);

	it.each(["request", "response"] as const)(
		"allocates %s from the checked policy result",
		async (kind) => {
			for (const hasBody of [false, true]) {
				const seen = new Map<number, number>();
				const padding = (size: number) => {
					const calls = (seen.get(size) ?? 0) + 1;
					seen.set(size, calls);
					return calls === 1 ? 1024 : 2048;
				};
				const body = hasBody
					? new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new Uint8Array([42]));
								controller.enqueue(new Uint8Array(0));
								controller.close();
							},
						})
					: null;
				const message = {
					url: "https://example.com/",
					method: hasBody ? "POST" : "GET",
					status: 200,
					headers: new Headers(),
					body,
					arrayBuffer: async () => new ArrayBuffer(0),
				};
				const encoder = new BHttpEncoder();
				const options = { padding, maxMessageSize: 1024 };
				const bytes = await (kind === "request"
					? encoder.encodeRequest(message as Request, options)
					: encoder.encodeResponse(message as Response, options));
				expect(bytes.length).toBe(1024);
				expect([...seen.values()]).toEqual(hasBody ? [1, 1] : [1]);
				if (kind === "response") {
					const decoded = new BHttpDecoder().decodeResponse(bytes);
					expect(new Uint8Array(await decoded.arrayBuffer())).toEqual(
						hasBody ? new Uint8Array([42]) : new Uint8Array(0),
					);
				}
			}
		},
	);
});
