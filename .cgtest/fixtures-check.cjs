// Scratch check for the Phase-3 Python extraction: reads the two snapshots
// produced by `codegraph.exe enrich crates\extract\tests\fixtures[...]`.
const path = require('path');

function check(file, expectLangs) {
    const s = require(path.resolve(file));
    const byLang = {};
    const fileLang = {};
    for (const n of s.nodes) {
        const lang = n.key.lang;
        byLang[lang] = (byLang[lang] || 0) + 1;
        fileLang[n.file] = lang;

        const ext = n.file.split('.').pop();
        const want = ext === 'rs' ? 'rust' : 'python';
        if (lang !== want) throw new Error(`lang/file mismatch: ${n.file} -> ${lang}`);
        if (lang === 'python' && n.key.qualified_name.includes('::')) {
            throw new Error(`python key carries ::  ${n.key.qualified_name}`);
        }
        if (lang === 'rust' && n.key.qualified_name.includes('.')) {
            throw new Error(`rust key carries .  ${n.key.qualified_name}`);
        }
    }
    const seen = new Map();
    for (const n of s.nodes) {
        const q = n.key.qualified_name;
        if (seen.has(q) && seen.get(q) !== n.key.lang) {
            throw new Error(`cross-language key collision: ${q}`);
        }
        seen.set(q, n.key.lang);
    }
    for (const l of expectLangs) {
        if (!byLang[l]) throw new Error(`missing language ${l} in ${file}`);
    }
    console.log(
        `${path.basename(file)}: files=${s.file_count} nodes=${s.nodes.length} ` +
            `edges=${s.edges.length} byLang=${JSON.stringify(byLang)} fileLang=${JSON.stringify(fileLang)}`
    );
}

check('.cgtest/fixtures-mixed.json', ['python', 'rust']);
check('.cgtest/fixtures-python.json', ['python']);
console.log('MIXED + LANG-SPLIT CHECKS PASSED');
