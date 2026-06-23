use super::PolishContext;

/// Build the text prompt with all available context.
pub(super) fn build_prompt(ctx: &PolishContext, can_use_audio: bool) -> String {
    let mut prompt = String::new();

    // Core instruction
    if can_use_audio && ctx.audio_wav.is_some() {
        prompt.push_str(
            "You are a speech-to-text correction assistant with a gift for punctuation. \
             Apple's speech recognizer produced the transcript below, but it may contain errors. \
             You also have the ORIGINAL AUDIO recording — listen to it carefully to hear what was actually said.\n\n",
        );
    } else {
        prompt.push_str(
            "You are a speech-to-text correction assistant with a gift for punctuation. \
             Apple's speech recognizer produced the transcript below, but it may contain errors. \
             You do NOT have the original audio for this pass, so infer corrections from transcript context, app context, dictionary hints, and user instructions.\n\n",
        );
    }

    prompt.push_str("CORRECTION RULES:\n");
    if can_use_audio && ctx.audio_wav.is_some() {
        prompt.push_str("- Compare Apple's transcript against what you hear in the audio\n");
    } else {
        prompt.push_str(
            "- Correct obvious dictation errors, homophones, and garbled words from context\n",
        );
    }
    prompt.push_str("- Fix any words Apple misheard (mishears, homophones, garbled words)\n");
    prompt.push_str("- PRESERVE the speaker's exact style, tone, slang, and casual language\n");
    prompt.push_str("- Do NOT formalize casual speech — if they said 'gonna' keep 'gonna'\n");
    prompt.push_str("- Do NOT add or remove words that were actually spoken\n");
    prompt.push_str("- Capitalize proper nouns, names, brands, app names\n\n");

    // Output tone (Settings → Input → Tone). `auto`/unset keeps the default
    // preserve-the-speaker behavior above; the others steer cleanup intensity.
    match crate::stt::keys::config_string("output_tone").as_deref() {
        Some("raw") => prompt.push_str(
            "OUTPUT TONE — Raw: Make only essential fixes (clear mishears). Keep filler \
             words, false starts, and the exact phrasing. Do not smooth or restructure.\n\n",
        ),
        Some("clean") => prompt.push_str(
            "OUTPUT TONE — Clean: Fix mishears and punctuation, and remove filler words \
             (um, uh, like) and false starts — but keep the speaker's voice and word choice.\n\n",
        ),
        Some("formal") => prompt.push_str(
            "OUTPUT TONE — Formal: Clean this into polished, professional prose. Expand \
             contractions, fix grammar, drop slang and filler. This OVERRIDES the \
             preserve-casual-speech rules above.\n\n",
        ),
        Some("casual") => prompt.push_str(
            "OUTPUT TONE — Casual: Keep it relaxed and conversational. Keep contractions \
             and casual phrasing; just fix mishears and add light punctuation.\n\n",
        ),
        _ => {}
    }

    // Adaptive punctuation — the core upgrade
    prompt.push_str("ADAPTIVE PUNCTUATION — this is critical. Do NOT just add basic periods and commas. \
                     Read between the lines. Listen to HOW the person speaks and infer the punctuation \
                     that makes their text read the way they intended:\n\n");

    prompt.push_str("Prosodic cues (from audio):\n");
    prompt.push_str("- A dramatic pause mid-sentence → em dash (—) for an aside or interruption\n");
    prompt.push_str("- Trailing off, slowing down at the end → ellipsis (…)\n");
    prompt.push_str(
        "- Rising intonation → question mark, even if the words aren't a grammatical question\n",
    );
    prompt.push_str("- Emphasis or air-quote tone on a word/phrase → wrap in quotation marks\n");
    prompt.push_str(
        "- A quick aside spoken faster or softer → parentheses or em dashes around it\n\n",
    );

    prompt.push_str("Semantic cues (from meaning):\n");
    prompt.push_str(
        "- Reporting what someone said or might say → quotation marks around their words\n",
    );
    prompt.push_str("- Referencing a title, term, or label → quotation marks (\"the feature called Spotlight\")\n");
    prompt.push_str(
        "- Using a word ironically or with skepticism → quotation marks (their \"solution\")\n",
    );
    prompt.push_str("- Two closely related independent thoughts → semicolon\n");
    prompt.push_str("- Introducing a list, explanation, or reveal → colon\n");
    prompt.push_str(
        "- A thought that breaks away then resumes → em dashes as parenthetical pair\n\n",
    );

    prompt.push_str("Typography:\n");
    prompt.push_str(
        "- Use curly/smart quotes (\u{201c} \u{201d} \u{2018} \u{2019}), not straight quotes\n",
    );
    prompt.push_str("- Use em dash (\u{2014}), not hyphens or double hyphens\n");
    prompt.push_str("- Use proper ellipsis character (\u{2026}), not three periods\n");
    prompt.push_str("- Use en dash (\u{2013}) for ranges (e.g. 3\u{2013}5 minutes)\n\n");

    prompt.push_str("Be opinionated. If the sentence reads better with an em dash than a comma, use the em dash. \
                     If quotes would add clarity or voice, add them. The goal is text that reads like the person \
                     sounds — their rhythm, their pauses, their emphasis — not just grammatically correct transcription.\n\n");

    // Unified app/text context — reply awareness, tone, spelling, hallucination guard
    let has_text_context =
        ctx.window_title.is_some() || ctx.selected_text.is_some() || ctx.ax_excerpt.is_some();
    if ctx.frontmost_app.is_some() || has_text_context {
        prompt.push_str("APP & TEXT CONTEXT:\n");

        let app_name = ctx
            .frontmost_app
            .as_deref()
            .map(app_display_name)
            .unwrap_or("an application");
        let category = ctx
            .frontmost_app
            .as_deref()
            .map(app_category)
            .unwrap_or(AppCategory::Other);

        prompt.push_str(&format!("The user is typing into {}.", app_name));

        if let Some(title) = ctx.window_title.as_deref() {
            let title = title.trim();
            if !title.is_empty() && title != app_name {
                prompt.push_str(&format!(" Window: \"{}\".", title));
            }
        }

        prompt.push('\n');

        // Text context — the meat of the "magical" layer. Put selected text
        // first because it's the strongest signal (user explicitly highlighted
        // it), then the broader on-screen excerpt. The rules below are
        // deliberately strict: screen text is a DISAMBIGUATION HINT, never a
        // license to replace words the user clearly pronounced. Prior version
        // over-rotated and swapped "QQQ" (a Nasdaq ETF the user said) with
        // "UGC" (the window title) because the AX excerpt contained UGC.
        let has_text_signal = ctx
            .selected_text
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
            || ctx
                .ax_excerpt
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
        if has_text_signal {
            prompt.push_str("\nHOW TO USE THE SCREEN TEXT BELOW:\n");
            prompt.push_str("- Use it to spell proper nouns, product names, usernames, and technical terms correctly\n");
            prompt.push_str("- Use it to resolve pronouns (\"he\", \"it\", \"that\") when a referent is obvious on screen\n");
            prompt
                .push_str("- Use it to match the tone of a conversation the user is replying to\n");
            prompt.push_str("- DO NOT replace a word the user pronounced clearly. Trust the audio and Apple's transcript first.\n");
            prompt.push_str("- DO NOT assume every acronym on screen is what the user said. Common finance/tech acronyms (QQQ, SPY, API, USD, ETF) are probably real words the user spoke.\n");
            prompt.push_str("- If you aren't sure, leave the user's word alone.\n");
        }
        if let Some(sel) = ctx.selected_text.as_deref() {
            let sel = sel.trim();
            if !sel.is_empty() {
                prompt.push_str("\nHIGHLIGHTED TEXT (the user selected this — likely the referent of pronouns like \"this\", \"it\", \"that\"):\n");
                prompt.push_str(sel);
                prompt.push('\n');
            }
        }
        if let Some(excerpt) = ctx.ax_excerpt.as_deref() {
            let excerpt = excerpt.trim();
            if !excerpt.is_empty() {
                prompt.push_str("\nVISIBLE TEXT ON SCREEN (focused window contents, for spelling hints only):\n");
                prompt.push_str(excerpt);
                prompt.push('\n');
            }
        }

        match category {
            AppCategory::Messaging => {
                prompt.push_str(
                    "\
                    This is a messaging app. The user is likely replying to a conversation \
                    visible on screen. Use the visible messages to:\n\
                    - Reference names, dates, times, and topics from the visible conversation\n\
                    - Shape the dictation as a natural reply if it sounds like one\n\
                    - Match the conversational tone already established on screen\n\
                    - Keep it casual — messages don\u{2019}t need perfect grammar\n\
                    - Short sentences are better than long ones\n",
                );
            }
            AppCategory::Email => {
                prompt.push_str(
                    "\
                    This is an email app. The user may be composing a reply to the email \
                    visible on screen. Use the visible email to:\n\
                    - Reference names, dates, subjects from the original email\n\
                    - Shape the dictation as a professional reply if it sounds like one\n\
                    - Use complete sentences and proper punctuation\n\
                    - Match the formality level of the original email\n",
                );
            }
            AppCategory::CodeEditor => {
                prompt.push_str(
                    "\
                    This is a code editor. The user may be writing code comments, commit \
                    messages, PR descriptions, or documentation. Use the visible code to:\n\
                    - Spell function names, variables, classes exactly as they appear on screen\n\
                    - Preserve camelCase, snake_case, and technical terms precisely\n\
                    - Keep it concise \u{2014} developers hate verbosity\n\
                    - If the dictation references a visible error or warning, use the exact text\n",
                );
            }
            AppCategory::Writing => {
                prompt.push_str(
                    "\
                    This is a writing or notes app. The user may be continuing a document \
                    visible on screen. Use the visible content to:\n\
                    - Maintain consistent style, terminology, and tone with existing text\n\
                    - Apply your best editorial judgment on punctuation and structure\n\
                    - This is where em dashes, semicolons, and thoughtful prose matter most\n",
                );
            }
            AppCategory::Social => {
                prompt.push_str(
                    "\
                    This is social media. Keep it punchy, casual, and natural. \
                    No formal punctuation unless it adds voice. Fragments are fine.\n",
                );
            }
            AppCategory::Other => {}
        }

        // Hallucination guard — critical
        prompt.push_str("\nCRITICAL: The user\u{2019}s spoken words ALWAYS take precedence over visible app text. \
                         If the app text says \u{201c}Thursday at 3\u{201d} but the user says \u{201c}Thursday at 2,\u{201d} \
                         keep 2. The app text is context for understanding intent, NOT ground truth. \
                         Never \u{201c}correct\u{201d} the user\u{2019}s words to match what\u{2019}s on screen.\n\n");
    }

    // Add dictionary words
    if !ctx.dictionary.is_empty() {
        prompt.push_str(&format!(
            "CUSTOM DICTIONARY (spell exactly as shown): {}\n\n",
            ctx.dictionary.join(", ")
        ));
    }

    // Add user instructions
    if !ctx.instructions.is_empty() {
        prompt.push_str(&format!("USER INSTRUCTIONS: {}\n\n", ctx.instructions));
    }

    if !ctx.replacements.is_empty() {
        prompt.push_str("PHRASE REPLACEMENTS (deterministic post-pass rules):\n");
        for rule in &ctx.replacements {
            prompt.push_str(&format!(
                "- \"{}\" → \"{}\"\n",
                rule.trigger, rule.replacement
            ));
        }
        prompt.push('\n');
    }

    // Gemini was observed silently truncating long (~1000 char) dictations
    // after the first clean sentence and returning just that. Explicitly
    // demand full coverage so it doesn't "help" by summarizing or stopping
    // at the first natural pause.
    prompt.push_str("OUTPUT COVERAGE (CRITICAL):\n");
    prompt.push_str("- Polish the ENTIRE transcript from start to finish.\n");
    prompt.push_str(
        "- Every word Apple produced must be represented in your output (corrected if needed).\n",
    );
    prompt.push_str("- Do NOT stop early at the first clean sentence. Do NOT summarize the later parts. Do NOT drop tail words.\n");
    prompt.push_str("- If a word or phrase is ambiguous or garbled, keep it verbatim — preserving a rough word beats omitting it.\n");
    prompt.push_str("- The corrected output should be AT LEAST as long as the input, usually within 10% of the same character count.\n");
    prompt.push_str("- Return ONLY the corrected text, no commentary.\n\n");

    prompt.push_str(&format!("APPLE'S TRANSCRIPT:\n{}\n\n", ctx.transcript));

    if ctx.audio_wav.is_some() {
        prompt.push_str("Listen to the audio above. Correct any errors and apply adaptive punctuation based on how the person speaks.\n");
    } else {
        prompt.push_str("Correct any errors and apply adaptive punctuation based on the meaning and rhythm of the text.\n");
    }

    prompt
}

/// App categories for context-aware polish.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum AppCategory {
    Messaging,
    Email,
    CodeEditor,
    Writing,
    Social,
    Other,
}

pub(super) fn app_category_for_bundle(bundle_id: &str) -> &'static str {
    match app_category(bundle_id) {
        AppCategory::Messaging => "messaging",
        AppCategory::Email => "email",
        AppCategory::CodeEditor => "code",
        AppCategory::Writing => "writing",
        AppCategory::Social => "social",
        AppCategory::Other => "other",
    }
}

/// Map a bundle ID to a human-readable app name for the prompt.
fn app_display_name(bundle_id: &str) -> &str {
    match bundle_id {
        s if s.contains("slack") => "Slack",
        s if s.contains("discord") => "Discord",
        s if s.contains("MobileSMS") || s.contains("Messages") => "Messages",
        s if s.contains("telegram") => "Telegram",
        s if s.contains("whatsapp") => "WhatsApp",
        s if s.contains("mail") || s.contains("Mail") => "Mail",
        s if s.contains("outlook") || s.contains("Outlook") => "Outlook",
        s if s.contains("gmail") => "Gmail",
        s if s.contains("VSCode") || s.contains("vscode") || s.contains("Code") => "VS Code",
        s if s.contains("xcode") || s.contains("Xcode") => "Xcode",
        s if s.contains("cursor") || s.contains("Cursor") => "Cursor",
        s if s.contains("Terminal") || s.contains("iTerm") || s.contains("Warp") => "Terminal",
        s if s.contains("jetbrains") || s.contains("intellij") => "JetBrains IDE",
        s if s.contains("notion") || s.contains("Notion") => "Notion",
        s if s.contains("bear") => "Bear",
        s if s.contains("ulysses") => "Ulysses",
        s if s.contains("obsidian") => "Obsidian",
        s if s.contains("Pages") => "Pages",
        s if s.contains("TextEdit") => "TextEdit",
        s if s.contains("Notes") => "Notes",
        s if s.contains("docs.google") => "Google Docs",
        s if s.contains("twitter") || s.contains("Twitter") => "X/Twitter",
        s if s.contains("reddit") => "Reddit",
        s if s.contains("Safari")
            || s.contains("Chrome")
            || s.contains("Firefox")
            || s.contains("Arc") =>
        {
            "a web browser"
        }
        _ => "an application",
    }
}

/// Classify a bundle ID into an app category.
pub(super) fn app_category(bundle_id: &str) -> AppCategory {
    let id = bundle_id.to_lowercase();

    if id.contains("slack")
        || id.contains("discord")
        || id.contains("mobilesms")
        || id.contains("messages")
        || id.contains("telegram")
        || id.contains("whatsapp")
    {
        return AppCategory::Messaging;
    }
    if id.contains("twitter") || id.contains("reddit") {
        return AppCategory::Social;
    }
    if id.contains("mail") || id.contains("outlook") || id.contains("gmail") {
        return AppCategory::Email;
    }
    if id.contains("vscode")
        || id.contains("code")
        || id.contains("xcode")
        || id.contains("cursor")
        || id.contains("terminal")
        || id.contains("iterm")
        || id.contains("warp")
        || id.contains("jetbrains")
        || id.contains("intellij")
    {
        return AppCategory::CodeEditor;
    }
    if id.contains("notion")
        || id.contains("bear")
        || id.contains("ulysses")
        || id.contains("obsidian")
        || id.contains("pages")
        || id.contains("textedit")
        || id.contains("notes")
        || id.contains("docs.google")
    {
        return AppCategory::Writing;
    }

    AppCategory::Other
}
