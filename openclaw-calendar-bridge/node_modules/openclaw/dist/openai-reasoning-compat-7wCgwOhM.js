import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DW4mBlAt.js";
//#region src/agents/openai-reasoning-compat.ts
/**
* OpenAI reasoning-effort compatibility helpers.
*
* Keeps provider metadata and built-in model exceptions on one path before request payloads are built.
*/
const OPENAI_MEDIUM_ONLY_REASONING_MODEL_IDS = new Set(["gpt-5.1-codex-mini"]);
function readCompatReasoningEffortMap(compat) {
	if (!compat || typeof compat !== "object") return {};
	const rawMap = compat.reasoningEffortMap;
	if (!rawMap || typeof rawMap !== "object") return {};
	return Object.fromEntries(Object.entries(rawMap).filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "string"));
}
/** Resolves the reasoning effort remap for an OpenAI-compatible model. */
function resolveOpenAIReasoningEffortMap(model, fallbackMap = {}) {
	const provider = normalizeLowercaseStringOrEmpty(model.provider ?? "");
	const id = normalizeLowercaseStringOrEmpty(model.id ?? "");
	const builtinMap = provider === "openai" && OPENAI_MEDIUM_ONLY_REASONING_MODEL_IDS.has(id) ? {
		minimal: "medium",
		low: "medium"
	} : {};
	return {
		...fallbackMap,
		...builtinMap,
		...readCompatReasoningEffortMap(model.compat)
	};
}
//#endregion
export { resolveOpenAIReasoningEffortMap as t };
