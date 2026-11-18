export const MAX_ANSWER_CHARACTERS = 256_000;

export type Audit = (kind: string) => void;

/** A single complete terminal object only; arbitrary prose is never turned into an answer. */
export function decodeCandidateJSON(response: string, audit: Audit = () => {},maximum=16000): string {
  if (Array.from(response).length > maximum) throw new Error("JSON response exceeds the declared visible-text bound");
  let text = response.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(text);
  if (fence) text = fence[1].trim();
  const objects: Array<{ start: number; end: number; text: string }> = [];
  let start = -1, depth = 0, quoted = false, escaped = false, changed = false, out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (start < 0) {
      if (ch !== "{") continue;
      start = i; depth = 1; out = "{"; quoted = false; escaped = false;
      continue;
    }
    if (quoted) {
      if (escaped) { escaped = false; out += ch; }
      else if (ch === "\\") { escaped = true; out += ch; }
      else if (ch === '"') { quoted = false; out += ch; }
      else if (ch.charCodeAt(0) < 32) { out += JSON.stringify(ch).slice(1, -1); changed = true; }
      else out += ch;
    } else {
      out += ch;
      if (ch === '"') quoted = true;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth === 0) { objects.push({ start, end: i + 1, text: out }); start = -1; }
    }
  }
  if (start >= 0 || objects.length !== 1 || text.slice(objects[0].end).trim() || text.trimStart().startsWith("[")) throw new Error("Expected one complete terminal JSON object; multiple/truncated candidates rejected");
  const json = objects[0].text;
  JSON.parse(json); // validates arrays, escapes, values and syntax before the key scan
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === "{") stack.push(new Set());
    else if (ch === "[") stack.push(null);
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === '"') {
      const from = i; let escape = false;
      for (i++; i < json.length; i++) {
        if (escape) escape = false;
        else if (json[i] === "\\") escape = true;
        else if (json[i] === '"') break;
      }
      let next = i + 1; while (/\s/u.test(json[next] ?? "") && next < json.length) next++;
      if (json[next] === ":") {
        const key = JSON.parse(json.slice(from, i + 1)) as string, keys = stack.at(-1);
        if (!keys || keys.has(key)) throw new Error(`Duplicate JSON field rejected: ${key}`);
        keys.add(key);
      }
    }
  }
  if (objects[0].start > 0) audit("terminal_json_envelope_extracted");
  if (changed) audit("json_string_control_characters_escaped");
  return json;
}
