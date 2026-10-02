// Determine how Cytoscape treats child positions of compound nodes.
const cytoscape = require(process.env.TEMP + '/cgcy/cytoscape.min.js');

const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    style: [
        { selector: 'node', style: { width: 40, height: 40, padding: 10 } },
        { selector: '$node > node', style: { padding: 10 } },
    ],
    elements: [
        { data: { id: 'grand' } },
        { data: { id: 'parent', parent: 'grand' } },
        { data: { id: 'c1', parent: 'parent' } },
        { data: { id: 'c2', parent: 'parent' } },
    ],
});

const grand = cy.getElementById('grand');
const parent = cy.getElementById('parent');
const c1 = cy.getElementById('c1');
const c2 = cy.getElementById('c2');

grand.position({ x: 1000, y: 2000 });
parent.position({ x: 100, y: 100 });
c1.position({ x: -50, y: -50 });
c2.position({ x: 50, y: 50 });

const show = (label, n) => {
    const p = n.position();
    const bb = n.boundingBox({ includeLabels: false, includeOverlays: false });
    console.log(label.padEnd(10), 'pos', JSON.stringify(p),
        ' bb', [bb.x1, bb.y1, bb.x2, bb.y2].map((v) => Math.round(v * 100) / 100).join(','));
};
show('grand', grand);
show('parent', parent);
show('c1', c1);
show('c2', c2);

// Does c1's stored position change when the parent moves?
const before = JSON.stringify(c1.position());
parent.position({ x: 400, y: 400 });
const after = JSON.stringify(c1.position());
console.log('\nchild pos before/after parent move:', before, '/', after);
console.log('=> child positions are', before === after ? 'RELATIVE to parent' : 'ABSOLUTE');

// Does the parent's bbox follow its children, and is it centred on them?
console.log('\nparent bbox centred on parent pos?',
    (() => { const bb = parent.boundingBox({ includeLabels: false, includeOverlays: false });
        return ((bb.x1 + bb.x2) / 2).toFixed(1) + ' vs ' + parent.position('x'); })());

// What is the default computed size of a 2-child grid with padding 10?
const bb = parent.boundingBox({ includeLabels: false, includeOverlays: false });
console.log('parent size =', bb.w, 'x', bb.h, '(2x40 nodes, 100 gap, pad 10)');
console.log('\ncy version', cytoscape.version);
process.exit(0);
