//! Ensure the app's HTTP client sees the desktop proxy (desktop Linux).
//!
//! `tauri-plugin-http`'s reqwest client honors the classic proxy ENV VARS only
//! — it never reads the desktop environment's proxy settings (gsettings/KDE),
//! and the fork owner's network needs a proxy for Google. The browser walks
//! the DE proxy (so Drive OAuth consent always worked); the app's direct token
//! exchange died with "error sending request". Like the GDK_BACKEND defaults
//! in `lib.rs`, we bridge this at startup, before any HTTP happens:
//!
//! 1. Any explicit proxy env var set → do nothing (user env always wins).
//! 2. gsettings reports a manual proxy (GNOME-style) → adopt host/port.
//! 3. Otherwise probe the common local proxy ports with a real HTTP CONNECT
//!    handshake and adopt the first that answers like a proxy.
//!
//! `no_proxy` for loopback is set alongside so localhost traffic (dev server,
//! loopback OAuth capture) never gets routed into the proxy.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

/// Env vars whose presence means the user already configured a proxy.
const PROXY_ENV_VARS: [&str; 6] = [
    "https_proxy",
    "HTTPS_PROXY",
    "http_proxy",
    "HTTP_PROXY",
    "all_proxy",
    "ALL_PROXY",
];

/// Local ports probed as HTTP proxies, in order. 7897 is the fork owner's
/// Clash mixed port; 7890 is Clash's historical default.
const CANDIDATE_PORTS: [u16; 2] = [7897, 7890];

const CONNECT_PROBE_HOST: &str = "www.google.com:443";
const PROBE_TIMEOUT: Duration = Duration::from_millis(600);

/// Strip the quoting `gsettings get` wraps values in (`'host'`, `8080`).
pub fn parse_gsettings_value(raw: &str) -> &str {
    raw.trim().trim_matches('\'').trim_matches('"')
}

/// Whether a real HTTP proxy answers CONNECT on `host:port` — a plain
/// listener that is not a proxy must not be adopted.
pub fn probe_http_proxy(host: &str, port: u16) -> bool {
    let addr = match (host, port).to_socket_addrs() {
        Ok(mut addrs) => match addrs.next() {
            Some(addr) => addr,
            None => return false,
        },
        Err(_) => return false,
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
    let request = format!("CONNECT {CONNECT_PROBE_HOST} HTTP/1.1\r\nHost: {CONNECT_PROBE_HOST}\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 32];
    let Ok(n) = stream.read(&mut head) else {
        return false;
    };
    let response = String::from_utf8_lossy(&head[..n]);
    // Any 2xx to CONNECT means a forwarding proxy is listening.
    response.starts_with("HTTP/") && response.contains(" 2")
}

/// Read the manual proxy host/port from gsettings, when it is the active mode.
fn gsettings_manual_proxy() -> Option<(String, u16)> {
    let get = |schema: &str, key: &str| -> Option<String> {
        let out = std::process::Command::new("gsettings")
            .args(["get", schema, key])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(parse_gsettings_value(&String::from_utf8_lossy(&out.stdout)).to_owned())
    };

    if get("org.gnome.system.proxy", "mode")?.to_lowercase() != "manual" {
        return None;
    }
    // https first, http as fallback; empty host means "not configured".
    for schema in ["org.gnome.system.proxy.https", "org.gnome.system.proxy.http"] {
        let host = get(schema, "host")?;
        let port = get(schema, "port")?.parse::<u16>().ok()?;
        if !host.is_empty() {
            return Some((host, port));
        }
    }
    None
}

/// Adopt `host:port` as the process's HTTP/HTTPS proxy unless already set.
fn adopt_proxy(host: &str, port: u16) {
    let proxy = format!("http://{host}:{port}");
    for var in ["http_proxy", "https_proxy"] {
        if std::env::var_os(var).is_none() {
            std::env::set_var(var, &proxy);
        }
    }
    if std::env::var_os("no_proxy").is_none() && std::env::var_os("NO_PROXY").is_none() {
        std::env::set_var("no_proxy", "localhost,127.0.0.1,::1");
    }
    log::info!("[proxy] adopted desktop proxy {proxy} for app HTTP traffic");
}

/// The startup bridge: gsettings first, local-port probe as fallback.
pub fn ensure_proxy_env() {
    if PROXY_ENV_VARS.iter().any(|v| std::env::var_os(v).is_some()) {
        return;
    }
    if let Some((host, port)) = gsettings_manual_proxy() {
        adopt_proxy(&host, port);
        return;
    }
    for port in CANDIDATE_PORTS {
        if probe_http_proxy("127.0.0.1", port) {
            adopt_proxy("127.0.0.1", port);
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_gsettings_value;

    #[test]
    fn parses_quoted_and_bare_gsettings_values() {
        assert_eq!(parse_gsettings_value("'127.0.0.1'\n"), "127.0.0.1");
        assert_eq!(parse_gsettings_value("8080\n"), "8080");
        assert_eq!(parse_gsettings_value("\"host\""), "host");
        assert_eq!(parse_gsettings_value("manual"), "manual");
    }
}
