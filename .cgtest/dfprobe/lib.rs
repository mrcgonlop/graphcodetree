// Probe for the two `data_flow` edges that vanish between `rust-repo.json` and
// `rust-repo-after.json`. The only difference between the two functions below is
// the *source shape* of the binding that feeds the consumer:
//
//   direct()  — `let d = producer();`  then `consumer(d)`
//   chained() — `let mut d = producer();` then `let d = d.take().or_else(..)`
//               then `consumer(d)`
//
// Expected: one `data_flow` edge, producer -> consumer, from `direct()` only;
// in `chained()` the tracked binding ends up pointing at the unresolvable
// method chain `d.take().or_else(..)`, which is the documented v2 gap.

pub fn producer() -> Option<String> {
    Some("x".to_string())
}

pub fn consumer(_v: Option<String>) {}

pub fn direct() {
    let d = producer();
    consumer(d);
}

pub fn chained() {
    let mut d = producer();
    let d = d.take().or_else(|| None);
    consumer(d);
}
