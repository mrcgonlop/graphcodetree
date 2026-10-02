// Verify the custom-layout extension API surface.
const cytoscape = require(process.env.TEMP + '/cgcy/cytoscape.min.js');

let called = 0;
cytoscape('layout', 'mylayout', function (options) {
    const layout = this;
    called++;
    console.log('extension fn called. this has emit:', typeof layout.emit, 'one:', typeof layout.one, 'options.cy:', !!options.cy, 'eles:', options.eles.length);
    layout.run = function () {
        options.cy.nodes().forEach(function (n, i) { n.position({ x: i * 10, y: 0 }); });
        layout.emit({ type: 'layoutready' });
        layout.emit({ type: 'layoutstop' });
    };
});

const cy = cytoscape({
    headless: true, styleEnabled: true,
    style: [{ selector: 'node', style: { width: 20, height: 20 } }],
    elements: [{ data: { id: 'a' } }, { data: { id: 'b' } }, { data: { id: 'c' } }],
});

let stopped = 0;
const l = cy.layout({ name: 'mylayout', fit: false });
l.one('layoutstop', function () { stopped++; });
l.run();
console.log('run called:', called, '| layoutstop fired:', stopped, '| b pos:', JSON.stringify(cy.getElementById('b').position()));
console.log('unknown engine falls back?', (() => {
    try { const g = cy.layout({ name: 'nope' }); return g ? 'returned ' + (g.options && g.options.name) : 'null'; }
    catch (e) { return 'throws: ' + e.message; }
})());
process.exit(0);
