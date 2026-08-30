//#region src/utils/mask-api-key.ts
/** Masks credential-like values for diagnostics while preserving enough prefix/suffix to identify them. */
const maskApiKey = (value) => {
	const trimmed = stripControlCharacters(value).trim();
	if (!trimmed) return "missing";
	if (trimmed.length <= 6) return `${trimmed.slice(0, 1)}...${trimmed.slice(-1)}`;
	if (trimmed.length <= 16) return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
	return `${trimmed.slice(0, 8)}...${trimmed.slice(-8)}`;
};
function stripControlCharacters(value) {
	let out = "";
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (!(code >= 0 && code <= 31 || code >= 127 && code <= 159)) out += char;
	}
	return out;
}
//#endregion
export { maskApiKey as t };
