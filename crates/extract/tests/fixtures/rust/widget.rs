//! A Rust module living beside the Python fixtures, so one directory can be
//! enriched as a mixed-language snapshot (Phase 3's `enrich` acceptance check).

use std::fmt;

/// A labelled widget; deliberately mirrors `geometry.Shape`'s shape so a
/// reader can compare the two languages' output side by side.
pub struct Widget {
    name: String,
}

impl Widget {
    /// Build a widget from a borrowed name.
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
        }
    }

    /// The widget's display label.
    pub fn label(&self) -> String {
        format!("widget:{}", self.name)
    }
}

impl fmt::Display for Widget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.label())
    }
}

/// Free functions calling each other, so the fixture has a same-file call to
/// resolve in Rust as well as in Python (a receiver call like `widget.label()`
/// stays unresolved — the extractor has no types).
pub fn describe(widget: &Widget) -> String {
    frame(label_of(widget))
}

fn label_of(widget: &Widget) -> String {
    widget.label()
}

fn frame(text: String) -> String {
    format!("[{}]", text)
}
