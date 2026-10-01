import { createCompactPayload, createJsonTextContent, truncateText } from "./helpers.js";

const INLINE_MAX_CHARS = 20000;

export function createCommandOutputContent(toolName, command, output, options = {}) {
  const text = String(output ?? "").trim();
  const baseMeta = { tool: toolName, command };
  const content = (summary, data, meta) => createJsonTextContent(
    createCompactPayload(summary, data, meta),
    { pretty: options.pretty, audience: options.audience || ["assistant"], priority: options.priority ?? 0.7 },
  );
  let rawJson;
  let parsed;
  try {
    parsed = JSON.parse(text);
    rawJson = JSON.stringify(parsed);
  } catch { /* Plain-text CLI output. */ }

  if (rawJson !== undefined) {
    if (rawJson.length <= INLINE_MAX_CHARS) {
      return content(`${toolName} command completed`, parsed,
        { ...baseMeta, format: "json", truncated: false, original_chars: rawJson.length });
    }

    const truncated = truncateText(rawJson, { maxChars: INLINE_MAX_CHARS });
    const artifact = options.saveLargeOutput?.(`${rawJson}\n`, "json");
    return content(`${toolName} command completed with large JSON output`,
      { raw_json_preview: truncated.text },
      { ...baseMeta, format: "json", ...truncated, text: undefined,
        ...(artifact ? { full_output_path: artifact, full_output_format: "json" } : {}) });
  }

  const truncated = truncateText(text, { maxChars: INLINE_MAX_CHARS });
  const artifact = truncated.truncated ? options.saveLargeOutput?.(`${text}\n`, "text") : undefined;
  return content(`${toolName} command completed`,
    { output: truncated.text },
    { ...baseMeta, format: "text", ...truncated, text: undefined,
      ...(artifact ? { full_output_path: artifact, full_output_format: "text" } : {}) });
}
