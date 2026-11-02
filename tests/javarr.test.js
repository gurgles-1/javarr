// JavArr unit tests — pure matching logic only (no DOM, no network).
// Run: node tests/javarr.test.js   (from the repo root, or pass a path)
const fs = require('fs');
const path = require('path');

const scriptPath = process.argv[2] || path.join(__dirname, '..', 'javarr.user.js');
const src = fs.readFileSync(scriptPath, 'utf8');
const block = src.split('// TESTABLE_START')[1].split('// TESTABLE_END')[0];
if (!block) { console.error('TESTABLE block not found'); process.exit(1); }
eval(block);

let passed = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  passed++; console.log('ok:', msg);
};

/* --- accent folding --- */
assert(foldText('Zoë') === 'zoe', 'foldText strips diaeresis');
assert(foldText('Straße') === 'strasse', 'foldText expands ß');
assert(norm('スタジオ') !== '', 'norm keeps non-Latin scripts');
assert(norm('Beyoncé Knowles') === 'beyonceknowles', 'norm folds + strips');

/* --- JAV codes --- */
assert(parseCode('SSIS-001').num === 1 && parseCode('SSIS-001').prefix === 'SSIS', 'parse SSIS-001');
assert(parseCode('010126-001') === null, 'date-style code does not parse (by design)');
assert(canonicalCode('ssis1') === 'SSIS-001', 'canonicalCode pads');
assert(releaseMatchesCode('[SSIS-001] Some Title 1080p', 'SSIS-001'), 'match hyphenated');
assert(releaseMatchesCode('SSIS001.mp4', 'SSIS-001'), 'match no-separator');
assert(!releaseMatchesCode('SSIS-0012 Some Title', 'SSIS-001'), 'reject 0012 vs 001');
assert(!releaseMatchesCode('XYZ-123 Title', 'ABC-123'), 'reject wrong prefix');

/* --- Whisparr lookup resolution for JAV codes --- */
const recs = [
  { foreignId: 'a', title: 'Something Else Entirely' },
  { foreignId: 'b', title: 'SSIS-001 A JAV Scene' },
];
assert(pickLookupForCode(recs, 'SSIS-001').foreignId === 'b', 'lookup pick: exact code in title wins');
assert(pickLookupForCode([recs[0]], 'SSIS-001').foreignId === 'a', 'lookup pick: lone result accepted');
assert(pickLookupForCode(recs, 'MIDE-999') === null, 'lookup pick: ambiguity without code match resolves to null');
assert(pickLookupForCode([], 'SSIS-001') === null, 'lookup pick: empty set is null');

/* --- skip list (canonical code equivalence) --- */
assert(isSkippedCode(['SSIS-1'], 'SSIS-001'), 'skip list: unpadded entry blocks padded code');
assert(isSkippedCode(['ssis001'], 'SSIS-001'), 'skip list: no-separator entry blocks');
assert(!isSkippedCode(['SSIS-002'], 'SSIS-001'), 'skip list: neighbour code not blocked');
assert(!isSkippedCode([], 'SSIS-001'), 'skip list: empty list blocks nothing');

console.log(`\nALL ${passed} TESTS PASSED`);
