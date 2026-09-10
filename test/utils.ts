export function hexStringToBytes(v: string): Uint8Array {
	if (v.length === 0) {
		return new Uint8Array([]);
	}
	const res = v.match(/[\da-f]{2}/gi);
	if (res == null) {
		throw new Error("Not hex string.");
	}
	return new Uint8Array(res.map((h) => Number.parseInt(h, 16)));
}

export async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	const parts: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value);
			length += value.length;
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return bytes;
}
