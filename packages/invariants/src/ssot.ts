/**
 * Minimal readers for the SSOT markdown.
 *
 * check-invariants and check-doc-claims both read the document itself, because
 * several of §0.1's error classes are properties of the TEXT: a section reference
 * that no longer resolves, a table cell left as "?", a placeholder in a prompt
 * that names no field. These are deliberately small and strict — a checker whose
 * parser guesses generously would pass exactly the malformed input it exists to
 * catch.
 */

export type Table = { header: string[]; rows: string[][] };

/**
 * The body of a numbered section: from its heading to the next heading at the
 * same depth or shallower. `id` is "18", "5.6", or "ADR-007".
 */
export function section(text: string, id: string): string {
  const lines = text.split(/\r?\n/);
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`^(#{2,4})\\s+(?:${escaped})(?:[.\\s]|$)`);

  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) throw new Error(`SSOT has no section ${id}`);
  const depth = lines[start]!.match(/^#+/)![0].length;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i]!.match(/^(#+)\s/);
    if (m && m[1]!.length <= depth) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Every section number the document defines — "5", "5.6", "12.10" … */
export function sectionNumbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^#{2,4}\s+(\d+(?:\.\d+)*)\.?\s/gm)) out.add(m[1]!);
  return out;
}

/** Markdown pipe tables, with cells trimmed. Separator rows are dropped. */
export function tables(text: string): Table[] {
  const out: Table[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.trim().startsWith('|') || !lines[i + 1]?.trim().match(/^\|[\s:|-]+\|$/)) {
      i++;
      continue;
    }
    const header = cells(lines[i]!);
    const rows: string[][] = [];
    i += 2;
    while (i < lines.length && lines[i]!.trim().startsWith('|')) {
      rows.push(cells(lines[i]!));
      i++;
    }
    out.push({ header, rows });
  }
  return out;
}

function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  // Split on pipes that are not escaped as \|.
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

/** Fenced code blocks, optionally filtered by their info string. */
export function codeBlocks(text: string, lang?: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^```(\w*)\s*\n([\s\S]*?)^```/gm)) {
    if (lang === undefined || m[1] === lang) out.push(m[2]!);
  }
  return out;
}

/** Field names declared in TypeScript type blocks: `name?: type;`. */
export function declaredFields(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(/^\s*(?:\|\s*\{\s*)?([a-z][A-Za-z0-9]*)\??\s*:/gm)) out.add(m[1]!);
  // Fields inside inline union members: `{ t: 'x'; foo: string; bar?: number }`
  for (const m of code.matchAll(/[{;]\s*([a-z][A-Za-z0-9]*)\??\s*:/g)) out.add(m[1]!);
  return out;
}
