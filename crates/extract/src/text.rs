//! Grammar-agnostic text helpers, shared by future language extractors.
use tree_sitter::Node;

pub fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// "/// foo" → Some("foo"). "////" and "//" are not doc comments.
pub fn doc_line(comment: &str) -> Option<String> {
    if comment.starts_with("////") {
        return None;
    }
    let body = comment.strip_prefix("///")?;
    Some(body.strip_prefix(' ').unwrap_or(body).to_string())
}

/// First blank-line-delimited paragraph, joined to one line.
pub fn first_paragraph(lines: &[String]) -> Option<String> {
    let mut out = Vec::new();
    for l in lines {
        if l.trim().is_empty() {
            break;
        }
        out.push(l.trim().to_string());
    }
    if out.is_empty() { None } else { Some(out.join(" ")) }
}

/// Item text minus leading attributes, up to the body — signatures read
/// `pub async fn f(...) -> T`, not `#[instrument] pub async fn f(...)`.
/// Items without a body (`mod foo;`, trait method decls) sign in full.
pub fn signature_of(n: Node, src: &[u8]) -> Option<String> {
    let mut start = n.start_byte();
    let mut cur = n.walk();
    for c in n.named_children(&mut cur) {
        if c.kind() == "attribute_item" {
            start = c.end_byte();
        } else {
            break;
        }
    }
    let end = n
        .child_by_field_name("body")
        .map(|b| b.start_byte())
        .unwrap_or(n.end_byte());
    if start >= end || end > src.len() {
        return None;
    }
    let raw = std::str::from_utf8(&src[start..end]).ok()?.trim();
    if raw.is_empty() { None } else { Some(collapse_ws(raw)) }
}