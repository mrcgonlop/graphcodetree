"""Check if flows_from is being generated for call sites."""
import json

# Re-run the extractor with diagnostic output
# Read a sample file and check call sites
with open('cli/src/main.rs', 'rb') as f:
    content = f.read().decode('utf-8')

# Count let bindings with call initializers
import re
# Patterns like: let x = <call> or let (x,) = <call>
let_calls = re.findall(r'let\s+(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=\s*([a-zA-Z_]\w*(?:\([^)]*\))?(?:\?)?)', content)
print(f"Let bindings with potential call initializers: {len(let_calls)}")
for lc in let_calls[:10]:
    print(f"  -> {lc}")

# Count method calls like: variable.method(args)
method_calls = re.findall(r'([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)\s*\(', content)
print(f"\nMethod calls: {len(method_calls)}")
for mc in method_calls[:10]:
    print(f"  {mc[0]}.{mc[1]}()")
