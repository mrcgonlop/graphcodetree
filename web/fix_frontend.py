"""Update frontend edge styles to use EDGE_COLORS dynamically."""
import re

with open('web/demo/index.html', 'rb') as f:
    content = f.read()

# Lines to remove (hardcoded edge kind selectors)
old_lines = [
    b"        { selector: 'edge', style: { width: 1.5, 'line-color': '#2f3346', 'target-arrow-color': '#565f89', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.7, 'curve-style': 'bezier' } },\r\n",
    b'        { selector: \'edge[kind = "calls"]\', style: { \'line-color\': \'#f7768e\', \'target-arrow-color\': \'#f7768e\', width: 1.2 } },\r\n',
    b'        { selector: \'edge[kind = "contains"]\', style: { \'line-color\': \'#3b4261\', \'target-arrow-color\': \'#3b4261\', \'line-style\': \'dotted\', width: 0.8 } },\r\n',
    b'        { selector: \'edge[kind = "defines"]\', style: { \'line-color\': \'#73daca\', \'target-arrow-color\': \'#73daca\', \'line-style\': \'dashed\', width: 0.8 } },\r\n',
    b'        { selector: \'edge[kind = "imports"]\', style: { \'line-color\': \'#2ac3de\', \'target-arrow-color\': \'#2ac3de\', \'line-style\': \'dashed\', width: 0.6 } },\r\n',
]
for old in old_lines:
    content = content.replace(old, b'')

# Insert dynamic edge style application in place of removed lines
# Find the `:selected` selector to insert before it
new_block = b"""        { selector: 'edge', style: { 'line-color': '#2f3346', width: 1, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.6, 'curve-style': 'bezier' } },
"""
idx = content.find(b"        { selector: ':selected'")
if idx > 0:
    content = content[:idx] + new_block + content[idx:]

# Now update the elements loop to apply EDGE_COLORS
# Find the mapping loop for edges and add style application
old_edge_data = b"data: { id: e.key.qualified_name || e.id, kind: e.kind, source: eq(e.source), target: eq(e.target), weight: e.weight },"
new_edge_data = b"""data: { id: e.key.qualified_name || e.id, kind: e.kind, source: eq(e.source), target: eq(e.target), weight: e.weight },
      classes: e.kind,
      style: {
        'line-color': EDGE_COLORS[e.kind] ? EDGE_COLORS[e.kind].color : '#2f3346',
        'width': EDGE_COLORS[e.kind] ? EDGE_COLORS[e.kind].width : 1,
        'line-style': EDGE_COLORS[e.kind] ? EDGE_COLORS[e.kind].style : 'solid',
        'target-arrow-color': EDGE_COLORS[e.kind] ? EDGE_COLORS[e.kind].color : '#565f89',
        'target-arrow-shape': EDGE_COLORS[e.kind] && EDGE_COLORS[e.kind].arrow ? 'triangle' : 'none',
        'curve-style': 'bezier'
      },"""
content = content.replace(old_edge_data, new_edge_data)

with open('web/demo/index.html', 'wb') as f:
    f.write(content)

print("Frontend edge styles updated using EDGE_COLORS!")
