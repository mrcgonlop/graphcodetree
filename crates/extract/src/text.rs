//! Grammar-agnostic text helpers, shared by the language profiles.

pub fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
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