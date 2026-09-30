"""Update frontend index.html for new edge kinds."""
import re

with open('web/demo/index.html', 'rb') as f:
    content = f.read().decode('utf-8')

# 1. Add DataFlow to stats display
old_stats = "s.calls_edge_count + ' calls'"
new_stats = "s.calls_edge_count + ' calls · ' + (s.impl_edge_count || 0) + ' implements · ' + (s.data_flow_edge_count || 0) + ' dataflows'"
content = content.replace(old_stats, new_stats)

# 2. Add edge visualization styles for DataFlow (orange, arrow)
old_edge_style = "data: { id: e.key.qualified_name || e.id, kind: e.kind, source: eq(e.source), target: eq(e.target), weight: e.weight }"
new_edge_style = """data: { id: e.key.qualified_name || e.id, kind: e.kind, source: eq(e.source), target: eq(e.target), weight: e.weight },
      style: {
        'line-color': EDGE_COLORS[e.kind].color,
        'width': EDGE_COLORS[e.kind].width,
        'line-style': EDGE_COLORS[e.kind].style,
        'target-arrow-color': EDGE_COLORS[e.kind].color,
        'target-arrow-shape': EDGE_COLORS[e.kind].arrow ? 'triangle' : 'none',
        'curve-style': 'bezier'
      }"""
content = content.replace(old_edge_style, new_edge_style)

# 3. Add EDGE_COLORS map and KIND_COLORS/KIND_ORDER if not present
if 'EDGE_COLORS' not in content:
    edge_colors = """    const EDGE_COLORS = {
      contains: { color: '#414868', width: 1.5, style: 'solid', arrow: false },
      defines:  { color: '#565f89', width: 1, style: 'dotted', arrow: false },
      calls:    { color: '#7aa2f7', width: 2, style: 'solid', arrow: true },
      imports:  { color: '#73daca', width: 1.5, style: 'dashed', arrow: false },
      inherits: { color: '#e0af68', width: 1.5, style: 'dotted', arrow: false },
      implements: { color: '#f7768e', width: 2, style: 'dashed', arrow: true },
      references: { color: '#bb9af7', width: 1, style: 'dashed', arrow: false },
      data_flow:  { color: '#ff9e64', width: 2, style: 'solid', arrow: true },
    };
"""
    insert_pos = content.find('function render(snapshot)')
    if insert_pos > 0:
        # Find the line before function render(snapshot)
        prev_newline = content.rfind('\n', 0, insert_pos)
        content = content[:prev_newline] + '\n' + edge_colors + content[prev_newline:]

with open('web/demo/index.html', 'wb') as f:
    f.write(content.encode('utf-8'))

print("Frontend updated successfully.")
print("Stats line updated:", old_stats in content)
print("Edge styles updated:", old_edge_style in content)
print("EDGE_COLORS added:", 'EDGE_COLORS' in content)
