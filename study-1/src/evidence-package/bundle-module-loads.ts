// Syntax-aware detection of a bare `@aws-sdk/` module load in a bundled ES module (RK-12; design
// §9.8 S3; BR-RUA-042). A plain text search is not enough: every real synthesized bundle quotes
// `require("@aws-sdk/signature-v4-crt")` and `import "@aws-sdk/signature-v4a"` inside the SDK's own
// error messages, so a text scan refused every real assembly (A-14 fix, found by WP-24 on
// 2026-10-06). The source is therefore walked as JavaScript tokens: comments and string, template
// and regular-expression literals are skipped, and only a keyword in code position, not a property
// name after `.`, can start a load. The load forms are a static import or re-export (`from "x"`),
// a side-effect import (`import "x"`), a dynamic `import("x")`, and a call of `require` or of
// esbuild's `__require` shim with a string literal.
//
// Whether a `/` starts a regular expression or divides depends on the token before it. The scan
// uses the usual reading: a regular expression may follow an operator, an opening bracket, a
// statement-level `}` or a keyword such as `return`, and division follows an operand. A `)`
// closing the condition of `if`, `while`, `for` or `with` counts as an operator.
//
// The walk is iterative and linear in the length of the source, so it is total on any text
// (A-05). It fails closed: when the source ends inside a comment, a literal or a template
// substitution, or a string or regular expression crosses a line break, the tokens cannot be
// trusted and the verdict falls back to the text search, which reports every quoted load too.

/** One load form whose specifier is a bare `@aws-sdk/` string, anchored at its keyword. */
const LOAD_AT_KEYWORD = /(?:from\s*|import\s*\(\s*|import\s*|(?:__)?require\s*\(\s*)["']@aws-sdk\//y;
/** The same forms anywhere in the text: the fail-closed verdict when the tokens cannot be trusted. */
const LOAD_ANYWHERE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\b(?:__)?require\s*\(\s*)["']@aws-sdk\//;
const LOAD_KEYWORDS: ReadonlySet<string> = new Set(['from', 'import', 'require', '__require']);
const REGEX_AFTER_KEYWORDS: ReadonlySet<string> = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);
const CONTROL_KEYWORDS: ReadonlySet<string> = new Set(['if', 'while', 'for', 'with']);

const HASHBANG = /#![^\n\r\u2028\u2029]*/y;
const WHITESPACE = /\s+/y;
const LINE_COMMENT = /\/\/[^\n\r\u2028\u2029]*/y;
const DOUBLE_QUOTED = /"(?:[^"\\\n\r]|\\(?:\r\n|[^]))*"/y;
const SINGLE_QUOTED = /'(?:[^'\\\n\r]|\\(?:\r\n|[^]))*'/y;
const TEMPLATE_TEXT = /(?:[^`\\$]|\\[^]|\$(?!\{))*/y;
const REGEX_LITERAL =
  /\/(?:[^/\\[\n\r\u2028\u2029]|\\[^\n\r\u2028\u2029]|\[(?:[^\]\\\n\r\u2028\u2029]|\\[^\n\r\u2028\u2029])*\])+\/[\w$]*/y;
// Identifier characters: ASCII word characters, `$`, escapes and any non-ASCII character that is
// not white space (a line or paragraph separator ends a word).
const WORD = /(?:(?!\s)[\w$\\\u0080-\uffff])+/y;
const NUMBER = /\.?\d[\w.]*/y;
const WORD_START = /(?!\s)[A-Za-z_$\\\u0080-\uffff]/;
const DIGIT = /\d/;

interface Scan {
  readonly source: string;
  index: number;
  /** Whether a `/` at the current position starts a regular expression. */
  regexAllowed: boolean;
  /** The keyword or identifier just read, or '' after any other token. */
  previousWord: string;
  /** Whether the previous token was `.`, so a word here is a property name. */
  afterDot: boolean;
  /** Per open `(`: whether its `)` closes a statement condition. */
  readonly parens: boolean[];
  /** Per open `{`: whether it opened a template substitution. */
  readonly braces: boolean[];
  /** The tokens cannot be trusted: an unterminated comment or literal. */
  untrusted: boolean;
  found: boolean;
}

type TokenReader = (scan: Scan) => void;

/**
 * True when the module source loads a bare `@aws-sdk/` specifier at run time; quoted text,
 * comments and property calls never count.
 *
 * @example
 * loadsBareAwsSdk('import { S3 } from "@aws-sdk/client-s3";'); // true
 * loadsBareAwsSdk('throw new Error(`call [require("@aws-sdk/x");]`);'); // false
 */
export function loadsBareAwsSdk(source: string): boolean {
  const scan = startScan(source);
  while (scan.index < source.length && !scan.found && !scan.untrusted) {
    readToken(scan);
  }
  const trusted = !scan.untrusted && !scan.braces.includes(true);
  return trusted ? scan.found : scan.found || LOAD_ANYWHERE.test(source);
}

function startScan(source: string): Scan {
  HASHBANG.lastIndex = 0;
  return {
    source,
    index: HASHBANG.test(source) ? HASHBANG.lastIndex : 0,
    regexAllowed: true,
    previousWord: '',
    afterDot: false,
    parens: [],
    braces: [],
    untrusted: false,
    found: false,
  };
}

const PUNCTUATION_READERS: ReadonlyMap<string, TokenReader> = new Map<string, TokenReader>([
  ['/', readSlash],
  ['"', readDoubleQuoted],
  ["'", readSingleQuoted],
  ['`', readTemplateStart],
  ['{', readOpenBrace],
  ['}', readCloseBrace],
  ['(', readOpenParen],
  [')', readCloseParen],
  [']', readCloseBracket],
  ['.', readDot],
  ['+', readPlusOrMinus],
  ['-', readPlusOrMinus],
]);

function readToken(scan: Scan): void {
  const char = scan.source.charAt(scan.index);
  const reader = PUNCTUATION_READERS.get(char);
  if (reader !== undefined) {
    reader(scan);
    return;
  }
  if (WORD_START.test(char)) {
    readWord(scan);
    return;
  }
  if (DIGIT.test(char)) {
    endToken(scan, matchEnd(NUMBER, scan), false);
    return;
  }
  const blank = matchEnd(WHITESPACE, scan);
  if (blank > scan.index) {
    scan.index = blank;
    return;
  }
  endToken(scan, scan.index + 1, true);
}

// Moves past one token: `regexAllowed` says whether a `/` right after it starts a regular expression.
function endToken(scan: Scan, end: number, regexAllowed: boolean): void {
  scan.index = end;
  scan.regexAllowed = regexAllowed;
  scan.previousWord = '';
  scan.afterDot = false;
}

// The end of `pattern` matched at the current position, or the current position when it does not match.
function matchEnd(pattern: RegExp, scan: Scan, from: number = scan.index): number {
  pattern.lastIndex = from;
  return pattern.test(scan.source) ? pattern.lastIndex : from;
}

function markUntrusted(scan: Scan): void {
  scan.untrusted = true;
  scan.index = scan.source.length;
}

function readSlash(scan: Scan): void {
  const next = scan.source.charAt(scan.index + 1);
  if (next === '/') {
    scan.index = matchEnd(LINE_COMMENT, scan);
    return;
  }
  if (next === '*') {
    readBlockComment(scan);
    return;
  }
  const literalEnd = scan.regexAllowed ? matchEnd(REGEX_LITERAL, scan) : scan.index;
  // A `/` that reaches a line break before closing was a division after all.
  endToken(scan, literalEnd > scan.index ? literalEnd : scan.index + 1, literalEnd === scan.index);
}

function readBlockComment(scan: Scan): void {
  const close = scan.source.indexOf('*/', scan.index + 2);
  if (close === -1) {
    markUntrusted(scan);
    return;
  }
  scan.index = close + 2;
}

function readDoubleQuoted(scan: Scan): void {
  readQuoted(scan, DOUBLE_QUOTED);
}

function readSingleQuoted(scan: Scan): void {
  readQuoted(scan, SINGLE_QUOTED);
}

function readQuoted(scan: Scan, pattern: RegExp): void {
  const end = matchEnd(pattern, scan);
  if (end === scan.index) {
    markUntrusted(scan);
    return;
  }
  endToken(scan, end, false);
}

function readTemplateStart(scan: Scan): void {
  readTemplateText(scan, scan.index + 1);
}

// Template text from `from` up to its closing backtick, or up to a `${` that opens a substitution.
function readTemplateText(scan: Scan, from: number): void {
  const end = matchEnd(TEMPLATE_TEXT, scan, from);
  const stop = scan.source.charAt(end);
  if (stop === '`') {
    endToken(scan, end + 1, false);
    return;
  }
  if (stop !== '$') {
    markUntrusted(scan);
    return;
  }
  scan.braces.push(true);
  endToken(scan, end + 2, true);
}

function readOpenBrace(scan: Scan): void {
  scan.braces.push(false);
  endToken(scan, scan.index + 1, true);
}

// A `}` closing a substitution resumes its template; any other ends a block or an object, and a
// regular expression may follow a block.
function readCloseBrace(scan: Scan): void {
  if (scan.braces.pop() === true) {
    readTemplateText(scan, scan.index + 1);
    return;
  }
  endToken(scan, scan.index + 1, true);
}

function readOpenParen(scan: Scan): void {
  scan.parens.push(CONTROL_KEYWORDS.has(scan.previousWord));
  endToken(scan, scan.index + 1, true);
}

function readCloseParen(scan: Scan): void {
  endToken(scan, scan.index + 1, scan.parens.pop() === true);
}

// An element access ends with an operand, so division follows `]`.
function readCloseBracket(scan: Scan): void {
  endToken(scan, scan.index + 1, false);
}

// `.` makes the next word a property name; `...` spreads, so a word after it is a keyword again.
function readDot(scan: Scan): void {
  if (scan.source.startsWith('...', scan.index)) {
    endToken(scan, scan.index + 3, true);
    return;
  }
  if (DIGIT.test(scan.source.charAt(scan.index + 1))) {
    endToken(scan, matchEnd(NUMBER, scan), false);
    return;
  }
  endToken(scan, scan.index + 1, true);
  scan.afterDot = true;
}

// `++` and `--` are read as postfix, so division follows them; a single sign is an operator.
function readPlusOrMinus(scan: Scan): void {
  const doubled = scan.source.charAt(scan.index + 1) === scan.source.charAt(scan.index);
  endToken(scan, scan.index + (doubled ? 2 : 1), !doubled);
}

function readWord(scan: Scan): void {
  const start = scan.index;
  const end = matchEnd(WORD, scan);
  const word = scan.source.slice(start, end);
  const keyword = !scan.afterDot;
  if (keyword && LOAD_KEYWORDS.has(word)) {
    scan.found = matchEnd(LOAD_AT_KEYWORD, scan) > start;
  }
  endToken(scan, end, keyword && REGEX_AFTER_KEYWORDS.has(word));
  scan.previousWord = keyword ? word : '';
}
