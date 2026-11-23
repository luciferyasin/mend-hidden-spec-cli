// main.ts is mend, the CLI SPEC.md specifies (version 1 of the spec). It applies an edit an AI model
// wrote to a tree of text files, in any of the four formats models use: a unified diff (often with
// wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
// JSON. Every file is changed or nothing is. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]` with the working directory as the root of the tree.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): that hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: nothing is written and exactly this one line is printed. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed with this code, about this path; the patch's other edits still run. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed from each, and no
 *  empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3): not empty, no leading /, no backslash, and no empty, . or .. segment. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk.
 *  `moves` records each successful move edit, for the R lines of section 2. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One edit of a patch, applied to the tree the earlier edits left. Throws Fail when it fails. */
type Edit = (tree: Tree, strict: boolean) => void;

// ---------------------------------------------------------------------------
// Files as lines (section 3) and matching at three tiers (section 5)
// ---------------------------------------------------------------------------

/** A file read as lines: its own line break, its lines, and whether it ends with a line break. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitText(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    parts.pop();
    fin = true;
  }
  return { lines: parts, br, final: fin };
}

function joinText(fl: FileLines): string {
  if (fl.lines.length === 0) return '';
  return fl.lines.join(fl.br) + (fl.final ? fl.br : '');
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => stripTrail(s.replace(/^[ \t]+/, ''));

/** Two lines equal at a tier: 0 exact, 1 ignoring trailing spaces and tabs, 2 ignoring both ends. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every position at or after `from` where O's lines match the file's lines at this tier. */
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const res: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineEq(lines[i + k]!, O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

interface Found {
  tier: number;
  occ: number[];
}

/** The first tier at which O occurs at or after `from` (tier 0 only when strict), and its positions. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of a hunk or chunk body: a tag (' ', '-', '+' or '\') and the text after it. */
type BodyLine = { tag: string; text: string };

/** A tier-2 re-indent (section 5): a non-blank new line that starts with P has that P replaced by F. */
function reindent(text: string, F: string, P: string): string {
  if (text.trim() === '') return text;
  if (text.startsWith(P)) return F + text.slice(P.length);
  return text;
}

/** The lines a matched hunk or chunk writes in place of O: context lines are the file's own matched
 *  lines, '-' lines drop out, '+' lines are written as they are (re-indented at tier 2). */
function buildSegment(body: BodyLine[], lines: string[], pos: number, O: string[], tier: number): string[] {
  const F = tier === 2 ? leadWs(lines[pos] ?? '') : '';
  const P = tier === 2 ? leadWs(O[0] ?? '') : '';
  const out: string[] = [];
  let oi = 0;
  for (const e of body) {
    if (e.tag === ' ') {
      out.push(lines[pos + oi]!);
      oi += 1;
    } else if (e.tag === '-') {
      oi += 1;
    } else if (e.tag === '+') {
      out.push(tier === 2 ? reindent(e.text, F, P) : e.text);
    }
  }
  return out;
}

/** Whether a '\' line follows the body's last context or '+' line (the no-final-break marker). */
function bsAfterLastCP(body: BodyLine[]): boolean {
  let last = -1;
  body.forEach((e, i) => {
    if (e.tag === ' ' || e.tag === '+') last = i;
  });
  if (last < 0) return false;
  return body.slice(last + 1).some((e) => e.tag === '\\');
}

/** Whether a '\' line follows the body's last '+' line. */
function bsAfterLastPlus(body: BodyLine[]): boolean {
  let last = -1;
  body.forEach((e, i) => {
    if (e.tag === '+') last = i;
  });
  if (last < 0) return false;
  return body.slice(last + 1).some((e) => e.tag === '\\');
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

interface UHunk {
  a: number;
  body: (BodyLine & { empty?: boolean })[];
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  oldPath?: string | null; // null: /dev/null
  newPath?: string | null;
  hasPair: boolean;
  newFile: boolean;
  delFile: boolean;
  header: boolean; // still before the section's first hunk
  hunks: UHunk[];
}

function unifiedEdits(lines: string[]): Edit[] {
  const stripPre = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  /** The path a --- or +++ line names: after the four characters, up to the first tab, trimmed. */
  const headPath = (line: string): string | null => {
    let t = line.slice(4);
    const tab = t.indexOf('\t');
    if (tab >= 0) t = t.slice(0, tab);
    t = t.trim();
    if (t === '/dev/null') return null;
    return stripPre(t);
  };
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { gitOld: m[1]!, gitNew: m[2]!, hasPair: false, newFile: false, delFile: false, header: true, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.header && !cur.hasPair) {
        cur.oldPath = headPath(line);
        cur.newPath = headPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        cur = { hasPair: true, newFile: false, delFile: false, header: true, hunks: [], oldPath: headPath(line), newPath: headPath(lines[i + 1]!) };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.header) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ') && cur.oldPath === undefined) {
        cur.oldPath = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ') && cur.newPath === undefined) {
        cur.newPath = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i += 1;
        continue;
      }
      // index, mode, similarity and any other header line is ignored.
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.header = false;
      const body: (BodyLine & { empty?: boolean })[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          body.push({ tag: ' ', text: '', empty: true });
          j += 1;
          continue;
        }
        const c = l[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ tag: c, text: l.slice(1) });
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s));
}

/** One unified section is one edit: a creation, a deletion, a move, or a change of one path. */
function unifiedEdit(s: USection): Edit {
  return (tree, strict) => {
    const oldP = s.oldPath !== undefined ? s.oldPath : (s.gitOld ?? null);
    const newP = s.newPath !== undefined ? s.newPath : (s.gitNew ?? null);
    if ((oldP === null || s.newFile) && newP !== null) {
      // A creation: the file is the + lines of all its hunks, in order.
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out: string[] = [];
      let lastPlus: (BodyLine & { empty?: boolean })[] | null = null;
      for (const h of s.hunks) {
        for (const e of h.body) {
          if (e.tag === '+') {
            out.push(e.text);
            lastPlus = h.body;
          }
        }
      }
      let text = '';
      if (out.length > 0) text = out.join('\n') + (lastPlus !== null && bsAfterLastPlus(lastPlus) ? '' : '\n');
      tree.now.set(newP, text);
      return;
    }
    if ((newP === null || s.delFile) && oldP !== null) {
      // A deletion: the file is deleted and its hunks are not read.
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) return; // /dev/null on both sides: nothing to do
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const fl = splitText(before);
    let d = 0; // the sum over this section's hunks applied so far of (N's length minus O's length)
    for (const h of s.hunks) {
      const O = h.body.filter((e) => e.tag === ' ' || e.tag === '-').map((e) => e.text);
      const nLen = h.body.filter((e) => e.tag === ' ' || e.tag === '+').length;
      if (O.length === 0) {
        const seg = h.body.filter((e) => e.tag === '+').map((e) => e.text);
        const at = Math.min(h.a + d, fl.lines.length);
        const atEnd = at === fl.lines.length;
        fl.lines.splice(at, 0, ...seg);
        if (atEnd) fl.final = !bsAfterLastCP(h.body);
        d += seg.length;
      } else {
        const found = findTier(fl.lines, O, strict);
        if (found === null) throw new Fail('no-match', oldP);
        const target = h.a - 1 + d;
        let pos = found.occ[0]!;
        for (const p of found.occ) {
          if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
        }
        const toEnd = pos + O.length === fl.lines.length;
        const seg = buildSegment(h.body, fl.lines, pos, O, found.tier);
        fl.lines.splice(pos, O.length, ...seg);
        if (toEnd) fl.final = !bsAfterLastCP(h.body);
        d += nLen - O.length;
      }
    }
    const text = joinText(fl);
    if (oldP !== newP) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.moves.push({ old: oldP, new: newP });
    } else {
      tree.now.set(oldP, text);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

function srEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let lastEnd = 0; // the patch line just after the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    // The path is the nearest line before the SEARCH line, and after the previous block, that is
    // not blank and does not (trimmed) start with three backticks.
    let path: string | null = null;
    for (let m = searchLine - 1; m >= lastEnd; m--) {
      const l = lines[m]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep)));
    prevPath = path;
    lastEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree, strict) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      // An empty old text creates the file with the new lines.
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fl = splitText(before);
    const found = findTier(fl.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const seg = newLines.map((t) => (found.tier === 2 ? reindent(t, leadWs(fl.lines[pos]!), leadWs(oldLines[0]!)) : t));
    fl.lines.splice(pos, oldLines.length, ...seg);
    tree.now.set(path, joinText(fl));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const starts = (l: string): 'add' | 'delete' | 'update' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : l.startsWith('*** Update File: ') ? 'update' : null;
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = starts(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(line.indexOf(':') + 1).trim();
    const secLine = i + 1;
    const raw: { text: string; no: number }[] = [];
    let j = i + 1;
    while (j < last && starts(lines[j]!) === null) {
      raw.push({ text: lines[j]!, no: j + 1 });
      j += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    edits.push(v4aSection(kind, path, raw, secLine));
    i = j;
  }
  return edits;
}

/** One V4A section is one edit. Its lines are read (and parse faults found) as the section is built. */
function v4aSection(kind: 'add' | 'delete' | 'update', path: string, raw: { text: string; no: number }[], secLine: number): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const r of raw) {
      if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else if (r.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${r.no}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (const r of raw) {
      if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // Update File: an optional Move to as its first line, then chunks.
  let moveTo: string | null = null;
  let start = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    start = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (let k = start; k < raw.length; k++) {
    const r = raw[k]!;
    const l = r.text;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
    } else if (l === '*** End of File') {
      if (cur === null) {
        cur = { anchor: null, eof: true, body: [] };
        chunks.push(cur);
      } else {
        cur.eof = true;
      }
      cur = null;
    } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      cur.body.push({ tag: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
    } else {
      throw new Exit2(`error: parse ${r.no}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
  return (tree, strict) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const fl = splitText(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        // The anchor is found at the first tier where a line at or after the cursor equals it.
        let at = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let x = cursor; x < fl.lines.length; x++) {
            if (lineEq(fl.lines[x]!, ch.anchor, t)) {
              at = x;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const O = ch.body.filter((e) => e.tag === ' ' || e.tag === '-').map((e) => e.text);
      if (O.length === 0) {
        const seg = ch.body.filter((e) => e.tag === '+').map((e) => e.text);
        const at = ch.eof ? fl.lines.length : Math.min(cursor, fl.lines.length);
        fl.lines.splice(at, 0, ...seg);
        cursor = at + seg.length;
      } else {
        const tiers = strict ? [0] : [0, 1, 2];
        let found: Found | null = null;
        for (const t of tiers) {
          let occ = occurrences(fl.lines, O, t, cursor);
          if (ch.eof) occ = occ.filter((p) => p + O.length === fl.lines.length);
          if (occ.length > 0) {
            found = { tier: t, occ };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        const seg = buildSegment(ch.body, fl.lines, pos, O, found.tier);
        fl.lines.splice(pos, O.length, ...seg);
        cursor = pos + seg.length;
      }
    }
    const text = joinText(fl);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one (a parse fault, section 9). */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text); // a JSON create writes its file_text byte for byte
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      // In a CRLF file the text and both strings are read with every \r\n as \n, and the result
      // is written back with \r\n. The match is exact; no tier applies.
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const fl = splitText(before);
      if (line < 0 || line > fl.lines.length) throw new Fail('no-match', p);
      fl.lines.splice(line, 0, ...add);
      tree.now.set(p, joinText(fl)); // the file's final break stays as it was
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    // Array form: any fault is a parse error at the line where the array starts.
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  // JSON Lines form: one edit object a line, blank lines ignored.
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Detecting the format (section 4), the command line (section 1),
// output and exit codes (section 2), order and atomicity (section 10)
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines)
          : kind === 'search-replace'
            ? srEdits(lines)
            : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  // Edits apply in the patch's order, each to the tree the earlier ones left; a failed edit
  // changes nothing and the edits after it still run.
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // One line for each path whose state changed, in byte order of the paths; a successful move
  // replaces its pair's D and A lines with one R line, sorted by the new path.
  const finalVal = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const movePairs = tree.moves.filter(
    (m) => tree.original(m.old) !== null && finalVal(m.old) === null && tree.original(m.new) === null && finalVal(m.new) !== null,
  );
  const covered = new Set<string>();
  for (const m of movePairs) {
    covered.add(m.old);
    covered.add(m.new);
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now || covered.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of movePairs) rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, now] of tree.now) {
      const was = tree.original(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
