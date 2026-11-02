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

/* --- accent folding (brewing8309's lesson: release names drop accents) --- */
assert(foldText('Zoë') === 'zoe', 'foldText strips diaeresis');
assert(foldText('Straße') === 'strasse', 'foldText expands ß');
assert(norm('スタジオ') !== '', 'norm keeps non-Latin scripts');
assert(norm('Beyoncé Knowles') === 'beyonceknowles', 'norm folds + strips');
assert(hayHas(norm('Some Release'), '') === false, 'empty needle never matches');

/* --- JAV codes --- */
assert(parseCode('SSIS-001').num === 1 && parseCode('SSIS-001').prefix === 'SSIS', 'parse SSIS-001');
assert(parseCode('010126-001') === null, 'date-style code does not parse (by design)');
assert(JSON.stringify(codeQueries('SSIS-001')) === JSON.stringify(['SSIS-001', 'SSIS001', 'SSIS-1', 'SSIS1']), 'code query forms');
assert(canonicalCode('ssis1') === 'SSIS-001', 'canonicalCode pads');
assert(releaseMatchesCode('[SSIS-001] Some Title 1080p', 'SSIS-001'), 'match hyphenated');
assert(releaseMatchesCode('SSIS001.mp4', 'SSIS-001'), 'match no-separator');
assert(!releaseMatchesCode('SSIS-0012 Some Title', 'SSIS-001'), 'reject 0012 vs 001');
assert(!releaseMatchesCode('XYZ-123 Title', 'ABC-123'), 'reject wrong prefix');
assert(historyHasCode(['ABC-123 1080p', 'Other 720p'], 'ABC-123'), 'history finds code');
assert(!historyHasCode(['ABC-124 1080p'], 'ABC-123'), 'history rejects neighbour code');

/* --- performer name keys (alias guard) --- */
const keys = performerNameKeys({ name: 'Jane Doe', as: '', aliases: ['Mia', 'Jane D', 'SweetJane'] });
assert(keys.includes('janedoe'), 'primary name is a key');
assert(!keys.includes('mia'), 'short single-word alias excluded');
assert(keys.includes('janed'), 'multi-word alias included');
assert(keys.includes('sweetjane'), 'long alias included');

/* --- western scoring --- */
const meta = {
  title: 'A Quiet Evening', code: '', date: '2024-03-15',
  studio: { name: 'Example Films', parent: { name: 'Example Network' } },
  performers: [{ name: 'Zoë Star', as: '', aliases: [] }, { name: 'John Smith', as: '', aliases: [] }],
};
const s1 = scoreRelease('Example Films - 2024.03.15 - A Quiet Evening [Zoe Star]', meta);
assert(s1.score >= 4, `studio+performer+title+date all hit (got ${s1.score}: ${s1.hits})`);
const s2 = scoreRelease('Example Network 20240315 Something Else 1080p', meta);
assert(s2.hits.includes('Parent studio') && s2.hits.includes('Date'), 'parent studio + YYYYMMDD date hit');
const s3 = scoreRelease('Totally Unrelated Release 2023 720p', meta);
assert(s3.score === 0, 'unrelated release scores 0');
const metaCode = Object.assign({}, meta, { code: 'ABC-123' });
assert(scoreRelease('ABC123 bluray', metaCode).hits.includes('Code'), 'code hit via no-separator form');

console.log(`\nALL ${passed} TESTS PASSED`);
