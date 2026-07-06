//! Apple Music control — the first non-o8 stop on the app-control frontier.
//!
//! Music.app has a first-class AppleScript dictionary, so "play something
//! from my chill playlist" needs no AX/clicking at all: list playlists, play
//! a playlist / searched track, pause, skip, and read what's playing. All
//! spoken-friendly errors; playback is classed ReadOnly in `safety` (no data
//! mutation, instantly reversible with pause) so the magic stays card-free.

use super::{run_applescript, run_osascript_jxa};
use serde_json::{json, Value};

/// Escape a spoken string for embedding in an AppleScript quoted literal.
fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// `mac_music_playlists` — names of the user's playlists.
pub async fn playlists(_args: Value) -> Result<Value, String> {
    // JXA returns a real JSON array — no AppleScript list-parsing fragility.
    let script = r#"
        const music = Application('Music');
        JSON.stringify(music.userPlaylists().map(p => p.name()));
    "#;
    let out = run_osascript_jxa(script)?;
    let names: Vec<String> = serde_json::from_str(&out).unwrap_or_default();
    Ok(json!({ "count": names.len(), "playlists": names }))
}

/// `mac_music_play` — play a playlist, a searched song, or just resume.
pub async fn play(args: Value) -> Result<Value, String> {
    let playlist = args
        .get("playlist")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let song = args
        .get("song")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    let script = if !playlist.is_empty() {
        format!(
            r#"tell application "Music"
                try
                    play user playlist "{}"
                    return "ok"
                on error
                    error "no playlist by that name"
                end try
            end tell"#,
            esc(playlist)
        )
    } else if !song.is_empty() {
        format!(
            r#"tell application "Music"
                set results to search library playlist 1 for "{}"
                if (count of results) is 0 then error "no match in the library"
                play item 1 of results
                return "ok"
            end tell"#,
            esc(song)
        )
    } else {
        r#"tell application "Music"
            play
            return "ok"
        end tell"#
            .to_string()
    };

    run_applescript(&script).map_err(|e| {
        if !playlist.is_empty() {
            format!("I couldn't find a playlist called '{playlist}' in Music. ({e})")
        } else if !song.is_empty() {
            format!("Nothing in the Music library matched '{song}'. ({e})")
        } else {
            format!("Music couldn't start playback. ({e})")
        }
    })?;
    now_playing(json!({}))
        .await
        .or(Ok(json!({ "playing": true })))
}

/// `mac_music_pause` — pause playback.
pub async fn pause(_args: Value) -> Result<Value, String> {
    run_applescript(r#"tell application "Music" to pause"#)?;
    Ok(json!({ "paused": true }))
}

/// `mac_music_next` — skip to the next track and report it.
pub async fn next(_args: Value) -> Result<Value, String> {
    run_applescript(r#"tell application "Music" to next track"#)?;
    now_playing(json!({}))
        .await
        .or(Ok(json!({ "skipped": true })))
}

/// `mac_music_previous` — go back a track (restarts the current one if
/// it's mid-song, matching the Music app's own button) and report it.
pub async fn previous(_args: Value) -> Result<Value, String> {
    run_applescript(r#"tell application "Music" to previous track"#)?;
    now_playing(json!({}))
        .await
        .or(Ok(json!({ "went_back": true })))
}

/// `mac_music_now_playing` — current track name/artist/playlist state.
pub async fn now_playing(_args: Value) -> Result<Value, String> {
    let script = r#"
        const music = Application('Music');
        const state = music.playerState();
        let track = null;
        try {
            const t = music.currentTrack;
            track = { name: t.name(), artist: t.artist(), album: t.album() };
        } catch (e) { /* nothing playing */ }
        JSON.stringify({ state, track });
    "#;
    let out = run_osascript_jxa(script)?;
    serde_json::from_str(&out).map_err(|e| format!("couldn't read player state: {e}"))
}
