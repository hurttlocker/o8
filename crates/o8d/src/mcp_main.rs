use o8d::mcp::{serve, McpServer};
use serde_json::json;
use std::{env, net::SocketAddr};
use tokio::net::TcpListener;

#[tokio::main(worker_threads = 2)]
async fn main() {
    if run().await.is_err() {
        eprintln!("o8d MCP failed: verify opt-in, listener and upstream");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if !arguments.iter().any(|arg| arg == "--experimental-mcp") {
        return Err("explicit opt-in required".into());
    }
    let option = |name: &str| {
        arguments
            .windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| pair[1].clone())
    };
    let address: SocketAddr = option("--listen").ok_or("listener required")?.parse()?;
    if !address.ip().is_loopback() {
        return Err("loopback listener required".into());
    }
    let upstream = option("--upstream").ok_or("upstream required")?;
    let mut server = McpServer::new(&upstream)?;
    if arguments.iter().any(|arg| arg == "--native-reads") {
        let directory =
            std::path::PathBuf::from(option("--data-dir").ok_or("data directory required")?);
        if !directory.is_absolute() {
            return Err("absolute data directory required".into());
        }
        let database = env::var_os("CORTEX_IDE_DB_PATH").map(std::path::PathBuf::from);
        server = server.with_native_reads(directory, database);
    }
    let listener = TcpListener::bind(address).await?;
    println!(
        "{}",
        json!({"listening": listener.local_addr()?.to_string()})
    );
    tokio::select! {
        result = serve(listener, server) => { result?; }
        _ = tokio::signal::ctrl_c() => {}
    }
    Ok(())
}
