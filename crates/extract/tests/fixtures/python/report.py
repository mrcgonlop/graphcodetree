"""Rendering helpers for the geometry fixtures."""

from typing import Iterable

FRAME = "[{}]"


def summarise(text: str) -> str:
    """Wrap a description in the reporter's frame."""
    return FRAME.format(text)


def table(rows: Iterable[str]) -> str:
    """Join rows with the module's separator."""
    return "\n".join(rows)


def report_all(shapes: list) -> str:
    """Summarise every shape and hand back the joined table."""
    lines = [summarise(s.describe()) for s in shapes]
    return table(lines)
