// Minimal XFA template scanner (no XML dependency).
//
// The IRS hybrid AcroForm+XFA PDFs embed, for every field, an accessibility
// description (<assist><speak>...</speak></assist>) such as
// "1a. Total amount from Form(s) W-2, box 1". The XFA field path
// (topmostSubform[0].Page1[0].f1_47[0]) matches the AcroForm full field name 1:1,
// so the speak text is the mapping accelerator for field-to-line maps (plan 6.3).
//
// Path rule (verified on 26 of 27 forms: the XFA and AcroForm field sets are equal):
//   - <subform name="X">, <exclGroup name="X"> and <field name="X"> contribute a
//     path segment "X[i]" where i is the occurrence count of that name among the
//     children of the nearest NAMED ancestor (unnamed subforms/areas are transparent).
//   - A <field> is a leaf; its <speak> text is the description.

export interface XfaField {
  /** Full XFA path, e.g. topmostSubform[0].Page1[0].f1_47[0]. */
  name: string;
  /** Concatenated <speak> text, or null if the field has none. */
  speak: string | null;
}

const ENTITY_MAP: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITY_MAP[body] ?? whole;
  });
}

interface Frame {
  tag: string;
  /** Path of this element when it is a named path segment, else null. */
  path: string | null;
  /** Per-name occurrence counters for children whose scope is this frame. */
  counters: Map<string, number>;
  isField: boolean;
  speak: string | null;
}

const PATH_TAGS = new Set(["subform", "exclGroup", "field"]);

function localName(tag: string): string {
  const i = tag.indexOf(":");
  return i === -1 ? tag : tag.slice(i + 1);
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const key = m[1];
    if (key !== undefined) attrs[key] = m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/** Scan an XFA <template> document and return every named field with its speak text. */
export function scanXfaFields(xml: string): XfaField[] {
  const fields: XfaField[] = [];
  const root: Frame = { tag: "#root", path: null, counters: new Map(), isField: false, speak: null };
  const stack: Frame[] = [root];
  let inSpeak = false;
  let speakBuf = "";
  let i = 0;
  const n = xml.length;

  const nearestScope = (): Frame => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const f = stack[k];
      if (f && (f.path !== null || f === root)) return f;
    }
    return root;
  };

  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) break;
    if (inSpeak && lt > i) speakBuf += xml.slice(i, lt);
    i = lt;
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      const stop = end === -1 ? n : end;
      if (inSpeak) speakBuf += xml.slice(i + 9, stop);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (xml.startsWith("<!", i)) {
      const end = xml.indexOf(">", i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    // Find the end of the tag, honouring quoted attribute values.
    let j = i + 1;
    let quote: string | null = null;
    while (j < n) {
      const c = xml.charAt(j);
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j += 1;
    }
    const rawTag = xml.slice(i + 1, j);
    i = j + 1;

    if (rawTag.startsWith("/")) {
      const closing = localName(rawTag.slice(1).trim());
      const top = stack[stack.length - 1];
      if (closing === "speak" && inSpeak) {
        inSpeak = false;
        for (let k = stack.length - 1; k >= 0; k--) {
          const f = stack[k];
          if (f && f.isField) {
            f.speak = ((f.speak ?? "") + decodeXmlEntities(speakBuf)).trim() || f.speak;
            break;
          }
        }
        speakBuf = "";
      }
      if (top && top !== root && localName(top.tag) === closing) {
        stack.pop();
        if (top.isField && top.path !== null) {
          fields.push({ name: top.path, speak: top.speak });
        }
      }
      continue;
    }

    const selfClosing = rawTag.endsWith("/");
    const body = selfClosing ? rawTag.slice(0, -1) : rawTag;
    const spaceAt = body.search(/\s/);
    const tag = localName(spaceAt === -1 ? body.trim() : body.slice(0, spaceAt));
    const attrs = spaceAt === -1 ? {} : parseAttrs(body.slice(spaceAt));

    let segmentPath: string | null = null;
    if (PATH_TAGS.has(tag)) {
      const name = attrs["name"];
      if (name !== undefined && name !== "") {
        const scope = nearestScope();
        const idx = scope.counters.get(name) ?? 0;
        scope.counters.set(name, idx + 1);
        segmentPath = scope.path === null ? `${name}[${idx}]` : `${scope.path}.${name}[${idx}]`;
      }
    }
    const frame: Frame = {
      tag,
      path: segmentPath,
      counters: new Map(),
      isField: tag === "field",
      speak: null,
    };
    if (selfClosing) {
      if (frame.isField && frame.path !== null) fields.push({ name: frame.path, speak: null });
      continue;
    }
    stack.push(frame);
    if (tag === "speak") {
      inSpeak = true;
      speakBuf = "";
    }
  }
  return fields;
}
