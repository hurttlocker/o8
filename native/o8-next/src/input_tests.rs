use crate::composer::{Composer, Submit};
use gpui::{ClipboardItem, EntityInputHandler, TestAppContext};
use std::{cell::Cell, rc::Rc};

#[cfg(target_os = "macos")]
#[gpui::test]
fn macos_ime_emoji_paste_and_command_shortcuts(cx: &mut TestAppContext) {
    let (input, cx) = cx.add_window_view(|window, cx| {
        let input = Composer::new(cx);
        input.focus.focus(window);
        input
    });
    cx.simulate_input("前🙂後");
    input.update_in(cx, |i, window, cx| {
        i.replace_and_mark_text_in_range(Some(1..3), "にほ", Some(2..2), window, cx);
        i.replace_and_mark_text_in_range(None, "日本", Some(2..2), window, cx);
        assert_eq!(i.marked_text_range(window, cx), Some(1..3));
        i.replace_text_in_range(None, "日本語", window, cx);
    });
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "前日本語後");
    cx.simulate_keystrokes("cmd-z");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "前🙂後");
    cx.simulate_keystrokes("cmd-shift-z");
    input.update_in(cx, |i, window, cx| {
        i.replace_and_mark_text_in_range(Some(1..4), "👩🏽‍💻", Some(7..7), window, cx);
        assert_eq!(i.marked_text_range(window, cx), Some(1..8));
        assert_eq!(
            i.selected_text_range(false, window, cx).unwrap().range,
            8..8
        );
        i.unmark_text(window, cx);
    });
    cx.simulate_keystrokes("backspace");
    assert_eq!(
        input.read_with(cx, |i, _| i.text.clone()),
        "前後",
        "emoji deletes as one grapheme"
    );
    cx.simulate_keystrokes("cmd-z cmd-a cmd-c cmd-x cmd-v");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "前👩🏽‍💻後");
    cx.write_to_clipboard(ClipboardItem::new_string("one\r\n二\r🙂".into()));
    cx.simulate_keystrokes("cmd-a cmd-v");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "one\n二\n🙂");
    cx.simulate_keystrokes("cmd-z cmd-shift-z shift-enter");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "one\n二\n🙂\n");
    let submitted = Rc::new(Cell::new(0));
    let observed = submitted.clone();
    let _subscription = cx.update(|_, cx| {
        cx.subscribe(&input, move |_, event: &Submit, _| {
            observed.set(observed.get() + if event.0 { 10 } else { 1 });
        })
    });
    input.update_in(cx, |i, window, cx| {
        i.replace_and_mark_text_in_range(None, "かな", Some(2..2), window, cx);
    });
    cx.simulate_keystrokes("cmd-enter cmd-shift-enter");
    assert_eq!(
        submitted.get(),
        0,
        "marked text must not submit or change send mode"
    );
    input.update_in(cx, |i, window, cx| i.unmark_text(window, cx));
    cx.simulate_keystrokes("cmd-enter cmd-shift-enter");
    assert_eq!(submitted.get(), 11);
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
        window.refresh();
        window.draw(cx).clear();
    });
    input.read_with(cx, |i, _| assert_eq!(i.painted, i.revision));
}

#[cfg(target_os = "macos")]
#[gpui::test]
fn macos_command_navigation_and_deletion(cx: &mut TestAppContext) {
    let (input, cx) = cx.add_window_view(|window, cx| {
        let input = Composer::new(cx);
        input.focus.focus(window);
        input
    });
    cx.simulate_input("first\n日本語 🦀 last");
    cx.simulate_keystrokes("cmd-left");
    input.update_in(cx, |i, window, cx| {
        assert_eq!(
            i.selected_text_range(false, window, cx).unwrap().range,
            6..6,
            "Cmd-Left moves to the beginning of the current line"
        );
    });
    cx.simulate_keystrokes("cmd-shift-right");
    cx.simulate_keystrokes("cmd-x cmd-z");
    assert_eq!(
        input.read_with(cx, |i, _| i.text.clone()),
        "first\n日本語 🦀 last"
    );
    cx.simulate_keystrokes("cmd-down cmd-backspace");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "first\n");
    cx.simulate_keystrokes("cmd-z cmd-shift-z");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "first\n");
    cx.simulate_keystrokes("cmd-up");
    input.update_in(cx, |i, window, cx| {
        assert_eq!(
            i.selected_text_range(false, window, cx).unwrap().range,
            0..0
        );
    });
}

#[gpui::test]
fn ime_multiline_paste_undo(cx: &mut TestAppContext) {
    let (input, cx) = cx.add_window_view(|window, cx| {
        let input = Composer::new(cx);
        input.focus.focus(window);
        input
    });
    cx.simulate_input("hello");
    cx.simulate_keystrokes("shift-enter");
    cx.write_to_clipboard(ClipboardItem::new_string("pasted\nline 🦀".into()));
    cx.simulate_keystrokes("ctrl-v");
    assert_eq!(
        input.read_with(cx, |i, _| i.text.clone()),
        "hello\npasted\nline 🦀"
    );
    cx.simulate_keystrokes("ctrl-z");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "hello\n");
    cx.simulate_keystrokes("ctrl-shift-z");
    let before = input.read_with(cx, |i, _| i.text.clone());
    let end = before.encode_utf16().count();
    let submitted = Rc::new(Cell::new(0));
    let observed = submitted.clone();
    let _subscription = cx.update(|_, cx| {
        cx.subscribe(&input, move |_, _: &Submit, _| {
            observed.set(observed.get() + 1)
        })
    });
    input.update_in(cx, |i, window, cx| {
        i.replace_and_mark_text_in_range(None, "に", Some(1..1), window, cx);
        i.replace_and_mark_text_in_range(None, "日本", Some(2..2), window, cx);
        assert_eq!(i.marked_text_range(window, cx), Some(end..end + 2));
    });
    cx.simulate_keystrokes("enter");
    assert_eq!(submitted.get(), 0, "IME confirmation must never send");
    input.update_in(cx, |i, window, cx| {
        i.replace_text_in_range(None, "日本語", window, cx)
    });
    cx.simulate_keystrokes("ctrl-z");
    assert_eq!(
        input.read_with(cx, |i, _| i.text.clone()),
        before,
        "IME commits undo as one edit"
    );
    cx.simulate_keystrokes("ctrl-shift-z enter");
    assert_eq!(submitted.get(), 1);
}

#[gpui::test]
fn utf16_selection_and_composition_at_nonzero_offset(cx: &mut TestAppContext) {
    let (input, cx) = cx.add_window_view(|window, cx| {
        let input = Composer::new(cx);
        input.focus.focus(window);
        input
    });
    cx.simulate_input("a🦀z");
    input.update_in(cx, |i, window, cx| {
        i.replace_and_mark_text_in_range(Some(1..3), "かな", Some(1..2), window, cx);
        assert_eq!(i.text, "aかなz");
        assert_eq!(
            i.selected_text_range(false, window, cx).unwrap().range,
            2..3
        );
        i.replace_and_mark_text_in_range(None, "仮名", Some(2..2), window, cx);
        i.unmark_text(window, cx);
    });
    cx.simulate_keystrokes("ctrl-z");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "a🦀z");
    cx.simulate_keystrokes("ctrl-a ctrl-x");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "");
    cx.simulate_keystrokes("ctrl-z");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "a🦀z");
}

#[gpui::test]
fn long_multiline_paste_keeps_caret_reachable(cx: &mut TestAppContext) {
    let (input, cx) = cx.add_window_view(|window, cx| {
        let input = Composer::new(cx);
        input.focus.focus(window);
        input
    });
    let text = (0..20).map(|i| format!("line {i}\r\n")).collect::<String>();
    cx.write_to_clipboard(ClipboardItem::new_string(text));
    cx.simulate_keystrokes("ctrl-v");
    cx.run_until_parked();
    input.read_with(cx, |i, _| {
        assert!(i.height > gpui::px(100.));
        assert!(
            i.scroll.offset().y < gpui::px(0.),
            "caret follows long pasted content"
        );
        assert!(!i.text.contains('\r'));
    });
    cx.simulate_keystrokes("ctrl-home");
    cx.run_until_parked();
    assert_eq!(
        input.read_with(cx, |i, _| i.scroll.offset().y),
        gpui::px(0.)
    );
    cx.simulate_keystrokes("ctrl-z");
    assert_eq!(input.read_with(cx, |i, _| i.text.clone()), "");
}
