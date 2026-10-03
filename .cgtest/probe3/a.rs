fn main() {
    let g = Greeter::new();
    println!("{}", g.hi());
}

struct Greeter;

impl Greeter {
    fn hi(&self) -> String {
        String::new()
    }
}
