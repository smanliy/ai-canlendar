import { Buffer } from "node:buffer";
//#region src/gateway/server/close-reason.ts
/**
* WebSocket close reason utilities.
*/
const CLOSE_REASON_MAX_BYTES = 120;
/** Truncates close reasons to the RFC-safe byte limit used during handshake failures. */
function truncateCloseReason(reason, maxBytes = CLOSE_REASON_MAX_BYTES) {
	if (!reason) return "invalid handshake";
	const buf = Buffer.from(reason);
	if (buf.length <= maxBytes) return reason;
	let end = maxBytes;
	while (end > 0 && (buf[end] & 192) === 128) end--;
	return buf.subarray(0, end).toString();
}
//#endregion
export { truncateCloseReason as t };
