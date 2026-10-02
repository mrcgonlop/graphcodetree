// Compares two codegraph snapshot JSONs semantically (order-insensitive) and
// reports whether raw ordering also matches.
import fs from 'node:fs';

const [a, b] = process.argv.slice(2);
const A = JSON.parse(fs.readFileSync(a, 'utf8'));
const B = JSON.parse(fs.readFileSync(b, 'utf8'));

const sorter = (arr) => arr.map((o) => JSON.stringify(o)).sort();
const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);

console.log('file_count     :', A.file_count, 'vs', B.file_count, '| equal:', A.file_count === B.file_count);
console.log('stats          : equal:', eq(A.stats, B.stats));
console.log('nodes ordered  : equal:', eq(A.nodes, B.nodes), '| sorted equal:', eq(sorter(A.nodes), sorter(B.nodes)), '|', A.nodes.length, 'vs', B.nodes.length);
console.log('edges ordered  : equal:', eq(A.edges, B.edges), '| sorted equal:', eq(sorter(A.edges), sorter(B.edges)), '|', A.edges.length, 'vs', B.edges.length);
