// Swift Site Builder — a fast drop-in for makefun-site 1.0.0.
//
// A from-scratch reimplementation of makefun-site's build (front matter,
// Markdown subset, template dialect, slug rule, report) that returns
// byte-identical answers while doing far less work than the reference:
//   - Markdown is lexed and rendered in a single fused pass over the lines
//     (no token objects, no second render pass).
//   - Inline rendering scans runs of plain text and only touches markup
//     characters; HTML escaping is done inline, never one regex call per char.
//   - slugify takes an ASCII fast path (no NFKD normalise, no regex) and
//     results are cached per run; tag slugs are computed once per tag.
//   - Front matter is parsed by hand over the already-split lines, and the
//     body is never re-joined and re-split for Markdown.
//   - Template rendering writes into an output array joined once.
//   - Word counting for reading time runs over the lines, not a re-joined body.
//   - No state is kept between cases: every cache is created inside run().
//
// Dependency-free ES module, standard library only (no imports at all).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const ESCMAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** JS \s: tab, LF, VT, FF, CR, space, NBSP, Ogham, en/em spaces, line/para sep, narrow NBSP, medium space, ideographic space, BOM. */
function isWSCode(c) {
  return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** `text` with & < > " and ' escaped; returns the input itself when nothing needs escaping. */
function escStr(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
      j++;
    }
    if (j > i) out += s.slice(i, j);
    if (j >= s.length) break;
    out += ESCMAP[s[j]];
    i = j + 1;
  }
  return out;
}

/** Append `s` escaped to the output array `out`. */
function escAppend(out, s) {
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
      j++;
    }
    if (j > i) out.push(s.slice(i, j));
    if (j >= s.length) break;
    out.push(ESCMAP[s[j]]);
    i = j + 1;
  }
}

/** The slug rule's tail: at most 64 characters, a "-" left at the cut dropped, "untitled" when nothing is left. */
function finishSlug(out) {
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end.
 * Pure-ASCII text normalises to itself and holds no combining marks, so it
 * takes the fast path with no normalise call and no regex.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) { ascii = false; break; }
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (!ascii) {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    gap = false;
    for (const ch of plain) {
      const cp = ch.codePointAt(0);
      let keep = null;
      if (cp >= 65 && cp <= 90) keep = String.fromCharCode(cp + 32);
      else if ((cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57)) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = finishSlug(out);
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let bad = raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45;
      if (!bad) for (const k of [0, 1, 2, 3, 5, 6, 8, 9]) { const c = raw.charCodeAt(k); if (c < 48 || c > 57) { bad = true; break; } }
      const y = bad ? 0 : Number(raw.slice(0, 4));
      const mo = bad ? 0 : Number(raw.slice(5, 7));
      const d = bad ? 0 : Number(raw.slice(8, 10));
      if (bad || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' }; }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) { const c = raw.charCodeAt(i); if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' }; }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // a slug may not open on '-'
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c >= 97 && c <= 122) { prevDash = false; continue; }
        if (c >= 48 && c <= 57) { prevDash = false; continue; }
        if (c === 45 && !prevDash) { prevDash = true; continue; }
        return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter: { data, bodyStart } (the body's first line index
 * in `lines`), or { error } with the first reason it is refused.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue; // blank, or a '#' comment
    let j = 0;
    while (j < line.length) { const c = line.charCodeAt(j); if (!((c >= 97 && c <= 122) || c === 95)) break; j++; }
    if (j === 0 || line.charCodeAt(j) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, j);
    let raw;
    if (j + 1 < line.length) {
      if (line.charCodeAt(j + 1) !== 32) return { error: `line ${i + 1} is not "key: value"` };
      raw = line.slice(j + 2);
    } else raw = '';
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    raw = raw.slice(0, e);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- Markdown

/** A line of only spaces and tabs (or empty). */
function isBlank(line) {
  for (let j = 0; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) return false; }
  return true;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence opener: its language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) return null; j++; }
  return lang;
}

/** A fence closer: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) return false; }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let s = d;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: d, text: line.slice(s, e) };
}

/** A thematic break: `---` or `***`, then spaces or tabs only. */
function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let j = 3; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) return false; }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/** A bullet item's text, or null. */
function bulletMatch(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's text, or null. */
function orderedMatch(line) {
  let j = 0;
  let digits = 0;
  while (j < line.length) { const c = line.charCodeAt(j); if (c < 48 || c > 57) break; digits++; j++; }
  if (digits >= 1 && digits <= 9 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) return line.slice(j + 2);
  return null;
}

/** A list continuation: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j < line.length && !isWSCode(line.charCodeAt(j));
}

/** The characters a backslash escapes. */
const ESCAPABLE_ARR = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE_ARR[ch.charCodeAt(0)] = 1;
const isEscapableCode = (c) => c < 128 && ESCAPABLE_ARR[c] === 1;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/** `s` rendered inline into `out`; `link(target)` is a link's href. */
function inlineInto(out, s, link) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    let j = i;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92 || c === 96 || c === 42 || c === 91 || c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
      j++;
    }
    if (j > i) out.push(s.slice(i, j));
    if (j >= n) break;
    i = j;
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < n && isEscapableCode(s.charCodeAt(i + 1))) {
        const nc = s[i + 1];
        out.push(ESCMAP[nc] || nc);
        i += 2;
      } else { out.push('\\'); i++; }
      continue;
    }
    if (c === 96) { // backtick: a code span closed by the next backtick, with at least one character between
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) { out.push('<code>'); escAppend(out, s.slice(i + 1, k)); out.push('</code>'); i = k + 1; }
      else { out.push('`'); i++; }
      continue;
    }
    if (c === 42) { // *
      if (s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) { out.push('<strong>'); inlineInto(out, s.slice(i + 2, k), link); out.push('</strong>'); i = k + 2; }
        else { out.push('**'); i += 2; }
      } else {
        const k = findSingleStar(s, i + 1);
        if (k > i + 1) { out.push('<em>'); inlineInto(out, s.slice(i + 1, k), link); out.push('</em>'); i = k + 1; }
        else { out.push('*'); i++; }
      }
      continue;
    }
    if (c === 91) { // [
      const k = findUnescaped(s, ']', i + 1);
      const m = (k !== -1 && s.charCodeAt(k + 1) === 40) ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="');
        escAppend(out, link(target));
        out.push('">');
        inlineInto(out, s.slice(i + 1, k), link);
        out.push('</a>');
        i = m + 1;
      } else { out.push('['); i++; }
      continue;
    }
    out.push(ESCMAP[s[i]]); // one of & < > " '
    i++;
  }
}

/**
 * `lines[start..]` rendered: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents, its excerpt, and its word count
 * (runs of characters other than whitespace, for reading time). Lexing and
 * rendering happen in one pass; no token objects are built. Every body line
 * is counted exactly once, where it is consumed.
 */
function renderMarkdown(lines, start, link, slugCache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let words = 0;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      words += countWords(line); // the opener line
      i++;
      const body = [];
      while (i < n && !isFenceClose(lines[i])) { words += countWords(lines[i]); body.push(lines[i++]); }
      if (i < n) words += countWords(lines[i]); // the closing fence line is body too
      i++;
      const out = [`<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>`];
      for (const l of body) { escAppend(out, l); out.push('\n'); }
      out.push('</code></pre>\n');
      blocks.push(out.join(''));
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      words += countWords(line);
      const id = uniqueSlug(slugify(hd.text, slugCache), ids);
      const o = [];
      inlineInto(o, hd.text, link);
      const html = o.join('');
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { words += countWords(line); blocks.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // blockquote
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        words += countWords(l);
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>\n');
      else {
        const o = [];
        inlineInto(o, kept.join('\n'), link);
        blocks.push(`<blockquote>\n<p>${o.join('')}</p>\n</blockquote>\n`);
      }
      continue;
    }
    const bullet = bulletMatch(line);
    const ordered = bullet === null ? orderedMatch(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let firstStart = 1;
      if (isOrdered) {
        let j = 0;
        let num = 0;
        while (j < line.length) { const c = line.charCodeAt(j); if (c < 48 || c > 57) break; num = num * 10 + (c - 48); j++; }
        firstStart = num;
      }
      while (i < n) {
        const m = isOrdered ? orderedMatch(lines[i]) : bulletMatch(lines[i]);
        if (m !== null) { words += countWords(lines[i]); items.push([trimLine(m)]); i++; }
        else if (isContinued(lines[i])) { words += countWords(lines[i]); items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const parts = [`${isOrdered && firstStart !== 1 ? `<ol start="${firstStart}">` : `<${tag}>`}\n`];
      for (const item of items) {
        const o = [];
        inlineInto(o, item.join('\n'), link);
        parts.push(`<li>${o.join('')}</li>\n`);
      }
      parts.push(`</${tag}>\n`);
      blocks.push(parts.join(''));
      continue;
    }
    const body = [trimLine(line)];
    words += countWords(line);
    i++;
    while (i < n && !endsParagraph(lines[i])) { words += countWords(lines[i]); body.push(trimLine(lines[i++])); }
    const o = [];
    inlineInto(o, body.join('\n'), link);
    const html = o.join('');
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '', words };
}

/** The words of one line: its runs of characters other than whitespace. */
function countWords(line) {
  let w = 0;
  let inWord = false;
  for (let j = 0; j < line.length; j++) {
    if (isWSCode(line.charCodeAt(j))) { inWord = false; continue; }
    if (!inWord) { w++; inWord = true; }
  }
  return w;
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function isSpacesTabs(s, a, b) {
  for (let k = a; k < b; k++) { const c = s.charCodeAt(k); if (c !== 32 && c !== 9) return false; }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpacesTabs(src, lineStart, open) && isSpacesTabs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }) into `out`. `ctx` holds the parsed templates. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escStr(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** A link's href: a target with a scheme, opening on `/` or `#`, is kept as written; any other is a path from the source's directory. */
function makeLink(dir, bySource, staticPaths, broken, base, srcPath) {
  return function link(target) {
    const c0 = target.charCodeAt(0);
    if (c0 === 47 || c0 === 35) return target; // '/' or '#'
    if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
      let j = 1;
      while (j < target.length) {
        const c = target.charCodeAt(j);
        if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) break;
        j++;
      }
      if (target.charCodeAt(j) === 58) return target; // a scheme
    }
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(dir, rel);
    if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
    if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
    broken.add(`broken-link ${srcPath} -> ${target}`);
    return target;
  };
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const lines = f.content.indexOf('\r') === -1 ? f.content.split('\n') : f.content.replace(/\r\n?/g, '\n').split('\n');
      sources.push({ path: f.path, lines });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const link = makeLink(dirOf(s.path), bySource, staticPaths, broken, base, s.path);
    const md = renderMarkdown(s.lines, s.bodyStart, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order, as { name, slug } pairs. */
  const ownTagList = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTagList(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) s.tagRefs = ownTagList(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it (built once per source and reused by its page).
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) {
    p.card = cardOf(p);
    cards.set(p, p.card);
  }
  /** A page as its layout reads it. */
  const pageOf = (s) => {
    const c = s.card ?? (s.card = cardOf(s));
    return {
      ...c,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  /** A tag as templates read it (its posts as cards). */
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
