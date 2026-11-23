//! tychicus-hands for Linux: the hands protocol (docs/hands-protocol.md) over AT-SPI, with Hyprland, Sway and X11 for
//! windows and pictures. `tychicus-hands mcp [--connector]`.

mod access;
mod atspi;
mod desktop;
mod engine;
mod envelope;
mod hold;
mod mcp;
mod rows;
mod shot;
mod tools;
mod wl;

const USAGE: &str = "usage: tychicus-hands mcp [--connector]\n       tychicus-hands --version\n";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("mcp") => {
            let rest = &args[1..];
            if rest.iter().any(|a| a != "--connector") {
                eprint!("{USAGE}");
                std::process::exit(2);
            }
            std::process::exit(mcp::serve(rest.iter().any(|a| a == "--connector")));
        }
        // Internal: how `open` starts an agent's app on a Sway before 1.10 (src/hold.rs).
        Some("hold") => std::process::exit(hold::run(&args[1..])),
        Some("--version") | Some("version") => println!("tychicus-hands {}", mcp::VERSION),
        Some("--help") | Some("-h") | Some("help") => print!("{USAGE}"),
        _ => {
            eprint!("{USAGE}");
            std::process::exit(2);
        }
    }
}
