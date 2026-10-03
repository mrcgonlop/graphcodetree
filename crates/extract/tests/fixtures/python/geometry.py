"""Geometry primitives for the extraction fixtures.

The module exists so the Python profile is exercised against a real file on
disk rather than only against an inline string: a module docstring, class
docstrings, a decorated method, class attributes of both visibilities, every
import shape, and calls that resolve (same file, `self`) next to calls that
cannot (a receiver attribute, a computed callee).
"""

import math
from collections import OrderedDict as OD
from . import report

TAU = math.pi * 2


class Shape:
    """Base class: carries a name and knows its tuple of sides."""

    sides = 3
    _seen: int = 0

    def __init__(self, name: str) -> None:
        self.name = name

    def describe(self) -> str:
        """One line a reporter can print."""
        return f"{self.name} ({self.sides} sides)"

    @property
    def label(self) -> str:
        return self.name


class Circle(Shape):
    """A circle, so the call graph has a hierarchy to walk."""

    sides = 0

    def __init__(self, radius: float) -> None:
        Shape.__init__(self, "circle")
        self.radius = radius

    def area(self) -> float:
        return math.pi * self.radius**2

    def describe(self) -> str:
        return f"{self.name} r={self.radius} area={self.area()}"


def build(radius: float) -> str:
    """Assemble one line of output for a radius."""
    circle = Circle(radius)
    summary = report.summarise(circle.describe())
    return summary + str(circle.area())


def _hidden(radius: float) -> str:
    return build(radius)


def dump_all(radii: list) -> None:
    """Top-level driver: one call site per form the profile classifies."""
    registry = OD()
    for radius in radii:
        registry[radius] = build(radius)
    build(1.0)()
    _hidden(2.0)
