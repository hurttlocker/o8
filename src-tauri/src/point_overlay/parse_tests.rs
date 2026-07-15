use super::*;

#[test]
fn strips_single_tag_and_parses() {
    let (clean, tags) = parse_point_tags("It's right here. [POINT:640,360:Save button] Click it.");
    assert_eq!(clean, "It's right here. Click it.");
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].x, 640.0);
    assert_eq!(tags[0].label, "Save button");
}

#[test]
fn accepts_screen_suffix_and_colon_labels() {
    let (clean, tags) = parse_point_tags("[POINT:10,20:Step 1: open settings:screen2] go");
    assert_eq!(clean, "go");
    assert_eq!(tags[0].label, "Step 1: open settings");
    assert_eq!(tags[0].y, 20.0);
}

#[test]
fn multiple_tags_in_order() {
    let (clean, tags) = parse_point_tags("First [POINT:1,2:a] then [POINT:3,4:b] done");
    assert_eq!(clean, "First then done");
    assert_eq!(tags.len(), 2);
    assert_eq!(tags[1].x, 3.0);
}

#[test]
fn malformed_tags_stripped_not_kept() {
    let (clean, tags) = parse_point_tags("Hm [POINT:abc,def:bad] ok");
    assert_eq!(clean, "Hm ok");
    assert!(tags.is_empty());
}

#[test]
fn no_tags_passthrough() {
    let (clean, tags) = parse_point_tags("Nothing to point at.");
    assert_eq!(clean, "Nothing to point at.");
    assert!(tags.is_empty());
}

#[test]
fn guide_tag_sets_dwell() {
    let (clean, tags) = parse_point_tags("Right here. [GUIDE:320,200:Reply button]");
    assert_eq!(clean, "Right here.");
    assert_eq!(tags.len(), 1);
    assert!(tags[0].dwell);
    assert_eq!(tags[0].label, "Reply button");
}

#[test]
fn mixed_point_and_guide_in_order() {
    let (clean, tags) = parse_point_tags("A [POINT:1,2:a] then [GUIDE:3,4:b] done");
    assert_eq!(clean, "A then done");
    assert_eq!(tags.len(), 2);
    assert!(!tags[0].dwell);
    assert!(tags[1].dwell);
    assert_eq!(tags[1].x, 3.0);
}

#[test]
fn point_tags_default_to_point_shape() {
    let (_, tags) = parse_point_tags("[POINT:1,2:a]");
    assert!(tags[0].shape == Shape::Point);
}

#[test]
fn exact_element_tags_parse_and_reject_zero() {
    let (clean, tags) =
        parse_point_tags("Here [POINT:el:12:Save] then [GUIDE:el:7:Reply] and [DRAW:el:3:Total]");
    assert_eq!(clean, "Here then and");
    assert_eq!(tags.len(), 3);
    assert_eq!(tags[0].element_id, Some(12));
    assert_eq!(tags[1].element_id, Some(7));
    assert!(tags[1].dwell);
    assert_eq!(tags[2].element_id, Some(3));
    assert!(tags[2].shape == Shape::Rect);
    assert!(parse_point_tags("[POINT:el:0:bad]").1.is_empty());
}

#[test]
fn draw_rect_parses_both_corners() {
    let (clean, tags) =
        parse_point_tags("Here's the bug. [DRAW:rect:100,120,300,260:error banner]");
    assert_eq!(clean, "Here's the bug.");
    assert_eq!(tags.len(), 1);
    assert!(tags[0].shape == Shape::Rect);
    assert_eq!(tags[0].x, 100.0);
    assert_eq!(tags[0].y, 120.0);
    assert_eq!(tags[0].x2, 300.0);
    assert_eq!(tags[0].y2, 260.0);
    assert_eq!(tags[0].label, "error banner");
}

#[test]
fn draw_arrow_parses_with_screen_suffix() {
    let (clean, tags) = parse_point_tags("[DRAW:arrow:10,10,90,90:to Save:screen1] go");
    assert_eq!(clean, "go");
    assert!(tags[0].shape == Shape::Arrow);
    assert_eq!(tags[0].x2, 90.0);
    assert_eq!(tags[0].label, "to Save");
}

#[test]
fn draw_box_alias_maps_to_rect() {
    let (_, tags) = parse_point_tags("[DRAW:box:1,2,3,4:x]");
    assert!(tags[0].shape == Shape::Rect);
}

#[test]
fn draw_bad_shape_or_arity_stripped() {
    let (c1, t1) = parse_point_tags("a [DRAW:blob:1,2,3,4:x] b");
    assert_eq!(c1, "a b");
    assert!(t1.is_empty());
    let (c2, t2) = parse_point_tags("a [DRAW:rect:1,2:x] b");
    assert_eq!(c2, "a b");
    assert!(t2.is_empty());
}

#[test]
fn draw_line_parses_two_points() {
    let (clean, tags) = parse_point_tags("The hypotenuse: [DRAW:line:100,400,300,200:c]");
    assert_eq!(clean, "The hypotenuse:");
    assert_eq!(tags.len(), 1);
    assert!(tags[0].shape == Shape::Line);
    assert_eq!(tags[0].x, 100.0);
    assert_eq!(tags[0].y2, 200.0);
    assert_eq!(tags[0].label, "c");
}

#[test]
fn draw_text_parses_single_point_and_label() {
    let (clean, tags) = parse_point_tags("[DRAW:text:150,300:a² + b² = c²] there");
    assert_eq!(clean, "there");
    assert_eq!(tags.len(), 1);
    assert!(tags[0].shape == Shape::Text);
    assert_eq!(tags[0].x, 150.0);
    assert_eq!(tags[0].y, 300.0);
    assert_eq!(tags[0].label, "a² + b² = c²");
}

#[test]
fn draw_text_requires_label_and_point_arity() {
    let (c1, t1) = parse_point_tags("a [DRAW:text:1,2,3,4:x] b");
    assert_eq!(c1, "a b");
    assert!(t1.is_empty());
    let (c2, t2) = parse_point_tags("a [DRAW:text:1,2:] b");
    assert_eq!(c2, "a b");
    assert!(t2.is_empty());
}

#[test]
fn label_alias_maps_to_text() {
    let (_, tags) = parse_point_tags("[DRAW:label:5,6:side a]");
    assert!(tags[0].shape == Shape::Text);
    assert_eq!(tags[0].label, "side a");
}

#[test]
fn mixed_point_and_draw_in_order() {
    let (clean, tags) = parse_point_tags("First [POINT:1,2:a] then [DRAW:rect:5,6,7,8:b] done");
    assert_eq!(clean, "First then done");
    assert_eq!(tags.len(), 2);
    assert!(tags[0].shape == Shape::Point);
    assert!(tags[1].shape == Shape::Rect);
    assert_eq!(tags[1].y2, 8.0);
}

#[test]
fn tag_to_string_round_trips_through_parse() {
    let src = "[POINT:1,2:a] [GUIDE:3,4:b] [DRAW:rect:5,6,7,8:c] \
               [DRAW:arrow:9,10,11,12:d] [DRAW:line:13,14,15,16:e] \
               [DRAW:text:17,18:a² + b² = c²] [POINT:el:19:Save] \
               [GUIDE:el:20:Reply] [DRAW:el:21:Total]";
    let (_, tags) = parse_point_tags(src);
    assert_eq!(tags.len(), 9);
    let rebuilt = tags.iter().map(tag_to_string).collect::<Vec<_>>().join(" ");
    let (_, reparsed) = parse_point_tags(&rebuilt);
    assert_eq!(reparsed.len(), tags.len());
    for (a, b) in tags.iter().zip(reparsed.iter()) {
        assert!(a.shape == b.shape);
        assert_eq!(a.element_id, b.element_id);
        assert_eq!(a.x, b.x);
        assert_eq!(a.y, b.y);
        assert_eq!(a.x2, b.x2);
        assert_eq!(a.y2, b.y2);
        assert_eq!(a.dwell, b.dwell);
        assert_eq!(a.label, b.label);
    }
}
