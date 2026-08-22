/**
 * The base error class of hpke-js.
 */
class BHttpError extends Error {}

/**
 * Invalid message.
 */
export class InvalidMessageError extends BHttpError {}

/** Message metadata exceeds the decoder's configured resource limit. */
export class MetadataLimitExceededError extends BHttpError {}

/**
 * Not supported data.
 */
export class NotSupportedError extends BHttpError {}
