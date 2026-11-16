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

function countCells(row) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '|' && !isEscapedPipe(row, i)) { cells.push(cur); cur = ''; }
    else cur += row[i];
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.length;
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

// Strip n columns starting at index si (which sits at column sc), expanding
// the remainder of the leading whitespace run to spaces when a tab straddles
// the boundary — a tab's width is fixed by its original column.
function stripFrom(line, si, sc, n) {
  let col = sc, i = si;
  while (i < line.length && col < sc + n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w > sc + n) {
        let rest = col + w - (sc + n), j = i + 1, cc = col + w;
        while (j < line.length) {
          const d = line.charCodeAt(j);
          if (d === 32) { rest++; cc++; j++; }
          else if (d === 9) { const ww = 4 - (cc % 4); rest += ww; cc += ww; j++; }
          else break;
        }
        return ' '.repeat(rest) + line.slice(j);
      }
      col += w; i++;
    } else break;
  }
  return line.slice(i);
}

// Strip n columns of indent from the line start (a straddling tab -> spaces).
function stripIndent(line, n) {
  return stripFrom(line, 0, 0, n);
}

// Like stripIndent, but the FULL leading whitespace run is expanded to
// spaces from its true column before slicing (marked's J()): a tab's width
// is fixed by its raw column, and outer strips already expanded theirs, so
// current-string columns are exact. Expanding only the boundary tab (as
// before) used the post-strip column and was wrong after two strips
// (quote->list, list->list). Fenced-code and indented-code strips do NOT
// expand (marked keeps a raw tab there) — they still use stripIndent.
function stripIndentTab(line, n) {
  if (n <= 0) return line;
  let col = 0, i = 0, spaces = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { spaces++; col++; i++; }
    else if (c === 9) { const w = 4 - (col % 4); spaces += w; col += w; i++; }
    else break;
  }
  if (i === 0) return line;
  if (spaces <= n) return line.slice(i);
  return ' '.repeat(spaces - n) + line.slice(i);
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
  if (wcol >= 5) return [ord, ch, num, col + mw + 1, after + 1, stripFrom(line, after, col + mw, 1)];
  return [ord, ch, num, col + mw + wcol, j];
}

// ---------- reference definitions ----------
// True if s contains a `[` not escaped by an odd run of backslashes.
function hasUnescapedBracket(s) {
  for (let q = 0; q < s.length; q++) {
    if (s[q] !== '[') continue;
    let n = 0;
    while (q - 1 - n >= 0 && s[q - 1 - n] === '\\') n++;
    if (n % 2 === 0) return true;
  }
  return false;
}

// True if s[idx] is preceded by an odd run of backslashes.
function isEscapedAt(s, idx) {
  let n = 0;
  while (idx - 1 - n >= 0 && s[idx - 1 - n] === '\\') n++;
  return n % 2 === 1;
}

// Skip spaces/tabs/newlines in a joined def string.
function skipDefWs(s, p) {
  while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
  return p;
}

function countNl(s, a, b) {
  let n = 0;
  for (let k = a; k < b; k++) if (s[k] === '\n') n++;
  return n;
}

// Scan a title starting at s[p] (a quote char). Returns [title, endIndex]
// where endIndex is just past the closing quote (only ws to EOL after it),
// or null. Backslash unescapes ASCII punctuation only.
function scanDefTitle(s, p) {
  const q = s[p], closeQ = q === '(' ? ')' : q;
  let m = p + 1, t = '';
  while (m < s.length) {
    const c = s[m];
    if (c === '\\' && m + 1 < s.length && s[m + 1] !== '\n' && ASCII_PUNCT.has(s[m + 1])) { t += s[m + 1]; m += 2; continue; }
    if (c === closeQ) {
      let r = m + 1;
      while (r < s.length && (s[r] === ' ' || s[r] === '\t')) r++;
      if (r < s.length && s[r] !== '\n') return null;
      return [t, m + 1];
    }
    if (q === '(' && c === '(') return null;
    t += c; m++;
  }
  return null;
}

// Array-form definition parse: the label, dest and title may each span
// lines (but never a blank line). Returns [linesConsumed, label, dest,
// title] or null.
function parseDefArr(L, i, e) {
  const first = L[i];
  let ci = 0, sp = 0;
  while (ci < first.length && (first[ci] === ' ' || first[ci] === '\t')) {
    sp += first[ci] === ' ' ? 1 : 4 - (sp % 4); ci++;
    if (sp > 3) return null;
  }
  if (first[ci] !== '[') return null;
  let end = i;
  while (end < e && end < i + 10 && !isBlank(L[end])) end++;
  const s = L.slice(i, end).join('\n');
  let p = ci + 1, labelEnd = -1;
  while (p < s.length) {
    const c = s[p];
    if (c === '[' && !isEscapedAt(s, p)) return null;
    if (c === ']' && !isEscapedAt(s, p)) { labelEnd = p; break; }
    p++;
  }
  if (labelEnd < 0) return null;
  const labelRaw = s.slice(ci + 1, labelEnd);
  if (labelRaw.length === 0 || labelRaw.length > 999 || labelRaw.trim() === '') return null;
  if (s[labelEnd + 1] !== ':') return null;
  p = skipDefWs(s, labelEnd + 2);
  if (p >= s.length) return null;
  let dest;
  if (s[p] === '<') {
    const gt = s.indexOf('>', p + 1);
    const nl = s.indexOf('\n', p + 1);
    if (gt < 0 || (nl >= 0 && nl < gt)) return null;
    dest = s.slice(p + 1, gt);
    if (dest.indexOf('<') >= 0 || /[\x00-\x1f\x7f]/.test(dest)) return null;
    p = gt + 1;
  } else {
    let depth = 0, k = p;
    while (k < s.length) {
      const c = s[k];
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '\\' && k + 1 < s.length && s[k + 1] !== '\n') { k += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      k++;
    }
    if (k === p || depth !== 0) return null;
    dest = s.slice(p, k);
    p = k;
  }
  const label = normLabel(labelRaw);
  const destLines = 1 + countNl(s, 0, p);
  let r = p;
  while (r < s.length && (s[r] === ' ' || s[r] === '\t')) r++;
  if (r < s.length && s[r] !== '\n' && r === p) return null; // junk/title needs ws after dest
  if (r >= s.length || s[r] === '\n') {
    if (r < s.length && s[r] === '\n') {
      let t0 = r + 1;
      while (t0 < s.length && (s[t0] === ' ' || s[t0] === '\t')) t0++;
      if (t0 < s.length) {
        const qc = s[t0];
        if (qc === '"' || qc === "'" || qc === '(') {
          // a next-line title that fails to parse leaves a valid def
          const t = scanDefTitle(s, t0);
          if (t !== null) return [1 + countNl(s, 0, t[1]), label, dest, t[0]];
        }
      }
    }
    return [destLines, label, dest, ''];
  }
  const qc = s[r];
  if (qc !== '"' && qc !== "'" && qc !== '(') return null;
  const t = scanDefTitle(s, r);
  if (t === null) return null;
  return [1 + countNl(s, 0, t[1]), label, dest, t[0]];
}

// Single-line wrapper for callers without the array (lazy checks, prev-line).
function parseDef(line, nextLine) {
  return nextLine == null ? parseDefArr([line], 0, 1) : parseDefArr([line, nextLine], 0, 2);
}

// ---------- refs pre-pass ----------
// Strip quote '>' and list prefixes repeatedly (refs pre-pass only).
function stripPrefixes(line) {
  let s = line, qd = 0;
  for (let k = 0; k < 8; k++) {
    const [col, ci] = indentInfo(s);
    if (col > 3) return [s, qd];
    const first = s.charCodeAt(ci);
    if (first === 62) {
      qd++;
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
    if (m) { s = m.length > 5 ? m[5] : s.slice(m[4]); continue; }
    return [s, qd];
  }
  return [s, qd];
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

// Content indent of the list item enclosing line i, or -1. The opener line
// itself may carry the marker; otherwise the nearest marker above owns it
// only if every line between belongs to the item (indent >= cCol).
function enclosingItemCol(lines, i) {
  const s0 = stripQuoteLevels(lines[i]);
  const [c0, ci0] = indentInfo(s0);
  if (c0 <= 3) {
    const m0 = matchListMarker(s0, ci0, c0);
    if (m0) return m0[3];
  }
  const opCol = indentInfo(lines[i])[0];
  for (let k = i - 1; k >= Math.max(0, i - 40); k--) {
    if (isBlank(lines[k])) continue;
    const sq = stripQuoteLevels(lines[k]);
    const [c2, ci2] = indentInfo(sq);
    if (c2 > 3) continue;
    const m = matchListMarker(sq, ci2, c2);
    if (!m) continue;
    const cCol = m[3];
    if (opCol < cCol) return -1;
    for (let t = k + 1; t < i; t++) {
      if (isBlank(lines[t])) continue;
      if (indentInfo(lines[t])[0] < cCol) return -1;
    }
    return cCol;
  }
  return -1;
}

// Collect link reference definitions from the whole document first: marked
// resolves forward references, so defs must be known before rendering.
function collectRefs(lines) {
  const refs = new Map();
  const stripped = new Array(lines.length);
  const qdepth = new Array(lines.length);
  for (let k = 0; k < lines.length; k++) {
    const [s, qd] = stripPrefixes(lines[k]);
    stripped[k] = s; qdepth[k] = qd;
  }
  let fenceCh = 0, fenceLen = 0, fenceDepth = 0, skipUntil = -1;
  for (let i = 0; i < lines.length; i++) {
    const s = stripped[i];
    if (fenceCh) {
      if (isBlank(s)) continue;
      if (qdepth[i] < fenceDepth) {
        // line left the fence's container: fence ends unclosed; the line
        // itself is processed normally below
        fenceCh = 0;
      } else if (qdepth[i] === fenceDepth) {
        const [col, ci] = indentInfo(s);
        if (col <= 3 && s.charCodeAt(ci) === fenceCh) {
          let n = 0, j = ci;
          while (s.charCodeAt(j) === fenceCh) { n++; j++; }
          let ok = n >= fenceLen;
          while (ok && j < s.length) { const c = s.charCodeAt(j); if (c !== 32 && c !== 9) ok = false; j++; }
          if (ok) { fenceCh = 0; continue; }
        }
        continue;
      } else continue; // deeper container: fence content
    }
    const [col, ci] = indentInfo(s);
    if (col <= 3) {
      const c = s.charCodeAt(ci);
      if (c === 96 || c === 126) {
        let n = 0, j = ci;
        while (s.charCodeAt(j) === c) { n++; j++; }
        if (n >= 3 && (c === 126 || s.indexOf('`', j) < 0)) {
          // A fence inside a list item whose next content line is dedented
          // below the item is empty (marked): the item ends at once and a
          // later closer line becomes a fresh fence. Don't enter fence mode.
          let empty = false;
          const cCol = enclosingItemCol(lines, i);
          if (cCol >= 0) {
            let j2 = i + 1;
            while (j2 < lines.length && isBlank(lines[j2])) j2++;
            if (j2 < lines.length && indentInfo(lines[j2])[0] < cCol) empty = true;
          }
          if (!empty) { fenceCh = c; fenceLen = n; fenceDepth = qdepth[i]; continue; }
        }
      }
    }
    if (i < skipUntil) continue;
    if (i !== skipUntil && !prevAllowsDef(i === 0 ? null : stripped[i - 1])) continue;
    const d = parseDefArr(stripped, i, stripped.length);
    if (d) {
      if (!refs.has(d[1])) refs.set(d[1], { href: d[2], title: d[3] });
      skipUntil = i + d[0];
    }
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

// Setext underline: returns 1 (=), 2 (-), or 0. The run must be contiguous
// (only trailing whitespace may follow); `= =` and `--- -` are not underlines.
function setextKind(line, ci) {
  const c = line.charCodeAt(ci);
  if (c !== 61 && c !== 45) return 0;
  let seenWs = false;
  for (let i = ci + 1; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d === c) { if (seenWs) return 0; }
    else if (d === 32 || d === 9) seenWs = true;
    else return 0;
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
  if (line.charCodeAt(ci + 1) !== 47 && (tag === 'script' || tag === 'pre' || tag === 'style' || tag === 'textarea')) {
    return [1, '</' + tag];
  }
  // Type 7: a complete open/close tag alone on the line (strict tag pattern
  // — quoted `>` counts, but an invalid attribute name does not).
  const tagRe = line.charCodeAt(ci + 1) === 47 ? CLOSE_TAG_RE : OPEN_TAG_RE;
  tagRe.lastIndex = ci;
  const tm = tagRe.exec(line);
  if (tm && /^[ \t]*$/.test(line.slice(ci + tm[0].length))) {
    if (BLOCK_TAGS.has(tag)) return [6, null];
    return [7, null];
  }
  if (BLOCK_TAGS.has(tag)) return [6, null];
  return [0, null];
}

// Consume an HTML block starting at lines[i]; returns [htmlText, nextIndex].
// `top` is true only for the document's top-level call: the trailing-newline
// rule for a block ending at the final '' applies only there (inside a quote
// or list item the '' is synthetic and marked emits no trailing newline).
function parseHtmlBlock(lines, i, e, top) {
  const [col, ci] = indentInfo(lines[i]);
  const [kind, closer] = htmlBlockKind(lines[i], ci);
  let j = i;
  if (kind <= 5) {
    const needle = closer.toLowerCase();
    for (; j < e; j++) {
      if (lines[j].toLowerCase().indexOf(needle) >= 0) { j++; break; }
    }
    // trailing newline kept unless a blank line follows (probe2g2:
    // html-para and html-eof both end with \n; only a following blank
    // line drops it). A TAB-only line is NOT blank for this rule — like
    // the table rule, marked treats tab lines as content (doc-15: -->
    // followed by a tab-only line keeps the \n). Covers a block ending
    // at the end of a quote/list inner array (doc-19) as well as EOF.
    const text = lines.slice(i, j).join('\n');
    const nextBlank = j < e && isBlank(lines[j]) && lines[j].indexOf('\t') < 0;
    return [j < e && (!nextBlank || (top && j === e - 1 && lines[j] === '')) ? text + '\n' : text, j];
  }
  for (; j < e; j++) {
    if (isBlank(lines[j])) break;
  }
  const text = lines.slice(i, j).join('\n');
  return [top && j === e - 1 && lines[j] === '' ? text + '\n' : text, j];
}

// ---------- block parser ----------
// lazy: null, or a boolean array (same indexing as lines) marking lazy
// continuation lines, which never count as setext underlines or table rows.
function parseBlocks(L, s, e, out, refs, tight, lazy, looseOut, top, inItem) {
  let i = s, prevBlock = false, prevDef = false, sawBlank = false;
  while (i < e) {
    const line = L[i];
    if (isBlank(line)) { if (prevBlock || prevDef) sawBlank = true; i++; continue; }
    const d = parseDefArr(L, i, e);
    if (d) { if (sawBlank && looseOut) looseOut.loose = true; sawBlank = false; prevDef = true; i += d[0]; continue; }
    if (sawBlank && looseOut) looseOut.loose = true;
    sawBlank = false;
    prevBlock = true;
    const [ind, ci] = indentInfo(line);
    if (ind >= 4) { i = parseIndentedCode(L, i, e, out); continue; }
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
        const hb = parseHtmlBlock(L, i, e, top);
        out.push(hb[0]); i = hb[1]; continue;
      }
    } else if (ch >= 48 && ch <= 57) {
      const m = matchListMarker(line, ci, ind);
      if (m) { i = parseList(L, i, e, out, refs, m); continue; }
    }
    if (line.indexOf('|', ci) >= 0 && i + 1 < e) {
      const al = matchDelimRow(L[i + 1]);
      if (al && countCells(line) === al.length) { i = parseTable(L, i, e, out, refs); continue; }
    }
    i = parseParagraph(L, i, e, out, refs, tight, lazy, inItem);
  }
  return i;
}

// Does line j start a block that interrupts a paragraph? (def/html7/code no)
// inItem: inside list-item content marked lexes with top=false, so an
// ordered list with ANY start number interrupts (verified by probe).
function interruptsPara(L, j, e, inItem) {
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
    return m !== null && (inItem || m[2] === 1) && m[4] < line.length;
  }
  if (ch === 60) {
    const k = htmlBlockKind(line, ci)[0];
    return k >= 1 && k <= 6;
  }
  return false;
}

function parseParagraph(L, i, e, out, refs, tight, lazy, inItem) {
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
    if (interruptsPara(L, j, e, inItem) && !(lazy && lazy[j])) break;
    j++;
  }
  // Join with single \n. (A code-merged line followed by a plain line is
  // "\n\n" in marked — its code token swallows the newline — but only when
  // our strip amounts match marked's exactly; where the item indent
  // differs the extra \n misfires and regresses docs (doc-04/15/30 in
  // 2j). The strip itself is the win; the \n\n refinement needs the
  // indent alignment fixed first. See the phase report.)
  const text = L.slice(i, j).join('\n');
  // Setext heading?
  if (j < e && !isBlank(L[j])) {
    const [ind2, ci2] = indentInfo(L[j]);
    const sk = ind2 <= 3 ? setextKind(L[j], ci2) : 0;
    if (sk > 0 && !(lazy && lazy[j])) {
      out.push('<h' + sk + '>' + inline(text.trim(), refs) + '</h' + sk + '>\n');
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
  if (content.length && content[content.length - 1] !== '') text += '\n';
  const lang = info === '' ? '' : ' class="language-' + escText(unescBS(info.split(/\s+/)[0])) + '"';
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
      content.push(stripIndent(line, 4));
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
  // Expand the whitespace run after '>' from its raw column (col+1),
  // then drop the single optional space (marked's J() on the run).
  // Expanding only a tab immediately after '> ' left tabs after two or
  // more spaces raw, with the wrong column for later strips.
  const j = ci + 1;
  let c2 = col + 1, k = j, spaces = 0;
  while (k < line.length) {
    const d = line.charCodeAt(k);
    if (d === 32) { spaces++; c2++; k++; }
    else if (d === 9) { const w = 4 - (c2 % 4); spaces += w; c2 += w; k++; }
    else break;
  }
  if (spaces === 0) return line.slice(j);
  return ' '.repeat(spaces - 1) + line.slice(k);
}

// Strip repeated leading quote prefixes ('> > foo' -> 'foo').
function stripQuoteLevels(line) {
  let s = line;
  for (let k = 0; k < 8; k++) {
    const [col, ci] = indentInfo(s);
    if (col > 3 || s.charCodeAt(ci) !== 62) return s;
    s = stripQuotePrefix(s, ci, col);
  }
  return s;
}

// True if the last block of `inner` (quote/list content lines) is an open
// paragraph — the only block a lazy continuation line may join. Scans the
// lines tracking fence / html-block / table state. `lazy` (same indexing)
// marks lines that already joined a paragraph: they count as paragraph
// text even when they look like a block start (a code-merged '# head').
function lastInnerIsPara(inner, lazy) {
  let fenceCh = 0, fenceLen = 0, htmlKind = 0, htmlCloser = null, inTable = false;
  let last = 0; // 0 none, 1 paragraph, 2 other block
  for (let k = 0; k < inner.length; k++) {
    // classify the line at its deepest quote level: a nested quote's
    // paragraph is open for lazy continuation too (cm-250/251/292/293)
    const line = stripQuoteLevels(inner[k]);
    if (lazy && lazy[k]) { last = 1; continue; }
    if (fenceCh) {
      const [col, ci] = indentInfo(line);
      if (col <= 3 && line.charCodeAt(ci) === fenceCh) {
        let n = 0, j = ci;
        while (line.charCodeAt(j) === fenceCh) { n++; j++; }
        let ok = n >= fenceLen;
        while (ok && j < line.length) { const d = line.charCodeAt(j); if (d !== 32 && d !== 9) ok = false; j++; }
        if (ok) { fenceCh = 0; last = 2; continue; }
      }
      last = 2; continue;
    }
    if (htmlKind > 0) {
      if (htmlKind <= 5) {
        if (line.toLowerCase().indexOf(htmlCloser) >= 0) htmlKind = 0;
        last = 2; continue;
      }
      if (isBlank(line)) { htmlKind = 0; last = 0; continue; }
      last = 2; continue;
    }
    if (isBlank(line)) { last = 0; inTable = false; continue; }
    const [ind, ci] = indentInfo(line);
    if (ind >= 4) { last = 2; inTable = false; continue; }
    const ch = line.charCodeAt(ci);
    if (inTable) {
      if ((ch === 35 && matchATX(line, ci)) || ch === 62 || ((ch === 96 || ch === 126) && matchFence(line, ci)) || isHR(line, ci) || matchListMarker(line, ci, ind) || (ch === 60 && htmlBlockKind(line, ci)[0] > 0)) inTable = false;
      else { last = 2; continue; }
    }
    if (ch === 35 && matchATX(line, ci)) { last = 2; continue; }
    if (ch === 62) { last = 2; continue; }
    if (ch === 96 || ch === 126) {
      const f = matchFence(line, ci);
      if (f) { fenceCh = f[0]; fenceLen = f[1]; last = 2; continue; }
    }
    if (ch === 45 || ch === 43 || ch === 42 || ch === 95) {
      if (isHR(line, ci)) { last = 2; continue; }
    }
    if (ch === 60) {
      const hk = htmlBlockKind(line, ci);
      if (hk[0] > 0) { htmlKind = hk[0]; htmlCloser = hk[1] ? hk[1].toLowerCase() : null; last = 2; continue; }
    }
    const dm = matchDelimRow(line);
    if (dm && last === 1) { last = 2; inTable = true; continue; }
    if (last === 1 && ind <= 3 && setextKind(line, ci) > 0) { last = 2; continue; }
    const lm = matchListMarker(line, ci, ind);
    if (lm) {
      // A list item whose first block is a paragraph leaves it open for lazy
      // continuation (CommonMark allows lazy lines into a nested item's para).
      const rest = lm.length > 5 ? lm[5] : line.slice(lm[4]);
      if (isBlank(rest)) { last = 2; continue; }
      const [ri, rc] = indentInfo(rest);
      if (ri >= 4) { last = 2; continue; }
      const rch = rest.charCodeAt(rc);
      if ((rch === 35 && matchATX(rest, rc)) || ((rch === 96 || rch === 126) && matchFence(rest, rc)) || isHR(rest, rc) || (rch === 60 && htmlBlockKind(rest, rc)[0] > 0) || parseDef(rest, null) !== null) { last = 2; continue; }
      last = 1; continue;
    }
    const dd = parseDef(line, k + 1 < inner.length ? stripQuoteLevels(inner[k + 1]) : null);
    if (dd) { k += dd[0] - 1; last = 2; continue; }
    last = 1;
  }
  return last === 1;
}

// True if the open paragraph (lastInnerIsPara must already be true) is a
// DIRECT paragraph of this container — not inside a nested list item or
// quote. Walks back over the paragraph's run: it is nested iff the run
// starts at a list-marker or quote line. A code-merge (an indented line
// joining the paragraph with 4 columns stripped) applies only to a direct
// paragraph: inside a nested container the inner container applies its own
// strip when it parses the line (marked lexes the inner text separately).
function lastInnerDirectPara(lines, lazy) {
  let k = lines.length - 1;
  while (k >= 0 && isBlank(lines[k])) k--;
  if (k < 0) return false;
  let start = k;
  while (start > 0) {
    const prev = lines[start - 1];
    if (isBlank(prev)) break;
    if (lazy && lazy[start - 1]) { start--; continue; }
    const [ind, ci] = indentInfo(prev);
    if (ind <= 3) {
      const ch = prev.charCodeAt(ci);
      if (ch === 62) return false; // quote line: para lives in a quote
      if (matchListMarker(prev, ci, ind)) return false; // nested list item
      if (ch === 35 && matchATX(prev, ci)) break;
      if ((ch === 96 || ch === 126) && matchFence(prev, ci)) break;
      if (isHR(prev, ci)) break;
      if (ch === 60 && htmlBlockKind(prev, ci)[0] > 0) break;
      if (setextKind(prev, ci) > 0) break;
      if (matchDelimRow(prev)) break;
      if (parseDef(prev, null) !== null) break;
    } else break; // indented line: ends the run (indented code)
    start--;
  }
  // the run starts at lines[start]: nested iff it is a quote/marker line
  const [ind0, ci0] = indentInfo(lines[start]);
  if (ind0 <= 3) {
    if (lines[start].charCodeAt(ci0) === 62) return false;
    if (matchListMarker(lines[start], ci0, ind0)) return false;
  }
  return true;
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
    // lazy continuation: only when the last inner block is a paragraph.
    // marked keeps the raw line (leading whitespace included); a line
    // indented >= 4 is lexed as indented code merged into the paragraph,
    // with 4 columns stripped (marked's code-merge in blockTokens).
    if (lastInnerIsPara(inner, lazy) && !interruptsPara(L, j, e) && parseDef(line, null) === null) {
      const [lind, lci] = indentInfo(line);
      // marked neutralizes a setext-looking lazy line with 4 spaces
      // (blockquoteSetextReplace); without it cm-093 regresses.
      if (lind <= 3 && setextKind(line, lci) > 0) { inner.push('    ' + line.slice(lci)); lazy.push(true); }
      else if (lind >= 4) { inner.push(stripIndentTab(line, 4)); lazy.push(2); }
      else { inner.push(line); lazy.push(true); }
      j++;
      continue;
    }
    break;
  }
  // the region ended at a blank line: keep it, so an unclosed fence / html
  // block at the end still sees the document's trailing newline
  if (j < e && isBlank(L[j])) { inner.push(''); lazy.push(false); }
  const sub = [];
  parseBlocks(inner, 0, inner.length, sub, refs, false, lazy, null, undefined, false);
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
    if (ind <= 3 && isHR(line, ci)) break; // an HR line ends the list
    const m = ind <= 3 ? matchListMarker(line, ci, ind) : null;
    if (!m || m[0] !== ord || m[1] !== ch || ind >= lastCCol) break;
    // collect one item
    const content = [], lazy = [];
    const cCol = m[3];
    lastCCol = cCol;
    const firstLine = m.length > 5 ? m[5] : line.slice(m[4]);
    content.push(firstLine);
    lazy.push(false);
    j++;
    let endBlank = false;
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
          else if (content.some((l) => !isBlank(l)) && indentInfo(L[k])[0] >= cCol) nextIsContent = true;
        }
        if (nextIsItem) { loose = true; endBlank = true; j = k; break; }
        if (nextIsContent) {
          while (j < k) { content.push(''); lazy.push(false); j++; }
          continue;
        }
        endBlank = true;
        break;
      }
      const [ind2, ci2] = indentInfo(ln);
      const m2 = ind2 <= 3 ? matchListMarker(ln, ci2, ind2) : null;
      if (m2 && m2[0] === ord && m2[1] === ch && ind2 < cCol) break;
      if (m2 && ind2 < cCol) break; // different marker: list ends here
      if (ind2 >= cCol) {
        const stripped = stripIndentTab(ln, cCol);
        // code-merge: a line still indented >= 4 that joins a DIRECT
        // paragraph is lexed as indented code merged into it, with 4 more
        // columns stripped (marked's code-merge). Inside a nested list or
        // quote the inner container applies its own strip instead.
        const [rind] = indentInfo(stripped);
        if (rind >= 4 && lastInnerIsPara(content, lazy) && lastInnerDirectPara(content, lazy)) {
          content.push(stripIndentTab(stripped, 4));
          lazy.push(2);
        } else {
          content.push(stripped);
          lazy.push(false);
        }
        j++;
        continue;
      }
      // lazy continuation of the item's paragraph: marked keeps the raw
      // line; >= 4 indent is a code-merge (4 columns stripped). Marked
      // rejects a lazy line when the previous item line (after the
      // item-indent strip) starts its content at column >= 4 — exactly
      // what a code-merged line had before its strip.
      let pc = content.length - 1;
      while (pc >= 0 && isBlank(content[pc])) pc--;
      if (pc < 0 || lazy[pc] !== 2) if (lastInnerIsPara(content, lazy) && !interruptsPara(L, j, e, true) && parseDef(ln, null) === null) {
        const [lind] = indentInfo(ln);
        if (lind >= 4) { content.push(stripIndentTab(ln, 4)); lazy.push(2); }
        else { content.push(ln); lazy.push(true); }
        j++;
        continue;
      }
      break;
    }
    while (content.length && isBlank(content[content.length - 1])) { content.pop(); lazy.pop(); }
    if (endBlank) { content.push(''); lazy.push(false); }
    items.push([content, lazy]);
  }
  const tag = ord ? (startNum !== 1 ? '<ol start="' + startNum + '">\n' : '<ol>\n') : '<ul>\n';
  out.push(tag);
  // Two-pass looseness: parse each item tight first, collecting whether any
  // item holds two blocks separated by a blank line at its own level; only
  // then (if loose) re-parse with <p> wrappers. A blank inside a nested
  // sublist does not loosen the outer list.
  const rendered = [];
  for (const [content, lazy] of items) {
    let task = null;
    if (content.length && !isBlank(content[0])) {
      const t = /^\[( |x|X)\](?: |$)/.exec(content[0]);
      if (t) {
        task = t[1] !== ' ';
        content[0] = content[0].slice(t[0].length);
      }
    }
    const lo = { loose: false };
    const sub = [];
    parseBlocks(content, 0, content.length, sub, refs, true, lazy, lo, undefined, true);
    if (lo.loose) loose = true;
    rendered.push([sub, task]);
  }
  if (loose) {
    for (let q = 0; q < items.length; q++) {
      const sub = [];
      parseBlocks(items[q][0], 0, items[q][0].length, sub, refs, false, items[q][1], null, undefined, true);
      rendered[q][0] = sub;
    }
  }
  for (const [sub, task] of rendered) {
    let body = sub.join('');
    if (task !== null) {
      const inp = '<input' + (task ? ' checked=""' : '') + ' disabled="" type="checkbox"> ';
      // marked puts the checkbox INSIDE the first <p> of a loose item
      body = body.startsWith('<p>') ? '<p>' + inp + body.slice(3) : inp + body;
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
    if (line.length === 0) break;
    // whitespace-only line: ends the table UNLESS it contains a tab
    // (marked: tab-only line is an all-empty row, table continues;
    // spaces-only line ends the table like an empty line — probe2g1)
    if (isBlank(line)) {
      if (line.indexOf('\t') < 0) break;
      rows.push(splitCells('', ncols)); j++; continue;
    }
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

// ---------- inline link helpers ----------
// Backslash-unescape: `\` + ASCII punct -> punct; lone `\` stays.
function unescBS(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length && ASCII_PUNCT.has(s[i + 1])) { out += s[i + 1]; i += 2; }
    else { out += s[i]; i++; }
  }
  return out;
}

function normLabel(s) {
  // CommonMark label folding: lower->upper->lower folds ß→ss, ligatures, etc.
  return s.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase().toLowerCase();
}

// Raw dest -> final href (null only on lone surrogates).
function procHref(raw) {
  return encodeHref(unesc(unescBS(raw)));
}

// Raw inline title -> final title text (refs' titles are already unescaped).
function procTitle(raw) {
  return unesc(unescBS(raw));
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '');
}

// Does a token tree contain a bracket link (t:6)? Recurses into em/del
// kids; NOT into image kids (a link in alt text never deactivates an
// outer link) and autolinks (t:10) never count.
function kidsContainLink(kids) {
  for (const t of kids) {
    if (typeof t !== 'object') continue;
    if (t.t === 6) return true;
    if ((t.t === 5 || t.t === 8) && kidsContainLink(t.kids)) return true;
  }
  return false;
}

// Find the `]` matching src[i] === '[' (balance counting; skips `\x`
// escapes and code spans). Returns index or -1.
function findCloseBracket(src, i) {
  const n = src.length;
  let depth = 0, j = i + 1;
  while (j < n) {
    const cc = src.charCodeAt(j);
    if (cc === 92) { j += 2; continue; }
    if (cc === 96) {
      // marked's label regex pairs a backtick run with the NEXT backtick
      // run of ANY length as a code-span unit (`` a ` b `` pairs the
      // opening `` with the middle `); a run with no following run kills
      // the label, except a run of 2+ immediately before `]`.
      let m = 1;
      while (src.charCodeAt(j + m) === 96) m++;
      const b = src.indexOf('`', j + m);
      if (b < 0) {
        if (m >= 2 && src.charCodeAt(j + m) === 93) { j += m; continue; }
        return -1;
      }
      let r = 1;
      while (src.charCodeAt(b + r) === 96) r++;
      j = b + r; continue;
    }
    if (cc === 60) { // skip autolinks / inline HTML: `]` inside never closes
      const A = tryAutolink(src, j) || tryHtml(src, j);
      if (A) { j = A.end; continue; }
      j++; continue;
    }
    if (cc === 91) { depth++; j++; continue; }
    if (cc === 93) {
      if (depth === 0) return j;
      depth--; j++; continue;
    }
    j++;
  }
  return -1;
}

function skipInlineWs(src, j) {
  const n = src.length;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10) j++;
    else break;
  }
  return j;
}

// Parse "(dest title)" starting at src[i] (just after '(').
// Returns {href, title, end} with RAW href/title, or null.
function parseInlineDest(src, i) {
  const n = src.length;
  let j = skipInlineWs(src, i);
  let dest = '';
  if (src.charCodeAt(j) === 60) { // <...>
    let k = j + 1, found = -1;
    while (k < n) {
      const cc = src.charCodeAt(k);
      if (cc === 92 && k + 1 < n && ASCII_PUNCT.has(src[k + 1])) { k += 2; continue; }
      if (cc === 60) return null;
      if (cc === 10 || cc < 32 || cc === 127) return null; // <> dest rejects \n/controls
      if (cc === 62) { found = k; break; }
      k++;
    }
    if (found < 0) return null;
    dest = src.slice(j + 1, found);
    j = found + 1;
  } else { // bare dest: balanced parens, no spaces/controls
    let depth = 0, k = j;
    while (k < n) {
      const cc = src.charCodeAt(k);
      if (cc === 32 || cc === 9 || cc === 10) break;
      if (cc < 32 || cc === 127) break;
      if (cc === 92 && k + 1 < n && ASCII_PUNCT.has(src[k + 1])) { k += 2; continue; }
      if (cc === 40) { depth++; k++; continue; }
      if (cc === 41) { if (depth === 0) break; depth--; k++; continue; }
      k++;
    }
    if (depth !== 0) return null;
    dest = src.slice(j, k);
    j = k;
  }
  const j0 = j;
  j = skipInlineWs(src, j);
  let title = '';
  const qc = src.charCodeAt(j);
  if ((qc === 34 || qc === 39 || qc === 40) && j === j0) return null; // title needs ws after dest
  if (qc === 34 || qc === 39 || qc === 40) { // " ' (
    const q = src[j], closeQ = q === '(' ? ')' : q;
    let k = j + 1, t = '', found = false;
    while (k < n) {
      const cc = src.charCodeAt(k);
      if (cc === 92 && k + 1 < n) { t += src.slice(k, k + 2); k += 2; continue; }
      if (src[k] === closeQ) { found = true; break; }
      if (q === '(' && cc === 40) return null;
      t += src[k]; k++;
    }
    if (!found) return null;
    title = t;
    j = skipInlineWs(src, k + 1);
  }
  if (src.charCodeAt(j) !== 41) return null;
  return { href: dest, title, end: j + 1 };
}

// Build a link/image result from raw text + href/title. Links are
// rejected when the text contains a nested bracket link; images are not.
function makeLink(text, href, title, end, refs, img) {
  const kids = inlineTokens(text, refs, true);
  if (!img && kidsContainLink(kids)) return null;
  return { end, href, title, kids };
}

// Try to parse a link (img=false) or image (img=true) starting at src[i]
// ('[' or '!['). Returns {end, href, title, kids} or null.
function tryLink(src, i, refs, img) {
  const open = img ? i + 1 : i;
  const close = findCloseBracket(src, open);
  if (close < 0) return null;
  const text = src.slice(open + 1, close);
  const after = close + 1;
  if (src.charCodeAt(after) === 40) { // inline
    const d = parseInlineDest(src, after + 1);
    if (d) return makeLink(text, procHref(d.href), procTitle(d.title), d.end, refs, img);
    // inline-dest failure falls back to shortcut reference
    const ref0 = refs.get(normLabel(text));
    if (!ref0) return null;
    return makeLink(text, procHref(ref0.href), unesc(ref0.title), close + 1, refs, img);
  }
  if (src.charCodeAt(after) === 91) { // full / collapsed ref
    let j = after + 1, labelEnd = -1;
    while (j < src.length) {
      const cc = src.charCodeAt(j);
      if (cc === 92) { j += 2; continue; }
      if (cc === 93) { labelEnd = j; break; }
      j++;
    }
    if (labelEnd < 0) { // unclosed 2nd bracket: fall back to shortcut
      const ref = refs.get(normLabel(text));
      if (!ref) return null;
      return makeLink(text, procHref(ref.href), unesc(ref.title), close + 1, refs, img);
    }
    let label = src.slice(after + 1, labelEnd);
    if (label === '') label = text;
    else if (hasUnescapedBracket(label)) return null;
    const ref = refs.get(normLabel(label));
    if (!ref) return null; // no shortcut fallback
    return makeLink(text, procHref(ref.href), unesc(ref.title), labelEnd + 1, refs, img);
  }
  const ref = refs.get(normLabel(text)); // shortcut
  if (!ref) return null;
  return makeLink(text, procHref(ref.href), unesc(ref.title), close + 1, refs, img);
}

// ---------- autolinks / inline HTML / strikethrough ----------
const EMAIL_FULL = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const OPEN_TAG_RE = /<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:[^ \t\n"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/y;
const CLOSE_TAG_RE = /<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/y;

// Try a bracketed autolink at src[i] === '<'. Returns {href, text, end}.
function tryAutolink(src, i) {
  let j = i + 1;
  const n = src.length;
  while (j < n) {
    const cc = src.charCodeAt(j);
    if (cc === 62) break;
    if (cc === 32 || cc === 9 || cc === 10 || cc === 60) return null;
    j++;
  }
  if (j >= n || j === i + 1) return null;
  const inner = src.slice(i + 1, j);
  const colon = inner.indexOf(':');
  if (colon >= 2 && colon <= 32 && colon + 1 < inner.length) {
    const c0 = inner.charCodeAt(0);
    let ok = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
    for (let k = 1; ok && k < colon; k++) {
      const c = inner.charCodeAt(k);
      if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 46 || c === 45)) ok = false;
    }
    if (ok) return { href: encodeHref(inner), text: inner, end: j + 1 };
  }
  if (EMAIL_FULL.test(inner)) {
    return { href: encodeHref('mailto:' + inner), text: inner, end: j + 1 };
  }
  return null;
}

// Try inline HTML at src[i] === '<'. Returns {s, end} or null.
function tryHtml(src, i) {
  if (src.startsWith('<!--', i)) {
    const e = src.indexOf('-->', i + 2);
    return e >= 0 ? { s: src.slice(i, e + 3), end: e + 3 } : null;
  }
  if (src.startsWith('<![CDATA[', i)) {
    const e = src.indexOf(']]>', i + 9);
    return e >= 0 ? { s: src.slice(i, e + 3), end: e + 3 } : null;
  }
  if (src.startsWith('<?', i)) {
    const e = src.indexOf('?>', i + 2);
    return e >= 0 ? { s: src.slice(i, e + 2), end: e + 2 } : null;
  }
  if (src.charCodeAt(i + 1) === 33) { // <! + letter (declaration)
    const c = src.charCodeAt(i + 2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      const e = src.indexOf('>', i + 2);
      if (e >= 0) return { s: src.slice(i, e + 1), end: e + 1 };
    }
    return null;
  }
  const re = src.charCodeAt(i + 1) === 47 ? CLOSE_TAG_RE : OPEN_TAG_RE;
  re.lastIndex = i;
  const m = re.exec(src);
  return m ? { s: m[0], end: i + m[0].length } : null;
}

// Try strikethrough at src[i] === '~'. The closing run must have EXACTLY
// the opening run's length. Like marked's delRDelim scan, opener-like
// runs (space/punct before + plain char after, or space before + punct
// after) nest instead of closing; space before + space/end after is
// ignored (doc-32: ~~we ~~x~~ less~~ nests).
function tryDel(src, i, refs, inLink) {
  let m = 1;
  while (src.charCodeAt(i + m) === 126) m++;
  if (m > 2) return null; // opening run is at most ~~
  const after = src[i + m];
  if (after === undefined || isSpaceCh(after)) return null;
  const n = src.length;
  let depth = m, j = i + m + 1;
  while (j < n) {
    const b = src.indexOf('~', j);
    if (b < 0) return null;
    let r = 1;
    while (src.charCodeAt(b + r) === 126) r++;
    if (r === m) {
      const before = src[b - 1] ?? '', afterC = src[b + r] ?? '';
      const bSpace = isSpaceCh(before), bPunct = isPunctCh(before);
      const aSpace = isSpaceCh(afterC), aPunct = isPunctCh(afterC);
      const aPlain = !aSpace && !aPunct && afterC !== '';
      const isOpener = ((bSpace || bPunct) && aPlain) || (bSpace && aPunct);
      if (isOpener) depth += r;
      else if (!(bSpace && aSpace)) {
        depth -= r;
        if (depth <= 0) {
          return { kids: inlineTokens(src.slice(i + m, b), refs, inLink), end: b + m };
        }
      }
    }
    j = b + r;
  }
  return null;
}

// ---------- GFM www / email autolinks (post-scan pass over text tokens) ----------
const URL_STICKY = /(?:(?:[Hh][Tt][Tt][Pp][Ss]?|[Ff][Tt][Pp]):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/y;
const EMAIL_STICKY = /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![a-zA-Z0-9-_])/y;
const EMAIL_LOCAL_CHARS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&\'*+/=?^_`{|}~-'.split(''));
const WWW_PREV_OK = new Set([' ', '\t', '\n', '\r', '\f', '\v', '(', '*', '_', '~']);
const TRAIL_PUNCT = /[?!.,:;*_~]+$/;

// marked's _backpedal regex, applied until stable: a trailing ')' is kept
// when it closes a balanced (...) group inside the URL (doc-12/37), and
// the match ends before an unmatched '(' (doc-08).
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedal(u) {
  let prev;
  do {
    prev = u;
    u = BACKPEDAL_RE.exec(u)?.[0] ?? '';
  } while (u !== prev);
  return u;
}

// Extend a greedy URL match that reached the end of token ti across
// following text-ish tokens. Returns {url, drop, tail, lits} or null if
// no extension tokens follow. drop = following tokens fully consumed;
// tail = leftover raw text of the first partially-consumed token (null
// if the URL ends on a token boundary); lits = [[relOffset, raw]] for
// following delimiter/escape tokens past the URL end, which become
// literal text (the backpedal-trimmed tail is never emphasis).
function spanUrl(toks, ti, ext0) {
  let ext = ext0;
  const segs = []; // [contribLen, token]
  let k = ti + 1;
  while (k < toks.length) {
    const tk = toks[k];
    if (typeof tk === 'string') {
      const p = /^[^\s<]*/.exec(tk)[0].length;
      if (p === 0) break;
      segs.push([p, tk]);
      ext += tk.slice(0, p);
      if (p < tk.length) break;
      k++;
      continue;
    }
    if (typeof tk === 'object' && tk.t === 1) {
      segs.push([tk.n, tk]);
      ext += tk.c.repeat(tk.n);
      k++;
      continue;
    }
    if (typeof tk === 'object' && tk.t === 0) {
      segs.push([2, tk]);
      ext += '\\' + tk.s;
      k++;
      continue;
    }
    if (typeof tk === 'object' && tk.t === 3) {
      // only a BACKSLASH hard break extends the URL (marked's greedy tail
      // swallows the backslash); a 2-space break ends it (doc-09/10/29).
      // The URL cannot continue past the newline either way.
      if (!tk.bs) break;
      segs.push([1, tk]);
      ext += '\\';
      k++;
      break;
    }
    break;
  }
  if (segs.length === 0) return null;
  const url = backpedal(ext);
  let rem = url.length - ext0.length;
  if (rem <= 0) return { url, drop: 0, tail: null, lits: [] };
  let drop = 0, tail = null;
  const lits = [];
  for (let si = 0; si < segs.length; si++) {
    const [len, tk] = segs[si];
    if (typeof tk === 'object' && tk.t === 3) {
      // backslash inside the URL: the hard break becomes a soft newline
      if (rem >= 1) { tail = '\n'; rem = 0; }
      break;
    }
    if (rem >= len) { drop++; rem -= len; continue; }
    if (rem > 0) {
      if (typeof tk === 'string') tail = tk.slice(rem);
      else if (tk.t === 1) tail = tk.c.repeat(tk.n - rem);
      else tail = ('\\' + tk.s).slice(rem);
      rem = 0;
      // segments after the partial one become literal text
      for (let sj = si + 1; sj < segs.length; sj++) {
        const tk2 = segs[sj][1];
        if (typeof tk2 !== 'string') lits.push([sj + 1, tk2.t === 1 ? tk2.c.repeat(tk2.n) : '\\' + tk2.s]);
      }
      break;
    }
    // rem === 0: this and later segments are past the URL end
    if (typeof tk !== 'string') lits.push([si + 1, tk.t === 1 ? tk.c.repeat(tk.n) : '\\' + tk.s]);
  }
  return { url, drop, tail, lits };
}

// Split string tokens on www./http/email autolinks. Runs before processEm.
// URL matches may span following delimiter/escape/text tokens (marked's
// greedy tail swallows `*` etc.); email local parts may span preceding
// delimiter tokens (`_foo@bar.com`).
function linkifyTokens(toks, gated) {
  for (let ti = 0; ti < toks.length; ti++) {
    const t = toks[ti];
    if (typeof t !== 'string') continue;
    if (gated && gated.has(ti)) continue; // scanned while inside <a>
    const s = t;
    let prevChar = '';
    if (ti > 0) {
      const p = toks[ti - 1];
      if (typeof p === 'string') prevChar = p[p.length - 1];
      else if (p.t === 1) prevChar = p.c;
    }
    let curPrev = prevChar, pos = 0, emitFrom = 0, found = false;
    let backDrop = 0, fwdDrop = 0, fwdTail = null, fwdLits = [];
    const segs = [];
    while (pos < s.length) {
      const w = s.indexOf('www.', pos);
      const u = s.indexOf('://', pos);
      const at = s.indexOf('@', pos);
      let kind = 0, idx = -1;
      if (w >= 0 && (idx < 0 || w < idx)) { kind = 1; idx = w; }
      if (u >= 0 && (idx < 0 || u < idx)) { kind = 2; idx = u; }
      if (at >= 0 && (idx < 0 || at < idx)) { kind = 3; idx = at; }
      if (idx < 0) break;
      if (kind === 1 || kind === 2) {
        let start;
        if (kind === 1) {
          const pc = idx === emitFrom ? curPrev : s[idx - 1];
          if (pc !== '' && !WWW_PREV_OK.has(pc)) { pos = idx + 4; continue; }
          start = idx;
        } else {
          start = -1;
          if (s.slice(idx - 5, idx).toLowerCase() === 'https') start = idx - 5;
          else if (s.slice(idx - 4, idx).toLowerCase() === 'http') start = idx - 4;
          else if (s.slice(idx - 3, idx).toLowerCase() === 'ftp') start = idx - 3;
          if (start < 0 || start < emitFrom) { pos = idx + 3; continue; }
        }
        URL_STICKY.lastIndex = start;
        const m = URL_STICKY.exec(s);
        if (!m) { pos = idx + (kind === 1 ? 4 : 3); continue; }
        let url = backpedal(m[0]);
        let endPos = start + url.length;
        if (kind === 1 && url.length < 5) { pos = idx + 4; continue; }
        if (start + m[0].length === s.length) {
          const sp = spanUrl(toks, ti, m[0]);
          if (sp) {
            url = sp.url;
            if (url.length > m[0].length) {
              endPos = s.length;
              fwdDrop = sp.drop;
              fwdTail = sp.tail;
              fwdLits = sp.lits;
            } else {
              endPos = start + url.length;
            }
          }
        }
        if (start > emitFrom) segs.push(s.slice(emitFrom, start));
        const href = kind === 1 ? procHref('http://' + url) : procHref(url);
        segs.push({ t: 10, href, text: url });
        pos = emitFrom = endPos;
        curPrev = ''; found = true;
        continue;
      }
      // '@' — email: scan back for local-part start (not past emitFrom)
      let ls = idx;
      while (ls > emitFrom && EMAIL_LOCAL_CHARS.has(s[ls - 1])) ls--;
      EMAIL_STICKY.lastIndex = ls;
      const m = EMAIL_STICKY.exec(s);
      if (!m || m.index + m[0].length <= idx) { pos = idx + 1; continue; }
      // the lookahead char may live in the next token (a `_` delimiter run).
      // But marked tokenizes emphasis first: if that `_` closes an earlier
      // `_` opener, the email sits inside <em> and IS linked (doc-31/38).
      // Allow the link when the nearest preceding `_` delimiter is an
      // opener-only run; otherwise keep rejecting (a@b.com_ with no opener).
      if (m.index + m[0].length === s.length && ti + 1 < toks.length) {
        const nx = toks[ti + 1];
        if (typeof nx === 'object' && nx.t === 1 && nx.c === '_') {
          let allow = false;
          for (let k = ti - 1; k >= 0; k--) {
            const pk = toks[k];
            if (typeof pk === 'object' && pk.t === 1 && pk.c === '_') { allow = pk.o && !pk.cl; break; }
          }
          if (!allow) { pos = idx + 1; continue; }
        }
      }
      let pre = '';
      if (m.index === emitFrom && emitFrom === 0) {
        let k = ti - 1;
        while (k >= 0) {
          const pk = toks[k];
          if (typeof pk === 'object' && pk.t === 1 && EMAIL_LOCAL_CHARS.has(pk.c)) {
            pre = pk.c.repeat(pk.n) + pre;
            backDrop++;
            k--;
          } else break;
        }
      }
      // mailto:/xmpp: immediately before the email makes one link; xmpp
      // also takes one path segment. The scheme must not follow a word char.
      let linkStart = m.index, scheme = '';
      for (const sch of ['mailto:', 'xmpp:']) {
        const ss = m.index - sch.length;
        if (ss >= emitFrom && ss >= 0 && s.slice(ss, m.index) === sch) {
          const pc = ss === 0 ? prevChar : s[ss - 1];
          if (pc === '' || !/[A-Za-z0-9]/.test(pc)) { linkStart = ss; scheme = sch; break; }
        }
      }
      let path = '';
      if (scheme === 'xmpp:') {
        const pe = m.index + m[0].length;
        if (s[pe] === '/') {
          const pm = /^\/[A-Za-z0-9@.]+/.exec(s.slice(pe));
          if (pm) path = pm[0];
        }
      }
      if (linkStart > emitFrom) segs.push(s.slice(emitFrom, linkStart));
      const email = pre + m[0];
      const full = scheme + email + path;
      const href = scheme === 'xmpp:' ? 'xmpp:' + email + path : 'mailto:' + email;
      segs.push({ t: 10, href: procHref(href), text: full });
      pos = emitFrom = m.index + m[0].length + path.length;
      curPrev = ''; found = true;
    }
    if (!found) continue;
    if (emitFrom < s.length) segs.push(s.slice(emitFrom));
    if (backDrop > 0) { toks.splice(ti - backDrop, backDrop); ti -= backDrop; }
    if (fwdDrop > 0) toks.splice(ti + 1, fwdDrop);
    if (fwdTail !== null) toks[ti + 1] = fwdTail;
    for (const [rel, raw] of fwdLits) toks[ti + rel - fwdDrop] = raw;
    toks.splice(ti, 1, ...segs);
    ti += segs.length - 1;
  }
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

// marked's lexer.state.inLink: bare URL/email autolinks are suppressed
// inside link text, and an unclosed inline <a> tag leaves inLink set for
// the rest of the document (deferred inline queue, doc order). Reset per
// parse(); nested link-text tokenization must not leak tag toggles out.
let DOC_IN_LINK = false;

// marked's emStrong masking (#n): link-like [...](...) spans (blockSkip
// link pattern, equal-run code spans in the label) hide their emphasis /
// del delimiters from the emStrong search — even when the link itself
// fails to form (doc-16/20/23). Code-span inner backticks are normalized
// to '+' first (anyPunctuationOutsideCode).
const LINK_SPAN_STICKY = /\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^\\()]|\((?:\\[\s\S]|[^\\()])*\))*\)/y;
const CODE_SPAN_NORM_RE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

function inlineTokens(src, refs, inLink) {
  // marked's inLink is per-block inline-lexing state: an unclosed <a> in
  // one paragraph does NOT suppress autolinks in later paragraphs
  // (probe2g3: marked links www after an unclosed-<a> paragraph; doc-31
  // regressed when the flag leaked across paragraphs). Reset per call.
  if (!inLink) DOC_IN_LINK = false;
  const toks = [];
  const gated = new Set();
  const n = src.length;
  let i = 0, start = 0;
  let normSrc = null, maskEnd = -1; // lazy emStrong-mask state (see below)
  const flush = (to) => { if (to > start) { if (DOC_IN_LINK) gated.add(toks.length); toks.push(src.slice(start, to)); } };
  while (i < n) {
    const cc = src.charCodeAt(i);
    if (cc === 92) { // backslash
      const nx = src[i + 1];
      if (nx === '\n') {
        flush(i); toks.push({ t: 3, bs: 1 }); i += 2;
        while (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9) i++;
        start = i; continue;
      }
      if (nx !== undefined && ASCII_PUNCT.has(nx)) {
        flush(i); toks.push({ t: 0, s: nx }); i += 2; start = i; continue;
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
      if (i < maskEnd) { i += m; continue; } // masked link span: literal
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
    if (cc === 91) { // '[' — link
      const L = tryLink(src, i, refs, false);
      if (L) {
        flush(i);
        toks.push({ t: 6, href: L.href, title: L.title, kids: L.kids });
        i = L.end; start = i; continue;
      }
      // tryLink failed: if this starts a blockSkip-style link span, mask
      // emphasis/del delimiters inside it (marked's #n masking).
      if (src.includes('](')) {
        if (normSrc === null) {
          normSrc = src.includes('`')
            ? src.replace(CODE_SPAN_NORM_RE, (m, r, inner) => r + inner.replace(/`/g, '+') + r)
            : src;
        }
        LINK_SPAN_STICKY.lastIndex = i;
        const lm = LINK_SPAN_STICKY.exec(normSrc);
        if (lm) maskEnd = Math.max(maskEnd, i + lm[0].length);
      }
      i++; continue;
    }
    if (cc === 33 && src.charCodeAt(i + 1) === 91) { // '![' — image
      const L = tryLink(src, i, refs, true);
      if (L) {
        flush(i);
        toks.push({ t: 7, src: L.href, title: L.title, kids: L.kids });
        i = L.end; start = i; continue;
      }
      i++; continue;
    }
    if (cc === 60) { // '<' — autolink or inline HTML
      const A = tryAutolink(src, i);
      if (A) {
        flush(i);
        toks.push({ t: 10, href: A.href, text: A.text });
        i = A.end; start = i; continue;
      }
      const H = tryHtml(src, i);
      if (H) {
        // flush BEFORE toggling: the text before this tag was scanned
        // under the pre-tag flag state (doc-31: a URL before <a> must
        // link; toggling first gated it wrongly).
        flush(i);
        if (!inLink) {
          if (/^<a[\s>]/i.test(H.s)) DOC_IN_LINK = true;
          else if (/^<\/a[\s>]/i.test(H.s)) DOC_IN_LINK = false;
        }
        toks.push({ t: 9, s: H.s });
        i = H.end; start = i; continue;
      }
      i++; continue;
    }
    if (cc === 126) { // '~' — strikethrough
      if (i < maskEnd) { i++; continue; } // masked link span: literal
      const D = tryDel(src, i, refs, inLink);
      if (D) {
        flush(i);
        toks.push({ t: 8, kids: D.kids });
        i = D.end; start = i; continue;
      }
      i++; continue;
    }
    i++;
  }
  flush(n);
  // marked gates its bare-URL/email tokenizer on !state.inLink AT EACH
  // POSITION: an <a> opening mid-paragraph suppresses only autolinks
  // after it, and a </a> re-enables them (doc-33: flag set by an early
  // <a />, cleared by a later </a> in the www paragraph — end-of-scan
  // gating linked www wrongly). Gate per text segment, not at end.
  if (!inLink) linkifyTokens(toks, gated);
  processEm(toks);
  return toks;
}

function inline(src, refs) {
  return renderInline(inlineTokens(src, refs));
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

// Plain-text rendering for image alt text: nested images/links contribute
// their text; HTML tags and hard breaks contribute nothing.
function renderPlainText(toks) {
  let out = '';
  for (const t of toks) {
    if (typeof t === 'string') out += escText(t);
    else if (t.t === 0) out += escText(t.s);
    else if (t.t === 1) out += t.c.repeat(t.n);
    else if (t.t === 2) out += escRaw(t.s);
    else if (t.t === 5 || t.t === 6 || t.t === 7 || t.t === 8) out += renderPlainText(t.kids);
    else if (t.t === 10) out += escRaw(t.text);
  }
  return out;
}

function renderInline(toks) {
  let out = '';
  for (const t of toks) {
    if (typeof t === 'string') out += escText(t);
    else if (t.t === 0) out += escText(t.s);
    else if (t.t === 1) out += t.c.repeat(t.n);
    else if (t.t === 2) out += '<code>' + escRaw(t.s) + '</code>';
    else if (t.t === 3) out += '<br>';
    else if (t.t === 5) out += '<' + t.tag + '>' + renderInline(t.kids) + '</' + t.tag + '>';
    else if (t.t === 6) {
      if (t.href === null) out += renderInline(t.kids);
      else {
        out += '<a href="' + escText(t.href) + '"';
        if (t.title) out += ' title="' + escText(t.title) + '"';
        out += '>' + renderInline(t.kids) + '</a>';
      }
    } else if (t.t === 7) {
      if (t.src === null) out += renderInline(t.kids);
      else {
        out += '<img src="' + escText(t.src) + '" alt="' + renderPlainText(t.kids) + '"';
        if (t.title) out += ' title="' + escText(t.title) + '"';
        out += '>';
      }
    } else if (t.t === 8) out += '<del>' + renderInline(t.kids) + '</del>';
    else if (t.t === 9) out += t.s;
    else if (t.t === 10) {
      if (t.href === null) out += escRaw(t.text);
      else out += '<a href="' + escRaw(t.href) + '">' + escRaw(t.text) + '</a>';
    }
  }
  return out;
}

// ---------- entry point ----------
export function parse(markdown) {
  DOC_IN_LINK = false;
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const lines = src.split('\n');
  const refs = collectRefs(lines);
  const out = [];
  parseBlocks(lines, 0, lines.length, out, refs, false, null, null, true);
  return out.join('');
}
