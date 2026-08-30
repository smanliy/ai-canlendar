import "./number-coercion-Crk_c9KW.js";
//#region src/shared/number-coercion.ts
function resolveNonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
//#endregion
export { resolveNonNegativeNumber as t };
