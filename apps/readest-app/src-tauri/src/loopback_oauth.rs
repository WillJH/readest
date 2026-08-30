//! Single-phase loopback OAuth capture server for desktop Linux.
//!
//! The stock `tauri-plugin-oauth` server (behind the legacy `start_server`
//! command) captures the redirect in TWO phases: it serves an HTML page whose
//! injected `fetch` must fire a second request carrying a `Full-Url` header —
//! only then does the handler run. When the browser does not execute that
//! fetch (extensions, policies, an eagerly closed tab), the connect hangs
//! forever even though the browser plainly showed the success page.
//!
//! The authorization code is in the FIRST request's request line already
//! (`GET /?code=…&state=… HTTP/1.1`), so this module captures it directly:
//! bind an ephemeral loopback port, answer the first query-bearing GET with a
//! static success page, emit the full URL as a `redirect_uri` window event
//! (the same contract the frontend loopback runner listens for), and stop.
//! No browser-side JavaScript required. Pure std — no tokio net feature, no
//! new dependencies.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use tauri::{Emitter, Window};

/// Event carrying the captured callback URL (contract shared with
/// `services/sync/providers/oauth/oauthLoopback.ts`).
pub const REDIRECT_EVENT: &str = "redirect_uri";

/// Shut the listener down after this long without a usable callback so an
/// abandoned attempt cannot leak the accept thread forever. Matches the
/// frontend runner's hard deadline.
const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// How often the non-blocking accept loop polls for a new connection.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Per-connection budget for reading the request head.
const READ_TIMEOUT: Duration = Duration::from_secs(5);

const SUCCESS_PAGE: &str = "<html><head><meta charset=\"utf-8\"></head>\
<body style=\"font-family:system-ui;text-align:center;padding-top:3rem\">\
<h2>Sign-in complete</h2><p>Please return to the app.</p></body></html>";

/// The full callback URL for a request path, or None when the request carries
/// no query (favicon probe, health check) and must not end the capture.
pub fn callback_url_from_request_path(path: &str, port: u16) -> Option<String> {
    if !path.starts_with('/') || !path.contains('?') {
        return None;
    }
    Some(format!("http://127.0.0.1:{port}{path}"))
}

/// Read up to the end of the request head and return the request line's path
/// (e.g. `/?code=…&state=…`). Returns None on a malformed or empty request.
fn request_path(stream: &mut TcpStream) -> Option<String> {
    let mut buf = [0u8; 4096];
    let mut head = Vec::with_capacity(512);
    loop {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            return None;
        }
        head.extend_from_slice(&buf[..n]);
        if let Some(head_end) = find_subslice(&head, b"\r\n\r\n") {
            let text = String::from_utf8_lossy(&head[..head_end]);
            // Request line: METHOD SP request-target SP HTTP-version.
            let request_line = text.lines().next()?;
            let mut parts = request_line.split(' ');
            let method = parts.next()?;
            if method != "GET" {
                return None;
            }
            return parts.next().map(str::to_owned);
        }
        if head.len() > 8192 {
            return None;
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

/// Bind an ephemeral loopback port and capture the first query-bearing GET as
/// the OAuth callback. Resolves immediately with the port; the capture runs on
/// a background thread and is delivered as a {@link REDIRECT_EVENT} window
/// event (broadcast, so any webview's listener receives it).
#[tauri::command]
pub fn start_loopback_oauth_server(window: Window) -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind loopback: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("nonblocking: {e}"))?;

    std::thread::spawn(move || {
        let deadline = Instant::now() + INACTIVITY_TIMEOUT;
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut conn, _)) => {
                    let _ = conn.set_read_timeout(Some(READ_TIMEOUT));
                    let _ = conn.set_nonblocking(false);
                    match request_path(&mut conn) {
                        Some(path) => match callback_url_from_request_path(&path, port) {
                            Some(url) => {
                                respond(&mut conn, "200 OK", SUCCESS_PAGE);
                                log::info!("[loopback-oauth] captured callback: {url}");
                                let _ = window.emit(REDIRECT_EVENT, url);
                                return;
                            }
                            // No query (favicon etc.): answer and keep waiting.
                            None => respond(&mut conn, "404 Not Found", ""),
                        },
                        None => respond(&mut conn, "400 Bad Request", ""),
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(POLL_INTERVAL);
                }
                Err(_) => return,
            }
        }
    });

    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::callback_url_from_request_path;

    #[test]
    fn captures_query_bearing_path() {
        assert_eq!(
            callback_url_from_request_path("/?code=C&state=S", 53123).as_deref(),
            Some("http://127.0.0.1:53123/?code=C&state=S")
        );
    }

    #[test]
    fn rejects_queryless_paths_and_garbage() {
        assert_eq!(callback_url_from_request_path("/favicon.ico", 1), None);
        assert_eq!(callback_url_from_request_path("/", 1), None);
        assert_eq!(callback_url_from_request_path("http://x/y?z=1", 1), None);
        assert_eq!(callback_url_from_request_path("", 1), None);
    }
}
