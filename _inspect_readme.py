#!/usr/bin/env python3
"""Inspect the exact bytes around Architecture section."""
with open("README.md", "r", encoding="utf-8") as f:
    content = f.read()

idx = content.find("## Architecture")
if idx >= 0:
    chunk = content[idx:idx+600]
    print(repr(chunk))
