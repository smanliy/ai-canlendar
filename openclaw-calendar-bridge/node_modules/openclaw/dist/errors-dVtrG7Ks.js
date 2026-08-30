import { c as redactSensitiveText } from "./redact-BFQyU94D.js";
import { s as configureAcpErrorRedactor } from "./errors-Cr5wPlui.js";
import "./src-DVQh81qw.js";
//#region src/acp/runtime/errors.ts
/** ACP runtime error exports wired to OpenClaw secret redaction. */
configureAcpErrorRedactor(redactSensitiveText);
//#endregion
export {};
