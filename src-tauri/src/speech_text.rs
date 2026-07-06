//! Speech-only text normalization for TTS.
//!
//! Keep original text intact for history, prompts, and copy/paste. This module
//! only prepares a separate spoken form so TTS engines do not read symbols,
//! ranges, file paths, and price strings as gibberish.

#[derive(Debug, Clone)]
struct CurrencyAmount {
    end: usize,
    symbol: char,
    phrase: String,
}

#[derive(Debug, Clone, Copy)]
struct ParsedNumber {
    end: usize,
    integer: u64,
    cents: Option<u8>,
}

pub fn prepare_text_for_speech(text: &str) -> String {
    let structured = clean_structured_text(text);
    let shortened = shorten_speech_tokens(&structured);
    let expanded = expand_spoken_symbols(&shortened);
    clean_spoken_spacing(&expanded)
}

/// Strips terminal/markdown scaffolding that TTS would otherwise read as
/// gibberish — and that, in long selections, makes the cloud voice jump
/// around or slip into another language. Removes ANSI escapes, box-drawing
/// line art, code fences, horizontal rules, table separators, list/heading
/// markers, and runs of repeated symbols. Table rows are linearized into
/// comma-separated, period-terminated clauses so the cells are spoken in
/// reading order with a natural pause between rows.
///
/// Must run first, while line structure is intact: later passes collapse
/// newlines to spaces, which would erase the row/column layout this relies on.
fn clean_structured_text(text: &str) -> String {
    let mut out_lines: Vec<String> = Vec::new();

    for raw in text.lines() {
        let no_ansi = strip_ansi(raw);
        let no_art = strip_line_art(&no_ansi);
        let trimmed = no_art.trim();

        if trimmed.is_empty() {
            out_lines.push(String::new());
            continue;
        }
        // Code fences and horizontal rules / table separators carry no words.
        if trimmed.starts_with("```") || is_divider_line(trimmed) {
            continue;
        }
        if let Some(row) = linearize_table_row(trimmed) {
            out_lines.push(row);
            continue;
        }

        let no_markers = strip_leading_markers(trimmed);
        let no_emphasis = no_markers.replace("**", "").replace("__", "");
        let collapsed = collapse_symbol_runs(&no_emphasis);
        let cleaned = collapsed.trim();
        if !cleaned.is_empty() {
            out_lines.push(cleaned.to_string());
        }
    }

    out_lines.join("\n")
}

/// True when, ignoring whitespace, the line is made up only of rule/separator
/// punctuation (`---`, `===`, `|---|---|`, `* * *`, `+--+--+`). Such lines are
/// visual dividers with no spoken content. Requires ≥3 such chars so a stray
/// `--` or `::` in prose is left alone.
fn is_divider_line(line: &str) -> bool {
    let dense: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    if dense.chars().count() < 3 {
        return false;
    }
    dense
        .chars()
        .all(|c| matches!(c, '-' | '=' | '_' | '*' | '|' | '+' | ':' | '~' | '#'))
}

/// Linearizes a table row into spoken cells. Returns `None` for non-table
/// lines. A line qualifies when it starts with a pipe or contains a
/// space-padded ` | ` cell separator — this deliberately skips code like
/// `a || b` (adjacent pipes, no surrounding spaces).
fn linearize_table_row(line: &str) -> Option<String> {
    let is_row = line.starts_with('|') || line.contains(" | ");
    if !is_row {
        return None;
    }

    let cells: Vec<String> = line
        .trim_matches('|')
        .split('|')
        .map(|cell| cell.trim().trim_matches('`').trim().to_string())
        .filter(|cell| !cell.is_empty())
        .collect();

    if cells.is_empty() {
        return None;
    }

    let mut row = cells.join(", ");
    if !row.ends_with(['.', '!', '?', ':', ';', ',']) {
        row.push('.');
    }
    Some(row)
}

/// Removes a single leading markdown/quote/list marker so the line's words are
/// spoken without "hash", "asterisk", or "greater-than" noise.
fn strip_leading_markers(line: &str) -> String {
    let trimmed = line.trim_start();

    if trimmed.starts_with('#') {
        let after = trimmed.trim_start_matches('#');
        if after.is_empty() || after.starts_with(' ') {
            return after.trim_start().to_string();
        }
    }

    // Possibly-nested blockquote markers ("> > quote").
    let mut rest = trimmed;
    let mut stripped_quote = false;
    while let Some(next) = rest.strip_prefix("> ").or_else(|| rest.strip_prefix(">")) {
        if next == rest {
            break;
        }
        rest = next.trim_start();
        stripped_quote = true;
    }
    if stripped_quote {
        return rest.to_string();
    }

    for marker in ["- ", "* ", "+ ", "• "] {
        if let Some(after) = trimmed.strip_prefix(marker) {
            return after.trim_start().to_string();
        }
    }

    trimmed.to_string()
}

/// Collapses a run of 4+ identical symbol characters (e.g. `====`, `>>>>`,
/// `~~~~`) down to a single space so dividers and ASCII art don't get spelled
/// out. Leaves `...` ellipses and short `--`/`!!` runs intact.
fn collapse_symbol_runs(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        if !c.is_alphanumeric() && !c.is_whitespace() {
            let mut count = 1;
            while chars.peek() == Some(&c) {
                chars.next();
                count += 1;
            }
            if count >= 4 {
                if !out.ends_with(' ') {
                    out.push(' ');
                }
            } else {
                for _ in 0..count {
                    out.push(c);
                }
            }
        } else {
            out.push(c);
        }
    }

    out
}

/// Strips ANSI/VT escape sequences (CSI colour codes, cursor moves) emitted by
/// terminals so the voice doesn't read the control bytes.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for p in chars.by_ref() {
                    if p.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                chars.next();
            }
        } else {
            out.push(c);
        }
    }

    out
}

/// Replaces Unicode box-drawing and block-element glyphs with spaces so table
/// borders and ASCII frames don't get verbalized.
fn strip_line_art(line: &str) -> String {
    line.chars()
        .map(|c| {
            if ('\u{2500}'..='\u{257f}').contains(&c) || ('\u{2580}'..='\u{259f}').contains(&c) {
                ' '
            } else {
                c
            }
        })
        .collect()
}

fn shorten_speech_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut token = String::new();

    for ch in text.chars() {
        if ch.is_whitespace() {
            if !token.is_empty() {
                out.push_str(&prepare_token_for_speech(&token));
                token.clear();
            }
            out.push(ch);
        } else {
            token.push(ch);
        }
    }

    if !token.is_empty() {
        out.push_str(&prepare_token_for_speech(&token));
    }

    out
}

fn prepare_token_for_speech(token: &str) -> String {
    let (leading, core, trailing) = split_token_punctuation(token);
    if core.is_empty() {
        return token.to_string();
    }

    let replacement = shorten_url_core(core)
        .or_else(|| shorten_file_path_core(core))
        .or_else(|| expand_unit_token(core))
        .or_else(|| expand_identifier_token(core))
        .or_else(|| expand_abbreviation_token(core));
    match replacement {
        Some(value) => format!("{leading}{value}{trailing}"),
        None => token.to_string(),
    }
}

/// Speaks size/time/frequency unit abbreviations as full words so TTS doesn't
/// spell them out. Handles both standalone units (`KB` → "kilobytes") and units
/// glued to a number (`4ms` → "4 milliseconds", `142KB` → "142 kilobytes").
fn expand_unit_token(core: &str) -> Option<String> {
    if core.chars().all(|c| c.is_ascii_alphabetic()) {
        return unit_word(core, false).map(str::to_string);
    }

    let pos = core.find(|c: char| c.is_ascii_alphabetic())?;
    if pos == 0 {
        return None;
    }
    let (num, unit) = core.split_at(pos);
    if !num.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    if !unit.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    unit_word(unit, true).map(|word| format!("{num} {word}"))
}

/// Maps a unit abbreviation (case-insensitive) to its spoken word. `attached` is
/// true only when the unit was glued to a number; single- or two-letter units
/// that double as ordinary words (`ms` like "Ms.", `s`, `hz`) are expanded only
/// in that number-attached context so prose is left untouched.
fn unit_word(unit: &str, attached: bool) -> Option<&'static str> {
    match unit.to_ascii_lowercase().as_str() {
        "kb" => Some("kilobytes"),
        "mb" => Some("megabytes"),
        "gb" => Some("gigabytes"),
        "tb" => Some("terabytes"),
        "khz" => Some("kilohertz"),
        "mhz" => Some("megahertz"),
        "ghz" => Some("gigahertz"),
        "kbps" => Some("kilobits per second"),
        "mbps" => Some("megabits per second"),
        "fps" => Some("frames per second"),
        "px" => Some("pixels"),
        "ms" if attached => Some("milliseconds"),
        "s" if attached => Some("seconds"),
        "hz" if attached => Some("hertz"),
        _ => None,
    }
}

/// Speaks code identifiers as plain words: drops a trailing source-file
/// extension (`reading.rs` → "reading", `speech_text.rs` → "speech text") and
/// turns `_` / `::` separators into spaces (`tokio::join` → "tokio join"). Only
/// fires on tokens that are clearly code, so ordinary prose is untouched.
fn expand_identifier_token(core: &str) -> Option<String> {
    let core = core.trim_end_matches(':');
    let (stem, had_code_ext) = match core.rsplit_once('.') {
        Some((stem, ext)) if is_code_extension(ext) && !stem.is_empty() => (stem, true),
        _ => (core, false),
    };

    let has_separator = stem.contains('_') || stem.contains("::");
    if !has_separator && !had_code_ext {
        return None;
    }
    if !stem
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':')
    {
        return None;
    }
    if !stem.chars().any(|c| c.is_ascii_alphabetic()) {
        return None;
    }

    let spaced = stem.replace("::", " ").replace('_', " ");
    let collapsed = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    (!collapsed.is_empty()).then_some(collapsed)
}

fn is_code_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "rs" | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "py"
            | "swift"
            | "go"
            | "rb"
            | "json"
            | "toml"
            | "md"
            | "html"
            | "css"
            | "yml"
            | "yaml"
            | "sh"
    )
}

/// Spells out a handful of common abbreviations that read poorly letter-by-letter.
fn expand_abbreviation_token(core: &str) -> Option<String> {
    let word = match core.to_ascii_lowercase().as_str() {
        "chars" => "characters",
        "char" => "character",
        "vs" => "versus",
        "etc" => "etcetera",
        "approx" => "approximately",
        "e.g" => "for example",
        "i.e" => "that is",
        _ => return None,
    };
    Some(word.to_string())
}

fn split_token_punctuation(token: &str) -> (&str, &str, &str) {
    let mut start = 0;
    for (idx, ch) in token.char_indices() {
        if matches!(ch, '(' | '[' | '{' | '<' | '"' | '\'' | '`') {
            start = idx + ch.len_utf8();
        } else {
            break;
        }
    }

    let mut end = token.len();
    for (idx, ch) in token[..end].char_indices().rev() {
        if idx < start {
            break;
        }
        if matches!(
            ch,
            '.' | ',' | ';' | '!' | '?' | ')' | ']' | '}' | '>' | '"' | '\'' | '`'
        ) {
            end = idx;
        } else {
            break;
        }
    }

    (&token[..start], &token[start..end], &token[end..])
}

fn shorten_url_core(core: &str) -> Option<String> {
    let lower = core.to_ascii_lowercase();
    let rest = if let Some((_, after_scheme)) = core.split_once("://") {
        after_scheme
    } else if lower.starts_with("www.") {
        core
    } else if let Some((before_slash, _)) = core.split_once('/') {
        if looks_like_domain(before_slash) {
            core
        } else {
            return None;
        }
    } else {
        return None;
    };

    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default();
    let host = authority
        .split(':')
        .next()
        .unwrap_or_default()
        .trim_start_matches("www.");

    if looks_like_domain(host) {
        Some(host.to_string())
    } else {
        None
    }
}

fn looks_like_domain(value: &str) -> bool {
    let trimmed = value.trim_matches('.');
    if !trimmed.contains('.') {
        return false;
    }
    trimmed.split('.').all(|part| {
        !part.is_empty()
            && part
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    })
}

fn shorten_file_path_core(core: &str) -> Option<String> {
    if core.contains("://") || !(core.contains('/') || core.contains('\\')) {
        return None;
    }
    if !core
        .chars()
        .any(|ch| ch.is_ascii_alphabetic() || ch == '_' || ch == '.')
    {
        return None;
    }

    let segment = core
        .split(['/', '\\'])
        .rev()
        .find(|segment| !segment.is_empty())?
        .split(['?', '#'])
        .next()
        .unwrap_or_default();

    let segment = segment.trim_matches(|ch| matches!(ch, '"' | '\'' | '<' | '>'));
    if segment.is_empty() {
        return None;
    }

    if let Some((file, line)) = segment.rsplit_once(':') {
        if !file.is_empty() && !line.is_empty() && line.chars().all(|ch| ch.is_ascii_digit()) {
            return Some(format!("{file} line {line}"));
        }
    }

    Some(segment.to_string())
}

fn expand_spoken_symbols(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut index = 0;

    while index < text.len() {
        if let Some((end, phrase)) = parse_currency_expression_at(text, index) {
            push_spoken_word(&mut out, &phrase);
            index = end;
            continue;
        }

        let ch = next_char(text, index).expect("index must be on a char boundary");
        match ch {
            '(' | '[' | '{' => push_boundary(&mut out),
            ')' | ']' | '}' => push_boundary(&mut out),
            '—' => push_comma_pause(&mut out),
            '–' => push_spoken_word(&mut out, "to"),
            '-' if looks_like_spaced_dash(text, index) => push_comma_pause(&mut out),
            '/' if looks_like_spaced_slash(text, index) => push_spoken_word(&mut out, "or"),
            '&' => push_spoken_word(&mut out, "and"),
            '%' => push_spoken_word(&mut out, "percent"),
            '+' => push_spoken_word(&mut out, "plus"),
            '→' | '⟶' | '➜' | '➔' | '⇒' => push_spoken_word(&mut out, "to"),
            _ => out.push(ch),
        }
        index += ch.len_utf8();
    }

    out
}

fn parse_currency_expression_at(text: &str, start: usize) -> Option<(usize, String)> {
    let first = parse_currency_amount_at(text, start)?;
    let mut cursor = skip_inline_space(text, first.end);

    if let Some(dash) = next_char(text, cursor).filter(|ch| is_range_dash(*ch)) {
        let after_dash = skip_inline_space(text, cursor + dash.len_utf8());
        let second = parse_currency_amount_at(text, after_dash).or_else(|| {
            parse_plain_number_at(text, after_dash).map(|number| CurrencyAmount {
                end: number.end,
                symbol: first.symbol,
                phrase: currency_amount_phrase(first.symbol, number.integer, number.cents),
            })
        });

        if let Some(second) = second {
            return Some((
                second.end,
                format!("from {} to {}", first.phrase, second.phrase),
            ));
        }
    }

    if starts_with_word(text, cursor, "from") {
        cursor = skip_inline_space(text, cursor + "from".len());
        return Some((cursor, format!("from {}", first.phrase)));
    }

    Some((first.end, first.phrase))
}

fn parse_currency_amount_at(text: &str, start: usize) -> Option<CurrencyAmount> {
    let symbol = next_char(text, start)?;
    if !is_currency_symbol(symbol) {
        return None;
    }

    let number_start = skip_inline_space(text, start + symbol.len_utf8());
    let number = parse_plain_number_at(text, number_start)?;
    Some(CurrencyAmount {
        end: number.end,
        symbol,
        phrase: currency_amount_phrase(symbol, number.integer, number.cents),
    })
}

fn parse_plain_number_at(text: &str, start: usize) -> Option<ParsedNumber> {
    let mut index = start;
    let mut digits = String::new();

    while let Some(ch) = next_char(text, index) {
        if ch.is_ascii_digit() {
            digits.push(ch);
            index += ch.len_utf8();
        } else if ch == ',' {
            index += ch.len_utf8();
        } else {
            break;
        }
    }

    if digits.is_empty() {
        return None;
    }

    let mut cents = None;
    if next_char(text, index) == Some('.') {
        let decimal_start = index + 1;
        if next_char(text, decimal_start)
            .map(|ch| ch.is_ascii_digit())
            .unwrap_or(false)
        {
            index = decimal_start;
            let mut decimal_digits = String::new();
            while decimal_digits.len() < 2 {
                match next_char(text, index) {
                    Some(ch) if ch.is_ascii_digit() => {
                        decimal_digits.push(ch);
                        index += ch.len_utf8();
                    }
                    _ => break,
                }
            }
            if decimal_digits.len() == 1 {
                decimal_digits.push('0');
            }
            cents = decimal_digits.parse::<u8>().ok();
        }
    }

    let integer = digits.parse::<u64>().ok()?;
    Some(ParsedNumber {
        end: index,
        integer,
        cents,
    })
}

fn currency_amount_phrase(symbol: char, integer: u64, cents: Option<u8>) -> String {
    let (singular, plural) = match symbol {
        '$' => ("dollar", "dollars"),
        '€' => ("euro", "euros"),
        '£' => ("pound", "pounds"),
        '¥' => ("yen", "yen"),
        _ => ("unit", "units"),
    };
    let unit = if integer == 1 { singular } else { plural };
    let mut phrase = format!("{} {}", number_to_words(integer), unit);

    if let Some(cents) = cents.filter(|value| *value > 0) {
        let cents_unit = if cents == 1 { "cent" } else { "cents" };
        phrase.push_str(&format!(
            " and {} {}",
            number_to_words(cents as u64),
            cents_unit
        ));
    }

    phrase
}

fn number_to_words(value: u64) -> String {
    if value == 0 {
        return "zero".to_string();
    }

    let groups = [
        (1_000_000_000, "billion"),
        (1_000_000, "million"),
        (1_000, "thousand"),
    ];
    let mut remainder = value;
    let mut parts = Vec::new();

    for (scale, label) in groups {
        if remainder >= scale {
            let chunk = remainder / scale;
            parts.push(format!("{} {}", number_under_thousand(chunk), label));
            remainder %= scale;
        }
    }

    if remainder > 0 {
        parts.push(number_under_thousand(remainder));
    }

    parts.join(" ")
}

fn number_under_thousand(value: u64) -> String {
    debug_assert!(value < 1000);
    const ONES: [&str; 20] = [
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
    ];
    const TENS: [&str; 10] = [
        "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    ];

    let hundreds = value / 100;
    let below_hundred = value % 100;
    let mut parts = Vec::new();

    if hundreds > 0 {
        parts.push(format!("{} hundred", ONES[hundreds as usize]));
    }

    if below_hundred > 0 {
        if below_hundred < 20 {
            parts.push(ONES[below_hundred as usize].to_string());
        } else {
            let tens = below_hundred / 10;
            let ones = below_hundred % 10;
            if ones == 0 {
                parts.push(TENS[tens as usize].to_string());
            } else {
                parts.push(format!("{} {}", TENS[tens as usize], ONES[ones as usize]));
            }
        }
    }

    parts.join(" ")
}

fn is_currency_symbol(ch: char) -> bool {
    matches!(ch, '$' | '€' | '£' | '¥')
}

fn is_range_dash(ch: char) -> bool {
    matches!(ch, '-' | '–' | '—')
}

fn starts_with_word(text: &str, index: usize, word: &str) -> bool {
    let rest = &text[index..];
    if !rest
        .get(..word.len())
        .map(|prefix| prefix.eq_ignore_ascii_case(word))
        .unwrap_or(false)
    {
        return false;
    }

    let before_ok = index == 0
        || previous_char(text, index)
            .map(|ch| !ch.is_ascii_alphanumeric())
            .unwrap_or(true);
    let after = index + word.len();
    let after_ok = after >= text.len()
        || next_char(text, after)
            .map(|ch| !ch.is_ascii_alphanumeric())
            .unwrap_or(true);

    before_ok && after_ok
}

fn skip_inline_space(text: &str, mut index: usize) -> usize {
    while let Some(ch) = next_char(text, index) {
        if matches!(ch, ' ' | '\t' | '\u{00a0}') {
            index += ch.len_utf8();
        } else {
            break;
        }
    }
    index
}

fn looks_like_spaced_slash(text: &str, index: usize) -> bool {
    previous_char(text, index)
        .map(|ch| ch.is_whitespace())
        .unwrap_or(false)
        && next_char(text, index + 1)
            .map(|ch| ch.is_whitespace())
            .unwrap_or(false)
}

fn looks_like_spaced_dash(text: &str, index: usize) -> bool {
    previous_char(text, index)
        .map(|ch| ch.is_whitespace())
        .unwrap_or(false)
        && next_char(text, index + 1)
            .map(|ch| ch.is_whitespace())
            .unwrap_or(false)
}

fn next_char(text: &str, index: usize) -> Option<char> {
    text.get(index..)?.chars().next()
}

fn previous_char(text: &str, index: usize) -> Option<char> {
    text.get(..index)?.chars().next_back()
}

fn push_boundary(out: &mut String) {
    if !out.ends_with(' ') && !out.is_empty() {
        out.push(' ');
    }
}

fn push_comma_pause(out: &mut String) {
    while out.ends_with(' ') {
        out.pop();
    }
    if !out.is_empty() && !out.ends_with([',', '.', '!', '?', ';', ':']) {
        out.push(',');
    }
    out.push(' ');
}

fn push_spoken_word(out: &mut String, word: &str) {
    if !out.ends_with(char::is_whitespace) && !out.is_empty() {
        out.push(' ');
    }
    out.push_str(word);
    out.push(' ');
}

fn clean_spoken_spacing(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut previous_space = false;

    for ch in text.chars() {
        if ch.is_whitespace() {
            if !previous_space && !out.is_empty() {
                out.push(' ');
                previous_space = true;
            }
            continue;
        }

        if matches!(ch, ',' | '.' | ';' | ':' | '!' | '?') {
            while out.ends_with(' ') {
                out.pop();
            }
            if ch == ',' && out.ends_with(',') {
                out.push(' ');
                previous_space = true;
                continue;
            }
        }

        out.push(ch);
        previous_space = false;
    }

    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::prepare_text_for_speech;

    #[test]
    fn speech_text_shortens_full_urls_to_domains() {
        let input = "Read https://www.ninjatrader.com/support/helpGuides/nt8/path/page.html?x=1.";
        assert_eq!(prepare_text_for_speech(input), "Read ninjatrader.com.");
    }

    #[test]
    fn speech_text_shortens_bare_domain_paths() {
        let input = "Open ninjatrader.com/support/helpGuides/nt8/index.html next.";
        assert_eq!(prepare_text_for_speech(input), "Open ninjatrader.com next.");
    }

    #[test]
    fn speech_text_shortens_file_paths_to_file_names() {
        let input = "Patch /Users/me/o8/src-tauri/src/playback.rs:812 now.";
        assert_eq!(
            prepare_text_for_speech(input),
            "Patch playback.rs line 812 now."
        );
    }

    #[test]
    fn speech_text_does_not_collapse_dates() {
        let input = "Ship this on 05/14/2026, not 05/15/2026.";
        assert_eq!(prepare_text_for_speech(input), input);
    }

    #[test]
    fn speech_text_expands_currency_ranges_for_tts() {
        let input = "(€1,450–€15,500 / $1,565–$16,740)";
        assert_eq!(
            prepare_text_for_speech(input),
            "from one thousand four hundred fifty euros to fifteen thousand five hundred euros or from one thousand five hundred sixty five dollars to sixteen thousand seven hundred forty dollars"
        );
    }

    #[test]
    fn speech_text_moves_price_from_after_amount_before_amount() {
        let input = "Creta Palace (€2,970 from), Caramel Grecotel (€1,450 from for 20)";
        assert_eq!(
            prepare_text_for_speech(input),
            "Creta Palace from two thousand nine hundred seventy euros, Caramel Grecotel from one thousand four hundred fifty euros for 20"
        );
    }

    #[test]
    fn speech_text_expands_decimal_currency() {
        let input = "$1,450.50 total";
        assert_eq!(
            prepare_text_for_speech(input),
            "one thousand four hundred fifty dollars and fifty cents total"
        );
    }

    #[test]
    fn speech_text_expands_hotel_price_sentence() {
        let input = "(€1,450–€15,500 / $1,565–$16,740) — a property like Creta Palace (€2,970 from), Caramel Grecotel (€1,450 from for 20)";
        assert_eq!(
            prepare_text_for_speech(input),
            "from one thousand four hundred fifty euros to fifteen thousand five hundred euros or from one thousand five hundred sixty five dollars to sixteen thousand seven hundred forty dollars, a property like Creta Palace from two thousand nine hundred seventy euros, Caramel Grecotel from one thousand four hundred fifty euros for 20"
        );
    }

    #[test]
    fn speech_text_linearizes_markdown_table_rows_in_order() {
        let input = "| Name | Score |\n|------|-------|\n| Alice | 95 |\n| Bob | 87 |";
        assert_eq!(
            prepare_text_for_speech(input),
            "Name, Score. Alice, 95. Bob, 87."
        );
    }

    #[test]
    fn speech_text_strips_ansi_terminal_escapes() {
        let input = "\u{1b}[32mINFO\u{1b}[0m starting server";
        assert_eq!(prepare_text_for_speech(input), "INFO starting server");
    }

    #[test]
    fn speech_text_drops_divider_rules() {
        let input = "Results\n=======\nAll passed";
        assert_eq!(prepare_text_for_speech(input), "Results All passed");
    }

    #[test]
    fn speech_text_strips_list_and_heading_markers() {
        let input = "## Summary\n- First item\n- Second item";
        assert_eq!(
            prepare_text_for_speech(input),
            "Summary First item Second item"
        );
    }

    #[test]
    fn speech_text_strips_bold_markers() {
        let input = "This is **important** text";
        assert_eq!(prepare_text_for_speech(input), "This is important text");
    }

    #[test]
    fn speech_text_strips_box_drawing_frames() {
        let input = "┌─────┐\n│ Hi  │\n└─────┘";
        assert_eq!(prepare_text_for_speech(input), "Hi");
    }

    #[test]
    fn speech_text_collapses_long_symbol_runs() {
        let input = "Done!!!! Next";
        assert_eq!(prepare_text_for_speech(input), "Done Next");
    }

    #[test]
    fn speech_text_keeps_logical_or_out_of_table_path() {
        // The `||` must survive (not be linearized into ", "); parentheses are
        // separately normalized to pauses by the symbol pass.
        let input = "if (a || b) return;";
        assert_eq!(prepare_text_for_speech(input), "if a || b return;");
    }

    #[test]
    fn speech_text_speaks_byte_unit_abbreviation() {
        let input = "Saved 142 KB to disk";
        assert_eq!(prepare_text_for_speech(input), "Saved 142 kilobytes to disk");
    }

    #[test]
    fn speech_text_speaks_number_attached_units() {
        let input = "Synth took 45ms after a 90s wait.";
        assert_eq!(
            prepare_text_for_speech(input),
            "Synth took 45 milliseconds after a 90 seconds wait."
        );
    }

    #[test]
    fn speech_text_speaks_chars_abbreviation() {
        let input = "229 chars total";
        assert_eq!(prepare_text_for_speech(input), "229 characters total");
    }

    #[test]
    fn speech_text_speaks_snake_case_identifier_as_words() {
        let input = "Edit clean_structured_text now";
        assert_eq!(
            prepare_text_for_speech(input),
            "Edit clean structured text now"
        );
    }

    #[test]
    fn speech_text_speaks_path_separator_identifier_as_words() {
        let input = "call tokio::join here";
        assert_eq!(prepare_text_for_speech(input), "call tokio join here");
    }

    #[test]
    fn speech_text_drops_code_file_extension() {
        let input = "open reading.rs and speech_text.rs";
        assert_eq!(
            prepare_text_for_speech(input),
            "open reading and speech text"
        );
    }

    #[test]
    fn speech_text_speaks_arrow_as_to() {
        let input = "229 chars → 217 speech chars";
        assert_eq!(
            prepare_text_for_speech(input),
            "229 characters to 217 speech characters"
        );
    }

    #[test]
    fn speech_text_speaks_plus_in_expressions() {
        let input = "chunk N+1 is ready";
        assert_eq!(prepare_text_for_speech(input), "chunk N plus 1 is ready");
    }

    #[test]
    fn speech_text_leaves_title_ms_alone() {
        // "Ms." must not be misread as the millisecond unit — `ms` only expands
        // when glued to a number.
        let input = "Ms. Lopez paid the fee.";
        assert_eq!(prepare_text_for_speech(input), "Ms. Lopez paid the fee.");
    }
}
