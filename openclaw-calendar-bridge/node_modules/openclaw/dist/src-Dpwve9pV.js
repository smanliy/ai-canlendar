/** Accepts either a complete literal or a still-streaming prefix of that literal. */
function matchesLiteralPrefix(text, literal) {
	return literal.startsWith(text) || text.startsWith(literal);
}
/** Tool names in bracket/plain-text repairs intentionally match provider-safe ids only. */
function isPlainTextToolNameChar(char) {
	return Boolean(char && /[A-Za-z0-9_-]/.test(char));
}
/** XML-ish function tags allow namespace punctuation used by some model families. */
function isXmlishNameChar(char) {
	return Boolean(char && /[A-Za-z0-9_.:-]/.test(char));
}
/** Skips spaces and tabs only, preserving line boundaries for grammar decisions. */
function skipHorizontalWhitespace(text, start) {
	let index = start;
	while (index < text.length && (text[index] === " " || text[index] === "	")) index += 1;
	return index;
}
/** Skips all JavaScript whitespace when line structure is no longer meaningful. */
function skipWhitespace(text, start) {
	let index = start;
	while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
	return index;
}
/** Consumes either Unix or Windows line endings and returns the first offset after them. */
function consumeLineBreak(text, start) {
	if (text[start] === "\r") return text[start + 1] === "\n" ? start + 2 : start + 1;
	if (text[start] === "\n") return start + 1;
	return null;
}
/** Finds the exclusive end offset of a balanced JSON object starting at `start`. */
function findJsonObjectEnd(text, start, maxPayloadBytes) {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		if (maxPayloadBytes !== void 0 && index + 1 - start > maxPayloadBytes) return null;
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") {
			depth += 1;
			continue;
		}
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return null;
}
/** Consumes one optional line break after a repaired serialized tool-call fragment. */
function skipSerializedToolCallTrailingLineBreak(text, cursor) {
	return consumeLineBreak(text, cursor) ?? cursor;
}
/** Accepts the legacy closing markers models append after JSON tool-call payloads. */
function consumeJsonToolClosingMarker(text, cursor) {
	let markerStart = cursor;
	while (markerStart < text.length && /\s/.test(text[markerStart] ?? "")) markerStart += 1;
	const rest = text.slice(markerStart);
	if (rest.startsWith("[END_TOOL_REQUEST]")) return skipSerializedToolCallTrailingLineBreak(text, markerStart + 18);
	const bracketClose = /^\[\/[A-Za-z0-9_-]+\]/.exec(rest);
	if (bracketClose) return skipSerializedToolCallTrailingLineBreak(text, markerStart + bracketClose[0].length);
	if (rest.startsWith("<|call|>")) return skipSerializedToolCallTrailingLineBreak(text, markerStart + 8);
	return skipSerializedToolCallTrailingLineBreak(text, cursor);
}
/** Finds JSON after bracketed tool syntax such as `[tool_name]\n{...}`. */
function findBracketedJsonPayloadStart(text) {
	if (!text.startsWith("[")) return null;
	const close = text.indexOf("]");
	if (close === -1) return null;
	let cursor = close + 1;
	cursor = skipHorizontalWhitespace(text, cursor);
	cursor = skipSerializedToolCallTrailingLineBreak(text, cursor);
	cursor = skipHorizontalWhitespace(text, cursor);
	return text[cursor] === "{" ? cursor : null;
}
/** Finds JSON after Harmony channel/tool headers while tolerating optional message markers. */
function findHarmonyJsonPayloadStart(text) {
	let cursor = 0;
	if (text.startsWith("<|channel|>")) cursor = 11;
	const rest = text.slice(cursor);
	const channel = [
		"commentary",
		"analysis",
		"final"
	].find((candidate) => rest.startsWith(candidate));
	if (!channel) return null;
	cursor += channel.length;
	cursor = skipHorizontalWhitespace(text, cursor);
	if (!text.slice(cursor).startsWith("to=")) return null;
	cursor += 3;
	const nameStart = cursor;
	while (isPlainTextToolNameChar(text[cursor])) cursor += 1;
	if (cursor === nameStart) return null;
	cursor = skipHorizontalWhitespace(text, cursor);
	if (!text.slice(cursor).startsWith("code")) return null;
	cursor += 4;
	cursor = skipWhitespace(text, cursor);
	if (text.slice(cursor).startsWith("<|message|>")) cursor = skipWhitespace(text, cursor + 11);
	return text[cursor] === "{" ? cursor : null;
}
/** Case-insensitive marker compare for ASCII protocol tags without locale rules. */
function startsWithAsciiMarkerIgnoreCase(text, cursor, marker) {
	return text.slice(cursor, cursor + marker.length).toLowerCase() === marker;
}
/** Case-insensitive marker search for ASCII protocol tags without allocating regexes. */
function indexOfAsciiMarkerIgnoreCase(text, marker, start) {
	let cursor = start;
	while (cursor < text.length) {
		const next = text.indexOf(marker[0] ?? "", cursor);
		if (next === -1) return -1;
		if (startsWithAsciiMarkerIgnoreCase(text, next, marker)) return next;
		cursor = next + 1;
	}
	return -1;
}
/** Returns the end offset for a complete XML-ish or bracketed plain-text tool call. */
function findXmlishToolCallEnd(text) {
	let cursor;
	const xmlFunction = /^<function=[A-Za-z0-9_.:-]+>/i.exec(text);
	if (xmlFunction) cursor = xmlFunction[0].length;
	else {
		const bracketed = /^\[(?:tool:)?[A-Za-z0-9_-]+\]/.exec(text);
		if (!bracketed) return null;
		cursor = bracketed[0].length;
		cursor = skipHorizontalWhitespace(text, cursor);
		cursor = skipSerializedToolCallTrailingLineBreak(text, cursor);
	}
	cursor = skipWhitespace(text, cursor);
	if (!startsWithAsciiMarkerIgnoreCase(text, cursor, "<parameter=")) return null;
	while (cursor < text.length) {
		const parameterClose = indexOfAsciiMarkerIgnoreCase(text, "</parameter>", cursor);
		if (parameterClose === -1) return null;
		cursor = skipWhitespace(text, parameterClose + 12);
		if (startsWithAsciiMarkerIgnoreCase(text, cursor, "</function>")) return skipSerializedToolCallTrailingLineBreak(text, cursor + 11);
		if (!startsWithAsciiMarkerIgnoreCase(text, cursor, "<parameter=")) return skipSerializedToolCallTrailingLineBreak(text, cursor);
	}
	return null;
}
//#endregion
//#region packages/tool-call-repair/src/payload.ts
const DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES = 256e3;
const utf8Encoder = new TextEncoder();
function utf8ByteLengthWithinLimit(text, start, end, maxBytes) {
	if (end - start > maxBytes) return null;
	const byteLength = utf8Encoder.encode(text.slice(start, end)).byteLength;
	return byteLength <= maxBytes ? byteLength : null;
}
function parseBracketOpening(text, start) {
	if (text[start] !== "[") return null;
	let cursor = start + 1;
	if (text.startsWith("tool:", cursor)) {
		cursor += 5;
		const nameStart = cursor;
		while (isPlainTextToolNameChar(text[cursor])) cursor += 1;
		if (cursor === nameStart || text[cursor] !== "]") return null;
		return {
			allowsOptionalXmlishClose: true,
			end: cursor + 1,
			name: text.slice(nameStart, cursor),
			requiresClosing: false
		};
	}
	const nameStart = cursor;
	while (isPlainTextToolNameChar(text[cursor])) cursor += 1;
	if (cursor === nameStart || text[cursor] !== "]") return null;
	const name = text.slice(nameStart, cursor);
	cursor += 1;
	cursor = skipHorizontalWhitespace(text, cursor);
	const afterLineBreak = consumeLineBreak(text, cursor);
	if (afterLineBreak === null) return null;
	return {
		end: afterLineBreak,
		name,
		requiresClosing: true
	};
}
function parseHarmonyOpening(text, start) {
	let cursor = start;
	if (text.startsWith("<|channel|>", cursor)) cursor += 11;
	const channelStart = cursor;
	while (/[A-Za-z_]/.test(text[cursor] ?? "")) cursor += 1;
	const channel = text.slice(channelStart, cursor);
	if (channel !== "commentary" && channel !== "analysis" && channel !== "final") return null;
	cursor = skipHorizontalWhitespace(text, cursor);
	if (!text.startsWith("to=", cursor)) return null;
	cursor += 3;
	const nameStart = cursor;
	while (isPlainTextToolNameChar(text[cursor])) cursor += 1;
	if (cursor === nameStart) return null;
	const name = text.slice(nameStart, cursor);
	cursor = skipHorizontalWhitespace(text, cursor);
	if (!text.startsWith("code", cursor)) return null;
	cursor += 4;
	cursor = skipWhitespace(text, cursor);
	if (text.startsWith("<|message|>", cursor)) cursor = skipWhitespace(text, cursor + 11);
	return {
		end: cursor,
		name,
		requiresClosing: false
	};
}
function parseXmlishFunctionOpening(text, start) {
	const match = /^<function=([A-Za-z0-9_.:-]{1,120})>\s*/i.exec(text.slice(start));
	if (!match?.[1]) return null;
	return {
		end: start + match[0].length,
		name: match[1],
		requiresClosing: false
	};
}
function parseOpening(text, start) {
	return parseBracketOpening(text, start) ?? parseHarmonyOpening(text, start);
}
function consumeJsonObject(text, start, maxPayloadBytes) {
	const cursor = skipWhitespace(text, start);
	if (text[cursor] !== "{") return null;
	const end = findJsonObjectEnd(text, cursor, maxPayloadBytes);
	if (end === null || utf8ByteLengthWithinLimit(text, cursor, end, maxPayloadBytes) === null) return null;
	const rawJson = text.slice(cursor, end);
	try {
		const parsed = JSON.parse(rawJson);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return {
			end,
			value: parsed
		};
	} catch {
		return null;
	}
}
function parseClosing(text, start, name) {
	const cursor = skipWhitespace(text, start);
	if (text.startsWith("[END_TOOL_REQUEST]", cursor)) return cursor + 18;
	const namedClosing = `[/${name}]`;
	if (text.startsWith(namedClosing, cursor)) return cursor + namedClosing.length;
	return null;
}
function parseOptionalHarmonyClosing(text, start) {
	const cursor = skipWhitespace(text, start);
	if (text.startsWith("<|call|>", cursor)) return cursor + 8;
	return start;
}
function parsePlainTextToolCallBlockAt(text, start, options) {
	const opening = parseOpening(text, start);
	if (!opening) return null;
	const allowedToolNames = options?.allowedToolNames ? new Set(options.allowedToolNames) : void 0;
	if (allowedToolNames && !allowedToolNames.has(opening.name)) return null;
	const payload = consumeJsonObject(text, opening.end, options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES);
	if (!payload) return null;
	const closingEnd = opening.requiresClosing ? parseClosing(text, payload.end, opening.name) : parseOptionalHarmonyClosing(text, payload.end);
	if (closingEnd === null) return null;
	return {
		arguments: payload.value,
		end: closingEnd,
		name: opening.name,
		raw: text.slice(start, closingEnd),
		start
	};
}
function findXmlishParameterBlock(text, start) {
	const cursor = skipWhitespace(text, start);
	const openMatch = /^<parameter=([A-Za-z0-9_.:-]{1,120})>/i.exec(text.slice(cursor));
	if (!openMatch?.[1]) return null;
	const payloadStart = cursor + openMatch[0].length;
	const closeMatch = /<\/parameter>/i.exec(text.slice(payloadStart));
	if (!closeMatch) return null;
	const closeStart = payloadStart + closeMatch.index;
	return {
		closeStart,
		end: closeStart + closeMatch[0].length,
		name: openMatch[1],
		payloadStart,
		start: cursor
	};
}
function consumeXmlishParameterBlock(text, start, maxPayloadBytes) {
	const bounds = findXmlishParameterBlock(text, start);
	if (!bounds) return null;
	const byteLength = utf8ByteLengthWithinLimit(text, start, bounds.end, maxPayloadBytes);
	if (byteLength === null) return null;
	return {
		byteLength,
		end: bounds.end,
		name: bounds.name,
		value: extractXmlishParameterValue(text, bounds.payloadStart, bounds.closeStart)
	};
}
function extractXmlishParameterValue(text, start, end) {
	let payloadStart = start;
	let payloadEnd = end;
	const afterOpeningLineBreak = consumeLineBreak(text, payloadStart);
	if (afterOpeningLineBreak !== null) {
		payloadStart = afterOpeningLineBreak;
		if (payloadEnd > payloadStart && text[payloadEnd - 1] === "\n") {
			payloadEnd -= 1;
			if (payloadEnd > payloadStart && text[payloadEnd - 1] === "\r") payloadEnd -= 1;
		} else if (payloadEnd > payloadStart && text[payloadEnd - 1] === "\r") payloadEnd -= 1;
	}
	return text.slice(payloadStart, payloadEnd);
}
function consumeXmlishFunctionClose(text, start) {
	const cursor = skipWhitespace(text, start);
	return text.slice(cursor).toLowerCase().startsWith("</function>") ? cursor + 11 : null;
}
function consumeOptionalXmlishFunctionClose(text, start) {
	return consumeXmlishFunctionClose(text, start) ?? start;
}
function parseXmlishPlainTextToolCallBlockEndAt(text, start) {
	const opening = parseXmlishOpening(text, start);
	if (!opening) return null;
	let cursor = opening.end;
	let parameterCount = 0;
	while (true) {
		const parameter = findXmlishParameterBlock(text, cursor);
		if (!parameter) break;
		parameterCount += 1;
		cursor = parameter.end;
	}
	if (parameterCount === 0) return null;
	return opening.allowsOptionalXmlishClose ? consumeOptionalXmlishFunctionClose(text, cursor) : consumeXmlishFunctionClose(text, cursor);
}
function parseXmlishOpening(text, start) {
	return parseBracketOpening(text, start) ?? parseXmlishFunctionOpening(text, start);
}
function parseXmlishPlainTextToolCallBlockAt(text, start, options) {
	const opening = parseXmlishOpening(text, start);
	if (!opening) return null;
	const allowedToolNames = options?.allowedToolNames ? new Set(options.allowedToolNames) : void 0;
	if (allowedToolNames && !allowedToolNames.has(opening.name)) return null;
	const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES;
	const args = {};
	let cursor = opening.end;
	let parameterCount = 0;
	let payloadBytes = 0;
	while (true) {
		const parameter = consumeXmlishParameterBlock(text, cursor, maxPayloadBytes);
		if (!parameter) break;
		payloadBytes += parameter.byteLength;
		if (payloadBytes > maxPayloadBytes) return null;
		args[parameter.name] = parameter.value;
		parameterCount += 1;
		cursor = parameter.end;
	}
	if (parameterCount === 0) return null;
	const end = opening.allowsOptionalXmlishClose ? consumeOptionalXmlishFunctionClose(text, cursor) : consumeXmlishFunctionClose(text, cursor);
	if (end === null) return null;
	return {
		arguments: args,
		end,
		name: opening.name,
		raw: text.slice(start, end),
		start
	};
}
function parseStandalonePlainTextToolCallBlocks(text, options) {
	const blocks = [];
	let cursor = skipWhitespace(text, 0);
	while (cursor < text.length) {
		const block = parsePlainTextToolCallBlockAt(text, cursor, options) ?? parseXmlishPlainTextToolCallBlockAt(text, cursor, options);
		if (!block) return null;
		blocks.push(block);
		cursor = skipWhitespace(text, block.end);
	}
	return blocks.length > 0 ? blocks : null;
}
/** Removes full-line standalone plain-text tool-call blocks from user-visible text. */
function stripPlainTextToolCallBlocks(text) {
	if (!text || !/\[(?:tool:)?[A-Za-z0-9_-]+\]/.test(text) && !/(?:^|\n)\s*(?:<\|channel\|>)?(?:commentary|analysis|final)\s+to=/.test(text) && !/(?:^|\n)\s*<function=[A-Za-z0-9_.:-]{1,120}>/i.test(text)) return text;
	let result = "";
	let cursor = 0;
	let index = 0;
	while (index < text.length) {
		if (!(index === 0 || text[index - 1] === "\n")) {
			index += 1;
			continue;
		}
		const blockStart = skipHorizontalWhitespace(text, index);
		const blockEnd = parsePlainTextToolCallBlockAt(text, blockStart)?.end ?? parseXmlishPlainTextToolCallBlockEndAt(text, blockStart);
		if (blockEnd === null) {
			index += 1;
			continue;
		}
		result += text.slice(cursor, index);
		cursor = blockEnd;
		const afterBlockLineBreak = consumeLineBreak(text, cursor);
		if (afterBlockLineBreak !== null) cursor = afterBlockLineBreak;
		index = cursor;
	}
	result += text.slice(cursor);
	return result;
}
//#endregion
//#region packages/tool-call-repair/src/stream-normalizer.ts
const TEXT_TOOL_CALL_BUFFER_MAX_CHARS = 256e3;
const TEXT_TOOL_CALL_SUPPRESSED_SCAN_MAX_CHARS = 32e4;
function asRecord$1(value) {
	return value && typeof value === "object" ? value : void 0;
}
function couldStillBeJsonPayload(text, start) {
	let cursor = start;
	while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
	return cursor >= text.length || text[cursor] === "{";
}
function couldStillBeXmlishParameterPayload(text, start) {
	let cursor = start;
	while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
	if (cursor >= text.length) return true;
	return matchesLiteralPrefix(text.slice(cursor).toLowerCase(), "<parameter=");
}
function couldStillBeBracketedStandaloneToolCall(text, matcher) {
	if (!text.startsWith("[")) return false;
	if (matchesLiteralPrefix(text, "[tool:")) {
		if (text.length <= 6) return true;
		let cursor = 6;
		while (isPlainTextToolNameChar(text[cursor])) cursor += 1;
		const name = text.slice(6, cursor);
		if (!name || !matcher.hasNamePrefix(name)) return false;
		if (cursor >= text.length) return true;
		if (text[cursor] !== "]") return false;
		if (!matcher.hasExactName(name)) return false;
		return couldStillBeJsonPayload(text, cursor + 1) || couldStillBeXmlishParameterPayload(text, cursor + 1);
	}
	let cursor = 1;
	while (isPlainTextToolNameChar(text[cursor])) cursor += 1;
	const name = text.slice(1, cursor);
	if (!name || !matcher.hasNamePrefix(name)) return false;
	if (cursor >= text.length) return true;
	if (text[cursor] !== "]") return false;
	if (!matcher.hasExactName(name)) return false;
	cursor += 1;
	while (text[cursor] === " " || text[cursor] === "	") cursor += 1;
	if (cursor >= text.length) return true;
	if (text[cursor] === "\r") {
		if (cursor + 1 >= text.length) return true;
		const payloadStart = text[cursor + 1] === "\n" ? cursor + 2 : cursor + 1;
		return couldStillBeJsonPayload(text, payloadStart) || couldStillBeXmlishParameterPayload(text, payloadStart);
	}
	if (text[cursor] !== "\n") return false;
	return couldStillBeJsonPayload(text, cursor + 1) || couldStillBeXmlishParameterPayload(text, cursor + 1);
}
function couldStillBeXmlishFunctionToolCall(text, matcher) {
	if (!matchesLiteralPrefix(text.toLowerCase(), "<function=")) return false;
	if (text.length <= 10) return true;
	let cursor = 10;
	while (isXmlishNameChar(text[cursor])) cursor += 1;
	const name = text.slice(10, cursor);
	if (!name || !matcher.hasNamePrefix(name)) return false;
	if (cursor >= text.length) return true;
	if (text[cursor] !== ">") return false;
	if (!matcher.hasExactName(name)) return false;
	return couldStillBeXmlishParameterPayload(text, cursor + 1);
}
function couldStillBeHarmonyStandaloneToolCall(text, matcher) {
	const channelMarker = "<|channel|>";
	let cursor = 0;
	if (matchesLiteralPrefix(text, channelMarker)) {
		if (text.length <= 11) return true;
		cursor = 11;
	}
	const rest = text.slice(cursor);
	const channel = [
		"commentary",
		"analysis",
		"final"
	].find((candidate) => matchesLiteralPrefix(rest, candidate));
	if (!channel) return false;
	if (rest.length <= channel.length) return true;
	cursor += channel.length;
	while (text[cursor] === " " || text[cursor] === "	") cursor += 1;
	if (cursor >= text.length) return true;
	const toMarker = "to=";
	const toRest = text.slice(cursor);
	if (!matchesLiteralPrefix(toRest, toMarker)) return false;
	if (toRest.length <= 3) return true;
	cursor += 3;
	const nameStart = cursor;
	while (isPlainTextToolNameChar(text[cursor])) cursor += 1;
	const name = text.slice(nameStart, cursor);
	if (!name || !matcher.hasNamePrefix(name)) return false;
	if (cursor >= text.length) return true;
	while (text[cursor] === " " || text[cursor] === "	") cursor += 1;
	if (cursor >= text.length) return true;
	if (!matcher.hasExactName(name)) return false;
	const codeMarker = "code";
	const codeRest = text.slice(cursor);
	if (!matchesLiteralPrefix(codeRest, codeMarker)) return false;
	if (codeRest.length <= 4) return true;
	cursor += 4;
	while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
	if (cursor >= text.length) return true;
	if (matchesLiteralPrefix(text.slice(cursor), "<|message|>")) return true;
	return text[cursor] === "{";
}
function hasExactSerializedToolCallPrefix(text, matcher) {
	const bracketed = /^\[(?:tool:)?([A-Za-z0-9_-]+)\]/.exec(text);
	if (bracketed?.[1]) return matcher.hasExactName(bracketed[1]);
	const xmlish = /^<function=([A-Za-z0-9_.:-]+)>/i.exec(text);
	if (xmlish?.[1]) return matcher.hasExactName(xmlish[1]);
	const harmony = /^(?:<\|channel\|>)?(?:commentary|analysis|final)\s+to=([A-Za-z0-9_-]+)\s+code\b/.exec(text);
	return Boolean(harmony?.[1] && matcher.hasExactName(harmony[1]));
}
function stripCompleteSerializedToolCallPrefix(text, matcher) {
	if (matcher && !hasExactSerializedToolCallPrefix(text, matcher)) return null;
	const xmlishEnd = findXmlishToolCallEnd(text);
	if (xmlishEnd !== null) return text.slice(xmlishEnd);
	const jsonStart = findBracketedJsonPayloadStart(text) ?? findHarmonyJsonPayloadStart(text);
	if (jsonStart === null) return null;
	const jsonEnd = findJsonObjectEnd(text, jsonStart);
	if (jsonEnd === null) return null;
	return text.slice(consumeJsonToolClosingMarker(text, jsonEnd));
}
function stripSerializedToolCallPrefixes(text, matcher) {
	let current = text;
	let changed = false;
	for (let count = 0; count < 32; count += 1) {
		const next = stripCompleteSerializedToolCallPrefix(current.trimStart(), matcher);
		if (next === null) {
			if (changed && hasExactSerializedToolCallPrefix(current.trimStart(), matcher)) return "";
			return changed ? current : null;
		}
		changed = true;
		current = next;
		if (!current.trim()) return current;
	}
	return hasExactSerializedToolCallPrefix(current.trimStart(), matcher) ? "" : current;
}
function getPlainTextToolCallBufferState(text, matcher) {
	const trimmed = text.trimStart();
	if (trimmed.length === 0) return text.length > TEXT_TOOL_CALL_BUFFER_MAX_CHARS ? "impossible" : "possible";
	if (!(couldStillBeBracketedStandaloneToolCall(trimmed, matcher) || couldStillBeXmlishFunctionToolCall(trimmed, matcher) || couldStillBeHarmonyStandaloneToolCall(trimmed, matcher))) return "impossible";
	if (text.length <= TEXT_TOOL_CALL_BUFFER_MAX_CHARS) return "possible";
	const textAfterCompleteToolBlocks = stripSerializedToolCallPrefixes(trimmed, matcher);
	return textAfterCompleteToolBlocks !== null && textAfterCompleteToolBlocks.trim() ? "impossible" : "over-cap";
}
function getTextToolCallEventText(event) {
	if (typeof event.delta === "string") return event.delta;
	return typeof event.content === "string" ? event.content : void 0;
}
function appendTextToolCallBuffer(bufferedText, event) {
	const text = getTextToolCallEventText(event);
	if (text === void 0) return bufferedText;
	if (typeof event.content === "string" && !bufferedText) return text;
	return typeof event.delta === "string" ? bufferedText + text : bufferedText;
}
function hasSuppressedToolCallClosingMarker(text) {
	if (!text) return false;
	const lowerText = text.toLowerCase();
	return lowerText.includes("</parameter>") || lowerText.includes("</function>") || text.includes("[END_TOOL_REQUEST]") || text.includes("<|call|>") || text.includes("}") || /\[\/[A-Za-z0-9_.:-]+\]/.test(text);
}
function shouldRescanSuppressedTextToolCallBuffer(previousBufferedText, event) {
	const eventText = getTextToolCallEventText(event);
	if (!eventText) return false;
	return hasSuppressedToolCallClosingMarker(previousBufferedText.slice(-2048) + eventText);
}
function truncateSuppressedTextToolCallBuffer(text) {
	if (text.length <= TEXT_TOOL_CALL_SUPPRESSED_SCAN_MAX_CHARS) return text;
	return text.slice(0, TEXT_TOOL_CALL_BUFFER_MAX_CHARS) + text.slice(-64e3);
}
function appendSuppressedTextToolCallBuffer(bufferedText, event) {
	const nextText = appendTextToolCallBuffer(bufferedText, event);
	if (nextText === bufferedText) return {
		changed: false,
		scanText: bufferedText,
		text: bufferedText
	};
	return {
		changed: true,
		scanText: nextText,
		text: truncateSuppressedTextToolCallBuffer(nextText)
	};
}
function shouldSuppressBufferedTextBlock(blockText, bufferedText) {
	const normalizedBlock = blockText.trim();
	const normalizedBuffer = bufferedText.trim();
	const normalizedSuppressedPrefix = bufferedText.slice(0, TEXT_TOOL_CALL_BUFFER_MAX_CHARS).trim();
	return Boolean(normalizedBlock && normalizedBuffer) && (normalizedBuffer.startsWith(normalizedBlock) || normalizedBlock.startsWith(normalizedBuffer) || bufferedText.length >= TEXT_TOOL_CALL_SUPPRESSED_SCAN_MAX_CHARS && Boolean(normalizedSuppressedPrefix) && normalizedBlock.startsWith(normalizedSuppressedPrefix));
}
function scrubBufferedTextFromContent(content, bufferedText, matcher, options) {
	if (Array.isArray(content)) {
		if (typeof options?.onlyTextIndex === "number") {
			const block = content[options.onlyTextIndex];
			const record = asRecord$1(block);
			if (record?.type !== "text" || typeof record.text !== "string" || !shouldSuppressBufferedTextBlock(record.text, bufferedText)) return {
				changed: false,
				content
			};
			const nextContent = [...content];
			if (options.preserveEmptyTextBlocks) nextContent[options.onlyTextIndex] = {
				...record,
				text: ""
			};
			else nextContent.splice(options.onlyTextIndex, 1);
			return {
				changed: true,
				content: nextContent
			};
		}
		const overCapPrefix = scrubOverCapTextPrefixFromContent(content, matcher, options);
		if (overCapPrefix.changed) return overCapPrefix;
		let changed = false;
		const nextContent = content.flatMap((block) => {
			const record = asRecord$1(block);
			if (record?.type === "text" && typeof record.text === "string" && shouldSuppressBufferedTextBlock(record.text, bufferedText)) {
				changed = true;
				return options?.preserveEmptyTextBlocks ? [{
					...record,
					text: ""
				}] : [];
			}
			return [block];
		});
		return changed ? {
			changed,
			content: nextContent
		} : {
			changed: false,
			content
		};
	}
	if (typeof content === "string" && shouldSuppressBufferedTextBlock(content, bufferedText)) return {
		changed: true,
		content: ""
	};
	return {
		changed: false,
		content
	};
}
function scrubOverCapTextPrefixFromContent(content, matcher, options) {
	let currentContent = content;
	let changed = false;
	for (let count = 0; count < 32; count += 1) {
		const scrubbed = scrubFirstOverCapTextPrefixFromContent(currentContent, matcher, options);
		if (!scrubbed.changed || !Array.isArray(scrubbed.content)) return changed ? {
			changed: true,
			content: currentContent
		} : scrubbed;
		currentContent = scrubbed.content;
		changed = true;
	}
	return {
		changed,
		content: currentContent
	};
}
function scrubFirstOverCapTextPrefixFromContent(content, matcher, options) {
	const suppressedTextIndexes = /* @__PURE__ */ new Set();
	let accumulated = "";
	let reachedOverCap = false;
	for (let index = 0; index < content.length; index += 1) {
		const record = asRecord$1(content[index]);
		if (record?.type !== "text" || typeof record.text !== "string") continue;
		if (!record.text.trim()) continue;
		if (!accumulated && !hasExactSerializedToolCallPrefix(record.text.trimStart(), matcher)) continue;
		if (reachedOverCap && hasExactSerializedToolCallPrefix(record.text.trimStart(), matcher)) break;
		if (reachedOverCap && suppressedTextIndexes.size === 1 && !hasSuppressedToolCallClosingMarker(record.text)) break;
		accumulated = accumulated ? `${accumulated}\n${record.text}` : record.text;
		suppressedTextIndexes.add(index);
		const state = getPlainTextToolCallBufferState(accumulated, matcher);
		if (state === "over-cap") {
			reachedOverCap = true;
			const strippedSuffix = stripSerializedToolCallPrefixes(accumulated, matcher);
			if (strippedSuffix !== null) return scrubSuppressedTextIndexesFromContent(content, suppressedTextIndexes, options, strippedSuffix, index);
			continue;
		}
		if (state === "impossible") {
			if (reachedOverCap) {
				const strippedSuffix = stripSerializedToolCallPrefixes(accumulated, matcher);
				if (strippedSuffix !== null) return scrubSuppressedTextIndexesFromContent(content, suppressedTextIndexes, options, strippedSuffix, index);
				return scrubSuppressedTextIndexesFromContent(content, suppressedTextIndexes, options);
			}
			accumulated = "";
			suppressedTextIndexes.clear();
			reachedOverCap = false;
		}
	}
	if (reachedOverCap) return scrubSuppressedTextIndexesFromContent(content, suppressedTextIndexes, options);
	return {
		changed: false,
		content
	};
}
function scrubSuppressedTextIndexesFromContent(content, suppressedTextIndexes, options, visibleSuffix, visibleSuffixIndex) {
	return {
		changed: true,
		content: content.flatMap((block, blockIndex) => {
			if (!suppressedTextIndexes.has(blockIndex)) return [block];
			const blockRecord = asRecord$1(block);
			if (visibleSuffixIndex === blockIndex && visibleSuffix !== void 0 && visibleSuffix.trim() && blockRecord) return [{
				...blockRecord,
				text: visibleSuffix
			}];
			return options?.preserveEmptyTextBlocks && blockRecord ? [{
				...blockRecord,
				text: ""
			}] : [];
		})
	};
}
function stripPlainTextToolCallsFromContent(content, matcher, options) {
	if (Array.isArray(content)) {
		const textBlocks = content.map((block, index) => ({
			index,
			record: asRecord$1(block)
		})).filter((entry) => entry.record?.type === "text" && typeof entry.record.text === "string");
		const joinedText = textBlocks.map((entry) => String(entry.record.text)).join("\n");
		if (joinedText.trim()) {
			const strippedJoined = stripSerializedToolCallPrefixes(joinedText.trim(), matcher);
			if (strippedJoined !== null && strippedJoined !== joinedText) {
				const firstTextIndex = textBlocks[0]?.index;
				return {
					changed: true,
					content: content.flatMap((block, index) => {
						const record = asRecord$1(block);
						if (record?.type !== "text" || typeof record.text !== "string") return [block];
						if (options?.preserveEmptyTextBlocks) return [{
							...record,
							text: index === firstTextIndex && strippedJoined.trim() ? strippedJoined : ""
						}];
						return index === firstTextIndex && strippedJoined.trim() ? [{
							...record,
							text: strippedJoined
						}] : [];
					})
				};
			}
		}
		let changed = false;
		const nextContent = [];
		for (const block of content) {
			const record = asRecord$1(block);
			if (record?.type !== "text" || typeof record.text !== "string") {
				nextContent.push(block);
				continue;
			}
			const strippedText = stripSerializedToolCallPrefixes(record.text, matcher);
			if (strippedText === null || strippedText === record.text) {
				nextContent.push(block);
				continue;
			}
			changed = true;
			if (strippedText.trim()) nextContent.push({
				...record,
				text: strippedText
			});
			else if (options?.preserveEmptyTextBlocks) nextContent.push({
				...record,
				text: ""
			});
		}
		return changed ? {
			changed,
			content: nextContent
		} : {
			changed: false,
			content
		};
	}
	if (typeof content === "string") {
		const strippedText = stripSerializedToolCallPrefixes(content, matcher);
		if (strippedText !== null && strippedText !== content) return {
			changed: true,
			content: strippedText
		};
	}
	return {
		changed: false,
		content
	};
}
function stripOverCapPlainTextToolCallsFromContent(content, matcher, options) {
	if (Array.isArray(content)) {
		let changed = false;
		const nextContent = [];
		for (const block of content) {
			const record = asRecord$1(block);
			if (record?.type !== "text" || typeof record.text !== "string" || record.text.length <= TEXT_TOOL_CALL_BUFFER_MAX_CHARS) {
				nextContent.push(block);
				continue;
			}
			const strippedText = stripSerializedToolCallPrefixes(record.text, matcher);
			if (strippedText === null || strippedText === record.text) {
				nextContent.push(block);
				continue;
			}
			changed = true;
			if (strippedText.trim()) nextContent.push({
				...record,
				text: strippedText
			});
			else if (options?.preserveEmptyTextBlocks) nextContent.push({
				...record,
				text: ""
			});
		}
		return changed ? {
			changed,
			content: nextContent
		} : {
			changed: false,
			content
		};
	}
	if (typeof content === "string" && content.length > TEXT_TOOL_CALL_BUFFER_MAX_CHARS) {
		const strippedText = stripSerializedToolCallPrefixes(content, matcher);
		if (strippedText !== null && strippedText !== content) return {
			changed: true,
			content: strippedText
		};
	}
	return {
		changed: false,
		content
	};
}
function scrubPlainTextToolCallContent(content, bufferedText, matcher, options) {
	const scrubbed = scrubBufferedTextFromContent(content, bufferedText, matcher, options);
	const stripped = options?.onlyTextIndex === void 0 ? stripPlainTextToolCallsFromContent(scrubbed.content, matcher, options) : {
		changed: false,
		content: scrubbed.content
	};
	return stripped.changed ? stripped : scrubbed;
}
function shouldPreserveEmptyTextBlocksForEventIndex(content, bufferedText, matcher, eventContentIndex) {
	if (typeof eventContentIndex !== "number" || !Number.isInteger(eventContentIndex) || eventContentIndex < 0 || !Array.isArray(content)) return false;
	const currentBlock = content[eventContentIndex];
	if (currentBlock === void 0) return false;
	const scrubbed = scrubPlainTextToolCallContent(content, bufferedText, matcher);
	return scrubbed.changed && Array.isArray(scrubbed.content) && scrubbed.content[eventContentIndex] !== currentBlock;
}
function scrubBufferedTextFromPartial(event, bufferedText, matcher, contentIndex, options) {
	const partial = asRecord$1(event.partial);
	if (!partial) return event;
	const preserveEmptyTextBlocks = options?.preserveEmptyTextBlocks === true || shouldPreserveEmptyTextBlocksForEventIndex(partial.content, bufferedText, matcher, event.contentIndex);
	const scrubbed = scrubPlainTextToolCallContent(partial.content, bufferedText, matcher, {
		onlyTextIndex: contentIndex,
		preserveEmptyTextBlocks
	});
	if (!scrubbed.changed) return event;
	return {
		...event,
		partial: {
			...partial,
			content: scrubbed.content
		}
	};
}
function scrubBufferedTextFromMessage(event, bufferedText, matcher, contentIndex) {
	const message = asRecord$1(event.message);
	if (!message) return event;
	const scrubbed = scrubPlainTextToolCallContent(message.content, bufferedText, matcher, { onlyTextIndex: contentIndex });
	if (!scrubbed.changed) return event;
	return {
		...event,
		message: {
			...message,
			content: scrubbed.content
		}
	};
}
function scrubBufferedTextFromError(event, bufferedText, matcher, contentIndex) {
	const error = asRecord$1(event.error);
	if (!error) return event;
	const scrubbed = scrubPlainTextToolCallContent(error.content, bufferedText, matcher, { onlyTextIndex: contentIndex });
	if (!scrubbed.changed) return event;
	return {
		...event,
		error: {
			...error,
			content: scrubbed.content
		}
	};
}
function replaceTextContentWithVisibleSuffix(record, visibleText, contentIndex, matcher) {
	if (typeof record.content === "string") return {
		...record,
		content: visibleText
	};
	if (!Array.isArray(record.content)) return record;
	const originalContent = record.content;
	if (typeof contentIndex === "number") {
		const content = originalContent.flatMap((block, index) => {
			if (index !== contentIndex) return [block];
			const blockRecord = asRecord$1(block);
			if (blockRecord?.type !== "text" || typeof blockRecord.text !== "string") return [block];
			if (matcher && !hasExactSerializedToolCallPrefix(blockRecord.text.trimStart(), matcher)) return [block];
			return visibleText.trim() ? [{
				...blockRecord,
				text: visibleText
			}] : [];
		});
		if (matcher && content.every((block, index) => block === originalContent[index])) return replaceTextContentWithVisibleSuffix(record, visibleText, void 0, matcher);
		return {
			...record,
			content
		};
	}
	if (originalContent.filter((block) => {
		const blockRecord = asRecord$1(block);
		return blockRecord?.type === "text" && typeof blockRecord.text === "string";
	}).length !== 1) {
		if (!matcher) return record;
		let replaced = false;
		const content = originalContent.flatMap((block) => {
			const blockRecord = asRecord$1(block);
			if (blockRecord?.type !== "text" || typeof blockRecord.text !== "string") return [block];
			if (replaced) return [block];
			if (!hasExactSerializedToolCallPrefix(blockRecord.text.trimStart(), matcher)) return [block];
			replaced = true;
			return visibleText.trim() ? [{
				...blockRecord,
				text: visibleText
			}] : [];
		});
		return replaced ? {
			...record,
			content
		} : record;
	}
	let replaced = false;
	const content = originalContent.flatMap((block) => {
		const blockRecord = asRecord$1(block);
		if (blockRecord?.type !== "text" || typeof blockRecord.text !== "string") return [block];
		if (replaced) return [];
		replaced = true;
		return visibleText.trim() ? [{
			...blockRecord,
			text: visibleText
		}] : [];
	});
	return {
		...record,
		content
	};
}
function scrubReclassifiedMixedTextFromPartial(event, visibleText, contentIndex, matcher) {
	const partial = asRecord$1(event.partial);
	if (!partial) return event;
	return {
		...event,
		partial: replaceTextContentWithVisibleSuffix(partial, visibleText, contentIndex, matcher)
	};
}
function scrubReclassifiedMixedTextFromError(event, visibleText, contentIndex, matcher) {
	const error = asRecord$1(event.error);
	if (!error) return event;
	return {
		...event,
		error: replaceTextContentWithVisibleSuffix(error, visibleText, contentIndex, matcher)
	};
}
/** Scrubs final messages whose streamed plain-text tool-call prefix exceeded the buffer cap. */
function scrubOverCapPlainTextToolCallMessage(params) {
	const record = asRecord$1(params.message);
	const candidateText = params.candidateText;
	if (!record || !candidateText) return;
	const bufferState = getPlainTextToolCallBufferState(candidateText, params.matcher);
	if (bufferState === "impossible") {
		if (candidateText.length <= TEXT_TOOL_CALL_BUFFER_MAX_CHARS) return;
		const visibleText = stripSerializedToolCallPrefixes(candidateText, params.matcher);
		if (visibleText?.trim() && !Array.isArray(record.content)) {
			const replaced = replaceTextContentWithVisibleSuffix(record, visibleText, void 0, params.matcher);
			if (replaced !== record) return replaced;
		}
		if (Array.isArray(record.content)) {
			const overCap = scrubOverCapTextPrefixFromContent(record.content, params.matcher);
			const stripped = stripOverCapPlainTextToolCallsFromContent(overCap.content, params.matcher);
			if (!overCap.changed && !stripped.changed) return;
			return {
				...record,
				content: stripped.changed ? stripped.content : overCap.content
			};
		}
		return;
	}
	if (bufferState !== "over-cap") return;
	const scrubbed = scrubPlainTextToolCallContent(record.content, candidateText, params.matcher);
	return {
		...record,
		content: scrubbed.content
	};
}
function createScrubbedTextDeltaEvent(event, text) {
	const partial = asRecord$1(event.partial);
	const syntheticContent = typeof event.contentIndex === "number" ? Array.from({ length: event.contentIndex + 1 }, (_, index) => ({
		type: "text",
		text: index === event.contentIndex ? text : ""
	})) : [{
		type: "text",
		text
	}];
	const scrubbedPartial = partial ? replaceTextContentWithVisibleSuffix(partial, text, event.contentIndex) : {
		role: "assistant",
		content: syntheticContent
	};
	const eventWithoutTextEndContent = { ...event };
	delete eventWithoutTextEndContent.content;
	return {
		...eventWithoutTextEndContent,
		type: "text_delta",
		delta: text,
		partial: scrubbedPartial
	};
}
function appendReclassifiedVisibleDelta(visibleText, event) {
	return typeof event.delta === "string" ? `${visibleText}${event.delta}` : visibleText;
}
function isAllowedTextToolCallLikeEvent(event, matcher) {
	const text = getTextToolCallEventText(event);
	return Boolean(text?.trim() && getPlainTextToolCallBufferState(text, matcher) !== "impossible");
}
function isBufferedTextEvent(bufferedEvent) {
	const bufferedRecord = asRecord$1(bufferedEvent);
	const bufferedType = typeof bufferedRecord?.type === "string" ? bufferedRecord.type : "";
	return bufferedType === "text_start" || bufferedType === "text_delta" || bufferedType === "text_end";
}
/** Buffers provider stream text long enough to promote or hide leaked plain-text tool calls. */
async function* normalizePlainTextToolCallStreamEvents(source, options) {
	const bufferedEvents = [];
	let bufferedText = "";
	let suppressingOverCapTextToolCall = false;
	let suppressedTextContentIndex;
	let hasSuppressedTextContentIndex = false;
	let reclassifiedMixedTextContentIndex;
	let hasReclassifiedMixedTextContentIndex = false;
	let scrubReclassifiedMixedTextFromDone = false;
	let reclassifiedMixedVisibleText;
	const flushBufferedEvents = () => {
		const events = bufferedEvents.splice(0);
		bufferedText = "";
		return events;
	};
	function* flushScrubbedBufferedNonTextEvents(resetBufferedText) {
		const events = bufferedEvents.splice(0);
		const textToScrub = bufferedText;
		if (resetBufferedText) bufferedText = "";
		for (const bufferedEvent of events) {
			if (isBufferedTextEvent(bufferedEvent)) continue;
			const bufferedRecord = asRecord$1(bufferedEvent);
			yield bufferedRecord ? scrubBufferedTextFromPartial(bufferedRecord, textToScrub, options.matcher, hasSuppressedTextContentIndex ? suppressedTextContentIndex : void 0, { preserveEmptyTextBlocks: suppressingOverCapTextToolCall }) : bufferedEvent;
		}
	}
	function* suppressBufferedTextEvents() {
		suppressingOverCapTextToolCall = true;
		yield* flushScrubbedBufferedNonTextEvents(false);
	}
	for await (const event of source) {
		const record = asRecord$1(event);
		if (!record) {
			yield event;
			continue;
		}
		const type = typeof record.type === "string" ? record.type : "";
		if (type === "text_start" || type === "text_delta" || type === "text_end") {
			if (type === "text_end" && hasReclassifiedMixedTextContentIndex && record.contentIndex === reclassifiedMixedTextContentIndex) continue;
			if (scrubReclassifiedMixedTextFromDone && reclassifiedMixedVisibleText !== void 0 && hasReclassifiedMixedTextContentIndex && record.contentIndex === reclassifiedMixedTextContentIndex) {
				reclassifiedMixedVisibleText = appendReclassifiedVisibleDelta(reclassifiedMixedVisibleText, record);
				yield scrubReclassifiedMixedTextFromPartial(record, reclassifiedMixedVisibleText, reclassifiedMixedTextContentIndex, options.matcher);
				continue;
			}
			if (suppressingOverCapTextToolCall) {
				if (hasSuppressedTextContentIndex && record.contentIndex !== suppressedTextContentIndex) {
					if (isAllowedTextToolCallLikeEvent(record, options.matcher)) continue;
					yield scrubBufferedTextFromPartial(record, bufferedText, options.matcher, suppressedTextContentIndex, { preserveEmptyTextBlocks: true });
					continue;
				}
				const previousBufferedText = bufferedText;
				const appended = appendSuppressedTextToolCallBuffer(bufferedText, record);
				bufferedText = appended.text;
				if ((appended.changed && shouldRescanSuppressedTextToolCallBuffer(previousBufferedText, record) ? getPlainTextToolCallBufferState(appended.scanText, options.matcher) : "over-cap") === "impossible") {
					const visibleText = stripSerializedToolCallPrefixes(appended.scanText, options.matcher) ?? "";
					yield* flushScrubbedBufferedNonTextEvents(true);
					suppressingOverCapTextToolCall = false;
					suppressedTextContentIndex = void 0;
					hasSuppressedTextContentIndex = false;
					reclassifiedMixedTextContentIndex = record.contentIndex;
					hasReclassifiedMixedTextContentIndex = true;
					scrubReclassifiedMixedTextFromDone = true;
					reclassifiedMixedVisibleText = visibleText;
					if (visibleText.trim()) yield createScrubbedTextDeltaEvent(record, visibleText);
				}
				continue;
			}
			bufferedEvents.push(event);
			bufferedText = appendTextToolCallBuffer(bufferedText, record);
			const scanBufferedText = truncateSuppressedTextToolCallBuffer(bufferedText);
			const scanWasTruncated = scanBufferedText.length !== bufferedText.length;
			const bufferState = getPlainTextToolCallBufferState(scanBufferedText, options.matcher);
			if (bufferState === "impossible") {
				const visibleText = !scanWasTruncated && bufferedText.length > TEXT_TOOL_CALL_BUFFER_MAX_CHARS ? stripSerializedToolCallPrefixes(bufferedText.trimStart(), options.matcher) : null;
				if (visibleText?.trim()) {
					yield* flushScrubbedBufferedNonTextEvents(true);
					reclassifiedMixedTextContentIndex = record.contentIndex;
					hasReclassifiedMixedTextContentIndex = true;
					scrubReclassifiedMixedTextFromDone = true;
					reclassifiedMixedVisibleText = visibleText;
					yield createScrubbedTextDeltaEvent(record, visibleText);
				} else if (scanWasTruncated && stripSerializedToolCallPrefixes(scanBufferedText.trimStart(), options.matcher) !== null) {
					bufferedText = scanBufferedText;
					suppressedTextContentIndex = record.contentIndex;
					hasSuppressedTextContentIndex = true;
					yield* suppressBufferedTextEvents();
				} else yield* flushBufferedEvents();
			} else if (bufferState === "over-cap") {
				bufferedText = scanBufferedText;
				suppressedTextContentIndex = record.contentIndex;
				hasSuppressedTextContentIndex = true;
				yield* suppressBufferedTextEvents();
			}
			continue;
		}
		if (type === "done") {
			const normalizedMessage = options.normalizeDoneMessage({
				message: record.message,
				reason: record.reason
			});
			if (normalizedMessage?.kind === "promoted") {
				yield* flushScrubbedBufferedNonTextEvents(true);
				suppressingOverCapTextToolCall = false;
				suppressedTextContentIndex = void 0;
				hasSuppressedTextContentIndex = false;
				scrubReclassifiedMixedTextFromDone = false;
				reclassifiedMixedTextContentIndex = void 0;
				hasReclassifiedMixedTextContentIndex = false;
				reclassifiedMixedVisibleText = void 0;
				yield* options.createPromotedToolCallEvents(normalizedMessage.message);
				yield {
					...record,
					reason: "toolUse",
					message: normalizedMessage.message
				};
				if (options.stopAfterDone) return;
				continue;
			}
			if (normalizedMessage?.kind === "scrubbed") {
				yield* flushScrubbedBufferedNonTextEvents(true);
				suppressingOverCapTextToolCall = false;
				suppressedTextContentIndex = void 0;
				hasSuppressedTextContentIndex = false;
				scrubReclassifiedMixedTextFromDone = false;
				reclassifiedMixedTextContentIndex = void 0;
				hasReclassifiedMixedTextContentIndex = false;
				reclassifiedMixedVisibleText = void 0;
				yield {
					...record,
					message: normalizedMessage.message
				};
				if (options.stopAfterDone) return;
				continue;
			}
			const mixedMessageRecord = scrubReclassifiedMixedTextFromDone ? asRecord$1(record.message) : void 0;
			const strippedMixedMessage = mixedMessageRecord && reclassifiedMixedVisibleText !== void 0 ? replaceTextContentWithVisibleSuffix(mixedMessageRecord, reclassifiedMixedVisibleText, hasReclassifiedMixedTextContentIndex ? reclassifiedMixedTextContentIndex : void 0, options.matcher) : void 0;
			if (strippedMixedMessage) {
				yield* flushScrubbedBufferedNonTextEvents(true);
				scrubReclassifiedMixedTextFromDone = false;
				reclassifiedMixedTextContentIndex = void 0;
				hasReclassifiedMixedTextContentIndex = false;
				reclassifiedMixedVisibleText = void 0;
				yield {
					...record,
					message: strippedMixedMessage
				};
				if (options.stopAfterDone) return;
				continue;
			}
			if (suppressingOverCapTextToolCall) {
				const scrubbedDoneEvent = scrubBufferedTextFromMessage(record, bufferedText, options.matcher, hasSuppressedTextContentIndex ? suppressedTextContentIndex : void 0);
				yield* flushScrubbedBufferedNonTextEvents(true);
				suppressingOverCapTextToolCall = false;
				suppressedTextContentIndex = void 0;
				hasSuppressedTextContentIndex = false;
				scrubReclassifiedMixedTextFromDone = false;
				reclassifiedMixedTextContentIndex = void 0;
				hasReclassifiedMixedTextContentIndex = false;
				reclassifiedMixedVisibleText = void 0;
				yield scrubbedDoneEvent;
				if (options.stopAfterDone) return;
				continue;
			}
			yield* flushBufferedEvents();
			yield event;
			if (options.stopAfterDone) return;
			continue;
		}
		if (type === "error") {
			if (!suppressingOverCapTextToolCall) yield* flushBufferedEvents();
			yield suppressingOverCapTextToolCall ? scrubBufferedTextFromError(scrubBufferedTextFromPartial(record, bufferedText, options.matcher, hasSuppressedTextContentIndex ? suppressedTextContentIndex : void 0, { preserveEmptyTextBlocks: true }), bufferedText, options.matcher, hasSuppressedTextContentIndex ? suppressedTextContentIndex : void 0) : scrubReclassifiedMixedTextFromDone && reclassifiedMixedVisibleText !== void 0 ? scrubReclassifiedMixedTextFromError(scrubReclassifiedMixedTextFromPartial(record, reclassifiedMixedVisibleText, hasReclassifiedMixedTextContentIndex ? reclassifiedMixedTextContentIndex : void 0, options.matcher), reclassifiedMixedVisibleText, hasReclassifiedMixedTextContentIndex ? reclassifiedMixedTextContentIndex : void 0, options.matcher) : event;
			return;
		}
		if (scrubReclassifiedMixedTextFromDone && reclassifiedMixedVisibleText !== void 0) {
			yield scrubReclassifiedMixedTextFromPartial(record, reclassifiedMixedVisibleText, hasReclassifiedMixedTextContentIndex ? reclassifiedMixedTextContentIndex : void 0, options.matcher);
			continue;
		}
		if (bufferedEvents.length > 0 && !suppressingOverCapTextToolCall) {
			bufferedEvents.push(event);
			continue;
		}
		yield suppressingOverCapTextToolCall ? scrubBufferedTextFromPartial(record, bufferedText, options.matcher, hasSuppressedTextContentIndex ? suppressedTextContentIndex : void 0, { preserveEmptyTextBlocks: suppressingOverCapTextToolCall }) : event;
	}
	if (!suppressingOverCapTextToolCall) yield* flushBufferedEvents();
}
//#endregion
//#region packages/tool-call-repair/src/promote.ts
function asRecord(value) {
	return value && typeof value === "object" ? value : void 0;
}
function resolveExactToolName(rawName, allowedToolNames) {
	return allowedToolNames.has(rawName) ? rawName : null;
}
function createPromotedToolCallBlocks(text, options) {
	const parsedBlocks = parseStandalonePlainTextToolCallBlocks(text);
	if (!parsedBlocks) return;
	const resolveToolName = options.resolveToolName ?? resolveExactToolName;
	const toolCalls = [];
	for (const block of parsedBlocks) {
		const resolvedName = resolveToolName(block.name, options.allowedToolNames);
		if (!resolvedName) return;
		toolCalls.push(options.createToolCallBlock(block, resolvedName));
	}
	return toolCalls;
}
function createPromotedToolCallBlocksFromTextParts(textParts, options) {
	const exactText = textParts.join("").trim();
	if (!exactText) return [];
	for (const text of createTextPartPromotionCandidates(textParts, exactText)) {
		const toolCalls = createPromotedToolCallBlocks(text, options);
		if (toolCalls) return toolCalls;
	}
}
function createTextPartPromotionCandidates(textParts, exactText) {
	const repairedText = joinTextPartsWithStructuralLineBreaks(textParts).trim();
	const newlineJoinedText = textParts.join("\n").trim();
	return [...new Set([
		repairedText,
		exactText,
		newlineJoinedText
	].filter(Boolean))];
}
function joinTextPartsWithStructuralLineBreaks(textParts) {
	let text = "";
	for (const part of textParts) {
		if (text && shouldInsertStructuralLineBreak(text, part)) text += "\n";
		text += part;
	}
	return text;
}
function shouldInsertStructuralLineBreak(left, right) {
	if (!left || !right || /[\r\n]$/u.test(left) || /^\s/u.test(right)) return false;
	const trimmedLeft = left.trimEnd();
	return /<parameter=[A-Za-z0-9_.:-]{1,120}>$/iu.test(trimmedLeft) || /^\[[A-Za-z0-9_-]+\]$/u.test(trimmedLeft);
}
function shouldPromoteMessage(options) {
	if (options.allowedToolNames.size === 0) return false;
	const messageRecord = asRecord(options.message);
	if (!messageRecord) return false;
	if (options.requireAssistantRole && messageRecord.role !== "assistant") return false;
	return !options.allowedStopReasons || options.allowedStopReasons.has(messageRecord.stopReason);
}
/** Extracts candidate standalone tool-call text while rejecting mixed unsafe content. */
function extractStandalonePlainTextToolCallText(params) {
	const record = asRecord(params.message);
	if (!record) return;
	if (params.requireAssistantRole && record.role !== "assistant") return;
	if (params.allowedStopReasons && !params.allowedStopReasons.has(record.stopReason)) return;
	const content = record.content;
	if (typeof content === "string") return content.trim() || void 0;
	if (!Array.isArray(content)) return;
	const textParts = [];
	for (const block of content) {
		const blockRecord = asRecord(block);
		if (!blockRecord) return;
		if (blockRecord.type === "text") {
			if (typeof blockRecord.text !== "string") return;
			if (blockRecord.text.trim()) textParts.push(blockRecord.text);
			continue;
		}
		if (params.isRetainableNonTextBlock?.(blockRecord) || params.allowOtherNonTextBlocks) continue;
		return;
	}
	return textParts.join("").trim() || void 0;
}
/** Promotes standalone plain-text tool-call messages into provider-native content blocks. */
function promoteStandalonePlainTextToolCallMessage(options) {
	if (!shouldPromoteMessage(options)) return;
	const messageRecord = asRecord(options.message);
	if (!messageRecord) return;
	const originalContent = messageRecord.content;
	if (typeof originalContent === "string") {
		const text = originalContent.trim();
		if (!text) return;
		const toolCalls = createPromotedToolCallBlocks(text, options);
		if (!toolCalls) return;
		return {
			...messageRecord,
			content: toolCalls,
			stopReason: "toolUse"
		};
	}
	if (!Array.isArray(originalContent)) return;
	const content = [];
	let promotedTextBlock = false;
	let textParts = [];
	const flushTextParts = () => {
		if (textParts.length === 0) return false;
		const toolCalls = createPromotedToolCallBlocksFromTextParts(textParts, options);
		textParts = [];
		if (toolCalls?.length === 0) return false;
		if (!toolCalls) return;
		content.push(...toolCalls);
		return true;
	};
	for (const block of originalContent) {
		const blockRecord = asRecord(block);
		if (!blockRecord) return;
		if (blockRecord.type === "text") {
			if (typeof blockRecord.text !== "string") return;
			if (blockRecord.text.trim()) textParts.push(blockRecord.text);
			continue;
		}
		const promotedTextRun = flushTextParts();
		if (promotedTextRun === void 0) return;
		promotedTextBlock ||= promotedTextRun;
		if (options.isRetainableNonTextBlock?.(blockRecord)) {
			content.push(blockRecord);
			continue;
		}
		return;
	}
	const promotedTrailingTextRun = flushTextParts();
	if (promotedTrailingTextRun === void 0) return;
	promotedTextBlock ||= promotedTrailingTextRun;
	if (!promotedTextBlock) return;
	return {
		...messageRecord,
		content,
		stopReason: "toolUse"
	};
}
//#endregion
export { parseStandalonePlainTextToolCallBlocks as a, scrubOverCapPlainTextToolCallMessage as i, promoteStandalonePlainTextToolCallMessage as n, stripPlainTextToolCallBlocks as o, normalizePlainTextToolCallStreamEvents as r, extractStandalonePlainTextToolCallText as t };
