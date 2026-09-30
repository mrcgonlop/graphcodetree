import json
from collections import Counter

d = json.load(open('web/demo/graph.json', 'rb'))
callsites = [n for n in d['nodes'] if n['kind'] == 'call_site']
print(f'Total call sites in graph: {len(callsites)}')

# Count by resolution tag
resid = Counter()
hint_key_check = Counter()
for cs in callsites:
    extra = cs['attrs']['extra']
    r = extra.get('resolution', '?')
    resid[r] += 1
    if r == 'imported' or r == 'path_unresolved':
        if 'hint' in extra:
            hint_key_check['has_hint'] += 1
        if 'path' in extra:
            hint_key_check['has_path'] += 1
        if 'hint' not in extra and 'path' not in extra:
            hint_key_check['neither'] += 1

print(f'Resolution tags: {dict(resid)}')
print(f'Hint/Path key check for importable calls: {dict(hint_key_check)}')

# Show some importable call sites with their hints
print('\nSample importable call sites:')
count = 0
for cs in callsites:
    extra = cs['attrs']['extra']
    r = extra.get('resolution', '')
    if r in ('imported', 'path_unresolved'):
        hint = extra.get('hint', extra.get('path', '<missing>'))
        label = cs.get('label', '<?>')
        ancestor = cs['key']['ancestor']
        parent_qn = ancestor.get('qualified_name', '<?>')
        parent_file = ancestor.get('file', '<?>')
        print(f'  [{r}] {label}  (hint={hint})')
        print(f'    caller: {parent_qn}  in {parent_file}')
        count += 1
        if count >= 8:
            break

# Count calls edges by resolution  
print('\nCalls edges per source resolution type:')
calls_edges = [e for e in d['edges'] if e['kind'] == 'calls']
print(f'Total calls edges: {len(calls_edges)}')
