// swiftmark-r5b — a fast drop-in for marked 18.1.3 (default options, GFM on).
// Single-pass direct-to-HTML parser. The inline scanner is index-based: a tight
// charCode loop finds the next special character and dispatches on it, so long
// documents never pay for a giant text-boundary regex.

// ---------- escaping ----------
const RAW_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Plain escape (code spans, code blocks, URLs, titles): no entity pass-through.
function escRaw(s) {
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    const r = RAW_ESC[s[i]];
    if (r !== undefined) { if (last < i) out += s.slice(last, i); out += r; last = i + 1; }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Numeric character reference body ('#35', '#x22') -> code point, or -1.
function numRefCp(body) {
  let cp;
  if (body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88) {
    if (body.length < 3 || body.length > 8) return -1;
    for (let i = 2; i < body.length; i++) {
      const c = body.charCodeAt(i);
      if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) return -1;
    }
    cp = parseInt(body.slice(2), 16);
  } else {
    if (body.length < 2 || body.length > 8) return -1;
    for (let i = 1; i < body.length; i++) {
      const c = body.charCodeAt(i);
      if (c < 48 || c > 57) return -1;
    }
    cp = parseInt(body.slice(1), 10);
  }
  return cp;
}

// Numeric ref body -> decoded, escaped output char, or null if not a valid ref.
function decodeNumRef(body) {
  const cp = numRefCp(body);
  if (cp < 0) return null;
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
  if (cp === 38) return '&amp;';
  const ch = String.fromCodePoint(cp);
  return RAW_ESC[ch] || ch;
}

function isWordRef(b) {
  if (b.length === 0 || b.length > 31) return false;
  for (let i = 0; i < b.length; i++) {
    const c = b.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) return false;
  }
  return true;
}

// Text escape: marked passes `&word;` through untouched and decodes only
// numeric references; any other `&` is escaped.
function escText(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const semi = s.indexOf(';', i + 2);
      if (semi > 0 && semi - i <= 33) {
        const body = s.slice(i + 1, semi);
        if (body.charCodeAt(0) === 35) {
          const d = decodeNumRef(body);
          if (d !== null) { out += s.slice(last, i) + d; last = semi + 1; i = semi; continue; }
        } else if (isWordRef(body)) { i = semi; continue; }
      }
      out += s.slice(last, i) + '&amp;'; last = i + 1;
    } else {
      const r = RAW_ESC[s[i]];
      if (r !== undefined) { out += s.slice(last, i) + r; last = i + 1; }
    }
  }
  return out + s.slice(last);
}

// Unescape for URLs/titles: decodes numeric references only.
function unesc(s) {
  if (s.indexOf('&#') < 0) return s;
  return s.replace(/&#[0-9]{1,7};|&#[Xx][0-9A-Fa-f]{1,6};/g, (m) => {
    const cp = numRefCp(m.slice(1, -1));
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Reject javascript:/vbscript:/data: URLs (checked on a cleaned copy).
function cleanUrl(href) {
  if (!href) return href;
  try {
    const prot = decodeURIComponent(unesc(href)).replace(/[^\w:]/g, '').toLowerCase();
    if (prot.indexOf('javascript:') === 0 || prot.indexOf('vbscript:') === 0 || prot.indexOf('data:') === 0) return null;
  } catch { return null; }
  return href;
}

function encodeHref(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
}

// ---------- table cells ----------
function isEscapedPipe(s, i) {
  let n = 0;
  while (i - 1 - n >= 0 && s[i - 1 - n] === '\\') n++;
  return n % 2 === 1;
}

function splitCells(row, count) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '|' && !isEscapedPipe(row, i)) { cells.push(cur); cur = ''; }
    else cur += row[i];
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  while (cells.length < count) cells.push('');
  if (cells.length > count) cells.length = count;
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ---------- line utilities ----------
// [indent columns (tab = next multiple of 4), index of first non-ws char]
function indentInfo(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return [col, i];
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Strip n columns of indent from the line start (a straddling tab -> spaces).
function stripIndent(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w > n) return ' '.repeat(col + w - n) + line.slice(i + 1);
      col += w; i++;
    } else break;
  }
  return line.slice(i);
}

// ---------- list markers ----------
// line[ci] is a list marker start, col is its column. Returns null or
// [ordered, markerChar, number, contentCol, contentIdx].
function matchListMarker(line, ci, col) {
  const c = line.charCodeAt(ci);
  let ord = false, num = 0, mw = 1;
  if (c === 45 || c === 43 || c === 42) {
    // - + *
  } else if (c >= 48 && c <= 57) {
    let j = ci, n = 0;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57 && j - ci < 9) { n = n * 10 + (line.charCodeAt(j) - 48); j++; }
    if (j === ci || j - ci > 9) return null;
    if (j >= line.length || (line.charCodeAt(j) !== 46 && line.charCodeAt(j) !== 41)) return null;
    if (j - ci === 9 && line.charCodeAt(j + 1) >= 48 && line.charCodeAt(j + 1) <= 57) return null;
    ord = true; num = n; mw = j - ci + 1;
    return finishMarker(line, ci, col, ord, line[j], num, mw);
  } else return null;
  return finishMarker(line, ci, col, false, line[ci], 0, 1);
}

function finishMarker(line, ci, col, ord, ch, num, mw) {
  const after = ci + mw;
  if (after >= line.length) return [ord, ch, num, col + mw + 1, line.length];
  const c = line.charCodeAt(after);
  if (c !== 32 && c !== 9) return null;
  // measure whitespace columns after the marker
  let j = after, wcol = 0;
  while (j < line.length) {
    const d = line.charCodeAt(j);
    if (d === 32) { wcol++; j++; }
    else if (d === 9) { const w = 4 - ((col + mw + wcol) % 4); wcol += w; j++; }
    else break;
  }
  if (j >= line.length) return [ord, ch, num, col + mw + 1, line.length];
  if (wcol >= 5) return [ord, ch, num, col + mw + 1, after + 1];
  return [ord, ch, num, col + mw + wcol, j];
}

// ---------- reference definitions ----------
// Try to parse a definition starting at `line` (title may be on `nextLine`).
// Returns [linesConsumed, label, dest, title] or null.
function parseDef(line, nextLine) {
  let i = 0, sp = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    sp += line[i] === ' ' ? 1 : 4 - (sp % 4); i++;
    if (sp > 3) return null;
  }
  if (line[i] !== '[') return null;
  const close = line.indexOf(']', i + 1);
  if (close < 0 || close === i + 1) return null;
  const labelRaw = line.slice(i + 1, close);
  if (labelRaw.length > 999) return null;
  if (line[close + 1] !== ':') return null;
  let j = close + 2;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  if (j >= line.length) return null;
  let dest;
  if (line[j] === '<') {
    const gt = line.indexOf('>', j + 1);
    if (gt < 0) return null;
    dest = line.slice(j + 1, gt);
    if (dest.indexOf('<') >= 0) return null;
    j = gt + 1;
  } else {
    let depth = 0, k = j;
    while (k < line.length) {
      const c = line[k];
      if (c === ' ' || c === '\t') break;
      if (c === '\\' && k + 1 < line.length) { k += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      k++;
    }
    if (k === j || depth !== 0) return null;
    dest = line.slice(j, k);
    j = k;
  }
  const label = labelRaw.replace(/\s+/g, ' ').trim().toLowerCase();
  let k = j;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  if (k >= line.length) {
    if (nextLine != null) {
      const t = parseTitleLine(nextLine);
      if (t !== null) return [2, label, dest, t];
    }
    return [1, label, dest, ''];
  }
  const q = line[k];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const closeQ = q === '(' ? ')' : q;
  let m = k + 1, t = '';
  while (m < line.length) {
    const c = line[m];
    if (c === '\\' && m + 1 < line.length) { t += line[m + 1]; m += 2; continue; }
    if (c === closeQ) {
      let r = m + 1;
      while (r < line.length && (line[r] === ' ' || line[r] === '\t')) r++;
      if (r < line.length) return null;
      return [1, label, dest, t];
    }
    if (q === '(' && c === '(') return null;
    t += c; m++;
  }
  return null;
}

// A line holding only a title (plus whitespace) -> title text, else null.
function parseTitleLine(line) {
  let k = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  if (k >= line.length) return null;
  const q = line[k];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const closeQ = q === '(' ? ')' : q;
  let m = k + 1, t = '';
  while (m < line.length) {
    const c = line[m];
    if (c === '\\' && m + 1 < line.length) { t += line[m + 1]; m += 2; continue; }
    if (c === closeQ) {
      let r = m + 1;
      while (r < line.length && (line[r] === ' ' || line[r] === '\t')) r++;
      if (r < line.length) return null;
      return t;
    }
    if (q === '(' && c === '(') return null;
    t += c; m++;
  }
  return null;
}

// ---------- refs pre-pass ----------
// Strip quote '>' and list prefixes repeatedly (refs pre-pass only).
function stripPrefixes(line) {
  let s = line;
  for (let k = 0; k < 8; k++) {
    const [col, ci] = indentInfo(s);
    if (col > 3) return s;
    const first = s.charCodeAt(ci);
    if (first === 62) {
      let j = ci + 1;
      if (s.charCodeAt(j) === 32) j++;
      else if (s.charCodeAt(j) === 9) {
        const w = 4 - ((col + 1) % 4);
        s = ' '.repeat(w - 1) + s.slice(j + 1);
        continue;
      }
      s = s.slice(j);
      continue;
    }
    const m = matchListMarker(s, ci, col);
    if (m) { s = s.slice(m[4]); continue; }
    return s;
  }
  return s;
}

// A stripped line starts a block (so a def may follow it), or is blank.
function prevAllowsDef(prev) {
  if (prev === null) return true;
  if (isBlank(prev)) return true;
  if (parseDef(prev, null) !== null) return true;
  if (matchDelimRow(prev)) return true;
  const [col, ci] = indentInfo(prev);
  if (col > 3) return false;
  const c = prev.charCodeAt(ci);
  if (c === 35 || c === 62 || c === 96 || c === 126) return true;
  if (c === 45 || c === 43 || c === 42 || c === 95) return true;
  if (c >= 48 && c <= 57 && matchListMarker(prev, ci, col)) return true;
  if (c === 60 && htmlBlockKind(prev, ci) > 0) return true;
  return false;
}

// Collect link reference definitions from the whole document first: marked
// resolves forward references, so defs must be known before rendering.
function collectRefs(lines) {
  const refs = new Map();
  const stripped = new Array(lines.length);
  let fenceCh = 0, fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const s = stripPrefixes(raw);
    stripped[i] = s;
    if (fenceCh) {
      const [col, ci] = indentInfo(s);
      if (col <= 3 && s.charCodeAt(ci) === fenceCh) {
        let n = 0, j = ci;
        while (s.charCodeAt(j) === fenceCh) { n++; j++; }
        let ok = n >= fenceLen;
        while (ok && j < s.length) { const c = s.charCodeAt(j); if (c !== 32 && c !== 9) ok = false; j++; }
        if (ok) fenceCh = 0;
      }
      continue;
    }
    const [col, ci] = indentInfo(s);
    if (col <= 3) {
      const c = s.charCodeAt(ci);
      if (c === 96 || c === 126) {
        let n = 0, j = ci;
        while (s.charCodeAt(j) === c) { n++; j++; }
        if (n >= 3 && (c === 126 || s.indexOf('`', j) < 0)) { fenceCh = c; fenceLen = n; continue; }
      }
    }
    if (!prevAllowsDef(i === 0 ? null : stripped[i - 1])) continue;
    const d = parseDef(s, i + 1 < lines.length ? stripped[i + 1] : null);
    if (d && !refs.has(d[1])) refs.set(d[1], { href: d[2], title: d[3] });
  }
  return refs;
}

// ---------- block-start tests ----------
function isHR(line, ci) {
  const c = line.charCodeAt(ci);
  if (c !== 45 && c !== 42 && c !== 95) return false;
  let n = 0;
  for (let i = ci; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d === c) n++;
    else if (d !== 32 && d !== 9) return false;
  }
  return n >= 3;
}

// ATX heading: returns [depth, content] or null.
function matchATX(line, ci) {
  let n = 0, j = ci;
  while (line.charCodeAt(j) === 35 && n < 7) { n++; j++; }
  if (n === 0 || n > 6) return null;
  if (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  let content = line.slice(j).trim();
  if (/^#+$/.test(content)) content = '';
  else content = content.replace(/\s+#+$/, '');
  return [n, content];
}

// Setext underline: returns 1 (=), 2 (-), or 0.
function setextKind(line, ci) {
  const c = line.charCodeAt(ci);
  if (c !== 61 && c !== 45) return 0;
  for (let i = ci + 1; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== c && d !== 32 && d !== 9) return 0;
  }
  return c === 61 ? 1 : 2;
}

// Table delimiter row: returns alignments array or null.
function matchDelimRow(line) {
  const [col, ci] = indentInfo(line);
  if (col > 3) return null;
  const parts = line.slice(ci).split('|');
  if (parts.length && parts[0].trim() === '') parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
  if (parts.length === 0) return null;
  const aligns = [];
  for (const p of parts) {
    const t = p.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    aligns.push(t.charCodeAt(0) === 58 ? (t.charCodeAt(t.length - 1) === 58 ? 'center' : 'left') : (t.charCodeAt(t.length - 1) === 58 ? 'right' : ''));
  }
  return aligns;
}

// ---------- HTML blocks ----------
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// HTML block kind starting at line[ci] (indent already <= 3): 0 none, 1-6
// (can interrupt a paragraph), 7 (cannot). Returns [kind, closeMarker|null].
function htmlBlockKind(line, ci) {
  if (line.charCodeAt(ci) !== 60) return [0, null];
  const rest = line.slice(ci + 1);
  const lower = rest.toLowerCase();
  if (lower.startsWith('!--')) return [2, '-->'];
  if (lower.startsWith('![cdata[')) return [5, ']]>'];
  if (lower.startsWith('?')) return [3, '?>'];
  if (lower.startsWith('!') && lower.length > 1) {
    const c = lower.charCodeAt(1);
    if (c >= 97 && c <= 122) return [4, '>'];
  }
  const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(\s|\/?>|$)/.exec(line.slice(ci));
  if (!m) return [0, null];
  const tag = m[1].toLowerCase();
  if (tag === 'script' || tag === 'pre' || tag === 'style' || tag === 'textarea') {
    return [1, '</' + tag];
  }
  // Type 7: a complete open/close tag alone on the line.
  if (/^<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^<>]*)?\/?>\s*$/.test(line.slice(ci))) {
    if (BLOCK_TAGS.has(tag)) return [6, null];
    return [7, null];
  }
  if (BLOCK_TAGS.has(tag)) return [6, null];
  return [0, null];
}

// Consume an HTML block starting at lines[i]; returns [htmlText, nextIndex].
function parseHtmlBlock(lines, i, e) {
  const [col, ci] = indentInfo(lines[i]);
  const [kind, closer] = htmlBlockKind(lines[i], ci);
  let j = i;
  if (kind <= 5) {
    const needle = closer.toLowerCase();
    for (; j < e; j++) {
      if (lines[j].toLowerCase().indexOf(needle) >= 0) { j++; break; }
    }
    // trailing newline kept iff the next line is non-blank
    const text = lines.slice(i, j).join('\n');
    return [j < e && !isBlank(lines[j]) ? text + '\n' : text, j];
  }
  for (; j < e; j++) {
    if (isBlank(lines[j])) break;
  }
  return [lines.slice(i, j).join('\n'), j];
}

// ---------- block parser ----------
// lazy: null, or a boolean array (same indexing as lines) marking lazy
// continuation lines, which never count as setext underlines or table rows.
function parseBlocks(L, s, e, out, refs, tight, lazy) {
  let i = s;
  while (i < e) {
    const line = L[i];
    if (isBlank(line)) { i++; continue; }
    const [ind, ci] = indentInfo(line);
    if (ind >= 4) { i = parseIndentedCode(L, i, e, out); continue; }
    const d = parseDef(line, i + 1 < e ? L[i + 1] : null);
    if (d) { i += d[0]; continue; }
    const ch = line.charCodeAt(ci);
    if (ch === 35) {
      const h = matchATX(line, ci);
      if (h) { out.push('<h' + h[0] + '>' + inline(h[1], refs) + '</h' + h[0] + '>\n'); i++; continue; }
    } else if (ch === 62) {
      i = parseQuote(L, i, e, out, refs); continue;
    } else if (ch === 96 || ch === 126) {
      const f = matchFence(line, ci);
      if (f) { i = parseFenced(L, i, e, out, f, ind); continue; }
    } else if (ch === 45 || ch === 43 || ch === 42 || ch === 95) {
      if (isHR(line, ci)) { out.push('<hr>\n'); i++; continue; }
      if (ch !== 95) {
        const m = matchListMarker(line, ci, ind);
        if (m) { i = parseList(L, i, e, out, refs, m); continue; }
      }
    } else if (ch === 60) {
      if (htmlBlockKind(line, ci)[0] > 0) {
        const hb = parseHtmlBlock(L, i, e);
        out.push(hb[0]); i = hb[1]; continue;
      }
    } else if (ch >= 48 && ch <= 57) {
      const m = matchListMarker(line, ci, ind);
      if (m) { i = parseList(L, i, e, out, refs, m); continue; }
    }
    if (line.indexOf('|', ci) >= 0 && i + 1 < e && matchDelimRow(L[i + 1])) {
      i = parseTable(L, i, e, out, refs); continue;
    }
    i = parseParagraph(L, i, e, out, refs, tight, lazy);
  }
  return i;
}

// Does line j start a block that interrupts a paragraph? (def/html7/code no)
function interruptsPara(L, j, e) {
  const line = L[j];
  if (isBlank(line)) return true;
  const [ind, ci] = indentInfo(line);
  if (ind >= 4) return false;
  const ch = line.charCodeAt(ci);
  if (ch === 35) return matchATX(line, ci) !== null;
  if (ch === 62) return true;
  if (ch === 96 || ch === 126) return matchFence(line, ci) !== null;
  if (ch === 45 || ch === 43 || ch === 42 || ch === 95) {
    if (isHR(line, ci)) return true;
    if (ch === 95) return false;
    const m = matchListMarker(line, ci, ind);
    return m !== null && m[4] < line.length;
  }
  if (ch >= 48 && ch <= 57) {
    const m = matchListMarker(line, ci, ind);
    return m !== null && m[2] === 1 && m[4] < line.length;
  }
  if (ch === 60) {
    const k = htmlBlockKind(line, ci)[0];
    return k >= 1 && k <= 6;
  }
  return false;
}

function parseParagraph(L, i, e, out, refs, tight, lazy) {
  let j = i + 1;
  while (j < e) {
    const line = L[j];
    if (isBlank(line)) break;
    const [ind, ci] = indentInfo(line);
    if (ind <= 3 && setextKind(line, ci) > 0 && !(lazy && lazy[j])) break;
    // marked's paragraph lookahead stops before any line followed by a
    // delimiter row (even a pipe-less header); the table itself then fails
    // and the lines become a new paragraph. A plain ---/=== row is setext.
    if (ind <= 3 && j + 1 < e && matchDelimRow(L[j + 1]) && (L[j + 1].indexOf('|') >= 0 || L[j + 1].indexOf(':') >= 0) && !(lazy && (lazy[j] || lazy[j + 1]))) break;
    if (interruptsPara(L, j, e)) break;
    j++;
  }
  const text = L.slice(i, j).join('\n');
  // Setext heading?
  if (j < e && !isBlank(L[j])) {
    const [ind2, ci2] = indentInfo(L[j]);
    const sk = ind2 <= 3 ? setextKind(L[j], ci2) : 0;
    if (sk > 0 && !(lazy && lazy[j])) {
      out.push('<h' + sk + '>' + inline(text, refs) + '</h' + sk + '>\n');
      return j + 1;
    }
  }
  if (tight) out.push(inline(text, refs));
  else out.push('<p>' + inline(text, refs) + '</p>\n');
  return j;
}

function matchFence(line, ci) {
  const c = line.charCodeAt(ci);
  let n = 0, j = ci;
  while (line.charCodeAt(j) === c) { n++; j++; }
  if (n < 3) return null;
  const info = line.slice(j).trim();
  if (c === 96 && info.indexOf('`') >= 0) return null;
  return [c, n, info];
}

function parseFenced(L, i, e, out, f, ind) {
  const [c, n, info] = f;
  let j = i + 1;
  let closed = false;
  for (; j < e; j++) {
    const [ci2, cj] = indentInfo(L[j]);
    if (ci2 <= 3 && L[j].charCodeAt(cj) === c) {
      let m = 0, k = cj;
      while (L[j].charCodeAt(k) === c) { m++; k++; }
      let ok = m >= n;
      while (ok && k < L[j].length) { const d = L[j].charCodeAt(k); if (d !== 32 && d !== 9) ok = false; k++; }
      if (ok) { closed = true; break; }
    }
  }
  const content = [];
  for (let k = i + 1; k < j; k++) content.push(ind > 0 ? stripIndent(L[k], ind) : L[k]);
  let text = content.join('\n');
  if (closed) text += '\n';
  const lang = info === '' ? '' : ' class="language-' + escRaw(info.split(/\s+/)[0]) + '"';
  out.push('<pre><code' + lang + '>' + escRaw(text) + '</code></pre>\n');
  return closed ? j + 1 : j;
}

function parseIndentedCode(L, i, e, out) {
  let j = i;
  const content = [];
  while (j < e) {
    const line = L[j];
    if (isBlank(line)) {
      // blank line continues only if a later indented line follows
      let k = j + 1;
      let found = false;
      while (k < e) {
        if (isBlank(L[k])) { k++; continue; }
        if (indentInfo(L[k])[0] >= 4) found = true;
        break;
      }
      if (!found) break;
      content.push('');
      j++;
      continue;
    }
    if (indentInfo(line)[0] < 4) break;
    content.push(stripIndent(line, 4));
    j++;
  }
  while (content.length && content[content.length - 1] === '') content.pop();
  let text = content.join('\n') + '\n';
  out.push('<pre><code>' + escRaw(text) + '</code></pre>\n');
  return j;
}

// ---------- blockquote ----------
function stripQuotePrefix(line, ci, col) {
  let j = ci + 1;
  if (line.charCodeAt(j) === 32) return line.slice(j + 1);
  if (line.charCodeAt(j) === 9) {
    const w = 4 - ((col + 1) % 4);
    return ' '.repeat(w - 1) + line.slice(j + 1);
  }
  return line.slice(j);
}

function parseQuote(L, i, e, out, refs) {
  const inner = [], lazy = [];
  let j = i;
  while (j < e) {
    const line = L[j];
    if (isBlank(line)) break;
    const [ind, ci] = indentInfo(line);
    if (ind <= 3 && line.charCodeAt(ci) === 62) {
      inner.push(stripQuotePrefix(line, ci, ind));
      lazy.push(false);
      j++;
      continue;
    }
    // lazy continuation: non-blank, no block start, paragraph still open
    if (inner.length && !isBlank(inner[inner.length - 1]) && !interruptsPara(L, j, e) && parseDef(line, null) === null) {
      inner.push(line);
      lazy.push(true);
      j++;
      continue;
    }
    break;
  }
  const sub = [];
  parseBlocks(inner, 0, inner.length, sub, refs, false, lazy);
  out.push('<blockquote>\n' + sub.join('') + '</blockquote>\n');
  return j;
}

// ---------- lists ----------
function parseList(L, i, e, out, refs, first) {
  const ord = first[0], ch = first[1];
  const items = [];
  let j = i, loose = false;
  let startNum = first[2];
  let lastCCol = first[3];
  while (j < e) {
    const line = L[j];
    if (isBlank(line)) break;
    const [ind, ci] = indentInfo(line);
    const m = ind <= 3 ? matchListMarker(line, ci, ind) : null;
    if (!m || m[0] !== ord || m[1] !== ch || ind >= lastCCol) break;
    // collect one item
    const content = [], lazy = [];
    const cCol = m[3];
    lastCCol = cCol;
    const firstLine = line.slice(m[4]);
    content.push(firstLine);
    lazy.push(false);
    j++;
    let sawBlank = false;
    while (j < e) {
      const ln = L[j];
      if (isBlank(ln)) {
        // blank: belongs to item if a content line or next item follows
        let k = j + 1, nextIsItem = false, nextIsContent = false;
        while (k < e && isBlank(L[k])) k++;
        if (k < e) {
          const [ind2, ci2] = indentInfo(L[k]);
          const m2 = ind2 <= 3 ? matchListMarker(L[k], ci2, ind2) : null;
          if (m2 && m2[0] === ord && m2[1] === ch && ind2 < cCol) nextIsItem = true;
          else if (indentInfo(L[k])[0] >= cCol) nextIsContent = true;
        }
        if (nextIsItem) { loose = true; j = k; break; }
        if (nextIsContent) {
          sawBlank = true;
          while (j < k) { content.push(''); lazy.push(false); j++; }
          continue;
        }
        break;
      }
      const [ind2, ci2] = indentInfo(ln);
      const m2 = ind2 <= 3 ? matchListMarker(ln, ci2, ind2) : null;
      if (m2 && m2[0] === ord && m2[1] === ch && ind2 < cCol) break;
      if (m2 && ind2 < cCol) break; // different marker: list ends here
      if (ind2 >= cCol) {
        if (sawBlank) loose = true;
        sawBlank = false;
        content.push(stripIndent(ln, cCol));
        lazy.push(false);
        j++;
        continue;
      }
      // lazy continuation of the item's paragraph
      if (content.length && !isBlank(content[content.length - 1]) && !interruptsPara(L, j, e) && parseDef(ln, null) === null) {
        content.push(ln);
        lazy.push(true);
        j++;
        continue;
      }
      break;
    }
    while (content.length && isBlank(content[content.length - 1])) { content.pop(); lazy.pop(); }
    items.push([content, lazy]);
  }
  const tag = ord ? (startNum !== 1 ? '<ol start="' + startNum + '">\n' : '<ol>\n') : '<ul>\n';
  out.push(tag);
  for (const [content, lazy] of items) {
    let task = null;
    if (content.length && !isBlank(content[0])) {
      const t = /^\[( |x|X)\](?: |$)/.exec(content[0]);
      if (t) {
        task = t[1] !== ' ';
        content[0] = content[0].slice(t[0].length);
      }
    }
    const sub = [];
    parseBlocks(content, 0, content.length, sub, refs, !loose, lazy);
    let body = sub.join('');
    if (task !== null) {
      body = '<input' + (task ? ' checked=""' : '') + ' disabled="" type="checkbox"> ' + body;
    }
    out.push('<li>' + body + '</li>\n');
  }
  out.push(ord ? '</ol>\n' : '</ul>\n');
  return j;
}

// ---------- tables ----------
function parseTable(L, i, e, out, refs) {
  const aligns = matchDelimRow(L[i + 1]);
  const ncols = aligns.length;
  const head = splitCells(L[i], ncols);
  let j = i + 2;
  const rows = [];
  while (j < e) {
    const line = L[j];
    if (isBlank(line)) break;
    const [ind, ci] = indentInfo(line);
    if (ind >= 4) break;
    const ch = line.charCodeAt(ci);
    if (ch === 35 && matchATX(line, ci)) break;
    if (ch === 62) break;
    if ((ch === 96 || ch === 126) && matchFence(line, ci)) break;
    if ((ch === 45 || ch === 43 || ch === 42 || ch === 95) && (isHR(line, ci) || matchListMarker(line, ci, ind))) break;
    if (ch >= 48 && ch <= 57 && matchListMarker(line, ci, ind)) break;
    if (ch === 60 && htmlBlockKind(line, ci)[0] > 0) break;
    rows.push(splitCells(line, ncols));
    j++;
  }
  const a = (k) => aligns[k] ? ' align="' + aligns[k] + '"' : '';
  out.push('<table>\n<thead>\n<tr>\n');
  for (let k = 0; k < ncols; k++) out.push('<th' + a(k) + '>' + inline(head[k], refs) + '</th>\n');
  out.push('</tr>\n</thead>\n');
  if (rows.length) {
    out.push('<tbody>');
    for (const r of rows) {
      out.push('<tr>\n');
      for (let k = 0; k < ncols; k++) out.push('<td' + a(k) + '>' + inline(r[k], refs) + '</td>\n');
      out.push('</tr>\n');
    }
    out.push('</tbody>');
  }
  out.push('</table>\n');
  return j;
}

// ---------- inline core (index-based scan) ----------
// Token kinds: string = text; {t:1} delimiter run; {t:2} code span;
// {t:3} hard break; {t:5} em/strong node. Phase 2 adds links/images/etc.
const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function isSpaceCh(c) {
  if (c === '') return true; // string boundary counts as whitespace
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0';
}
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCh(c) {
  if (c === '') return false;
  const cc = c.charCodeAt(0);
  if (cc < 128) return ASCII_PUNCT.has(c);
  return PUNCT_RE.test(c);
}

function inline(src, refs) {
  const toks = [];
  const n = src.length;
  let i = 0, start = 0;
  const flush = (to) => { if (to > start) toks.push(src.slice(start, to)); };
  while (i < n) {
    const cc = src.charCodeAt(i);
    if (cc === 92) { // backslash
      const nx = src[i + 1];
      if (nx === '\n') {
        flush(i); toks.push({ t: 3 }); i += 2;
        while (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9) i++;
        start = i; continue;
      }
      if (nx !== undefined && ASCII_PUNCT.has(nx)) {
        flush(i); toks.push(nx); i += 2; start = i; continue;
      }
      i++; continue;
    }
    if (cc === 96) { // backtick: code span
      let m = 1;
      while (src.charCodeAt(i + m) === 96) m++;
      let j = i + m, found = -1;
      while (j < n) {
        const b = src.indexOf('`', j);
        if (b < 0) break;
        let r = 1;
        while (src.charCodeAt(b + r) === 96) r++;
        if (r === m) { found = b; break; }
        j = b + r;
      }
      if (found >= 0) {
        flush(i);
        let content = src.slice(i + m, found).replace(/\n/g, ' ');
        if (content.length > 1 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        toks.push({ t: 2, s: content });
        i = found + m; start = i; continue;
      }
      i += m; continue;
    }
    if (cc === 42 || cc === 95) { // * _
      const ch = src[i];
      let m = 1;
      while (src.charCodeAt(i + m) === cc) m++;
      const before = i > 0 ? src[i - 1] : '';
      const after = i + m < n ? src[i + m] : '';
      const leftFl = !isSpaceCh(after) && (!isPunctCh(after) || isSpaceCh(before) || isPunctCh(before));
      const rightFl = !isSpaceCh(before) && (!isPunctCh(before) || isSpaceCh(after) || isPunctCh(after));
      let canOpen, canClose;
      if (ch === '*') { canOpen = leftFl; canClose = rightFl; }
      else {
        canOpen = leftFl && (!rightFl || isPunctCh(before));
        canClose = rightFl && (!leftFl || isPunctCh(after));
      }
      if (canOpen || canClose) {
        flush(i);
        toks.push({ t: 1, c: ch, n: m, o: canOpen, cl: canClose });
        i += m; start = i; continue;
      }
      i += m; continue; // not a delimiter: leave the run in the text
    }
    if (cc === 10) { // newline: hard break iff 2+ trailing spaces
      let k = i - 1, spaces = 0;
      while (k >= start && src.charCodeAt(k) === 32) { spaces++; k--; }
      if (spaces >= 2) {
        flush(i - spaces);
        toks.push({ t: 3 });
        i++;
        while (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9) i++;
        start = i; continue;
      }
      i++; continue;
    }
    // __PHASE2_INLINE__: links, images, autolinks, email, strikethrough,
    // inline HTML go here — dispatch cases for '[', '!', '<', '~' that
    // flush the text run and push Phase 2 tokens.
    i++;
  }
  flush(n);
  processEm(toks);
  return renderInline(toks);
}

// CommonMark delimiter-stack emphasis, left-to-right over closers.
function processEm(toks) {
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (typeof t !== 'object' || t.t !== 1 || !t.cl || t.n <= 0) { i++; continue; }
    let j = i - 1, matched = false;
    while (j >= 0) {
      const o = toks[j];
      if (typeof o === 'object' && o.t === 1 && o.o && o.n > 0 && o.c === t.c) {
        if ((o.o && o.cl) || (t.o && t.cl)) {
          if ((o.n + t.n) % 3 === 0 && !(o.n % 3 === 0 && t.n % 3 === 0)) { j--; continue; }
        }
        const use = (o.n >= 2 && t.n >= 2) ? 2 : 1;
        const node = { t: 5, tag: use === 2 ? 'strong' : 'em', kids: toks.slice(j + 1, i) };
        o.n -= use; t.n -= use;
        const rep = [];
        if (o.n > 0) rep.push(o);
        rep.push(node);
        if (t.n > 0) rep.push(t);
        toks.splice(j, i - j + 1, ...rep);
        i = j + rep.length - 1;
        matched = true;
        break;
      }
      j--;
    }
    if (!matched) i++;
  }
}

function renderInline(toks) {
  let out = '';
  for (const t of toks) {
    if (typeof t === 'string') out += escText(t);
    else if (t.t === 1) out += t.c.repeat(t.n);
    else if (t.t === 2) out += '<code>' + escRaw(t.s) + '</code>';
    else if (t.t === 3) out += '<br>';
    else if (t.t === 5) out += '<' + t.tag + '>' + renderInline(t.kids) + '</' + t.tag + '>';
    // __PHASE2_INLINE__: render Phase 2 token kinds here.
  }
  return out;
}

// ---------- entry point ----------
export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const lines = src.split('\n');
  const refs = collectRefs(lines);
  const out = [];
  parseBlocks(lines, 0, lines.length, out, refs, false, null);
  return out.join('');
}
