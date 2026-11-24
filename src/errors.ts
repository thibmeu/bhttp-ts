/**
 * Base class for BHTTP errors.
 */
export class BHttpError extends Error {}

/**
 * Invalid message.
 */
export class InvalidMessageError extends BHttpError {}

/** Message metadata exceeds the decoder's configured resource limit. */
export class MetadataLimitExceededError extends BHttpError {}

/** Encoded message exceeds the encoder's configured size limit. */
export class MessageLimitExceededError extends BHttpError {}

/**
 * Not supported data.
 */
export class NotSupportedError extends BHttpError {}

/** Default maximum encoded non-content bytes accepted in one message. */
export const DEFAULT_MAX_METADATA_SIZE = 64 * 1024;

/** Resolves and validates the maxMetadataSize option shared by encoder and decoder. */
export function metadataSizeLimit(options: { readonly maxMetadataSize?: number }): number {
	const limit = options.maxMetadataSize ?? DEFAULT_MAX_METADATA_SIZE;
	if (!Number.isSafeInteger(limit) || limit < 0) {
		throw new RangeError(`maxMetadataSize must be a non-negative integer, got ${limit}`);
	}
	return limit;
}
