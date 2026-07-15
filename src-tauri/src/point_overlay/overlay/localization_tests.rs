use super::*;

#[test]
fn exact_tags_flow_through_production_resolver() {
    let screen = ScreenContext {
        trace_id: 42,
        png_base64: String::new(),
        img_w: 400,
        img_h: 200,
        mon_x: 100.0,
        mon_y: 200.0,
        mon_w: 200.0,
        mon_h: 100.0,
        ax_catalog: vec![crate::screen_localization::ActionableElement {
            id: 7,
            role: "AXButton".into(),
            label: "Save".into(),
            frame: (110.0, 220.0, 40.0, 20.0),
        }],
        web_catalog: vec![crate::agent::web_localization::WebActionableElement {
            id: 4,
            selector: "#reply".into(),
            surface: "panel".into(),
            role: "button".into(),
            label: "Reply".into(),
            frame: (180.0, 240.0, 30.0, 20.0),
        }],
    };
    let (_, tags) =
        super::super::parse_point_tags("[GUIDE:el:7] [DRAW:web:4:Reply] [POINT:el:99:stale]");
    let (points, stats) = resolve_points(&screen, &tags);

    assert_eq!(points.len(), 2);
    assert_eq!(points[0]["x"], 30.0);
    assert_eq!(points[0]["y"], 30.0);
    assert_eq!(points[0]["label"], "Save");
    assert_eq!(points[0]["dwell"], true);
    assert_eq!(points[1]["x"], 80.0);
    assert_eq!(points[1]["x2"], 110.0);
    assert_eq!(stats.exact_resolved, 2);
    assert_eq!(stats.native_exact_resolved, 1);
    assert_eq!(stats.web_exact_resolved, 1);
    assert_eq!(stats.stale, 1);
    assert_eq!(stats.ax_snapped, 0);
    assert_eq!(stats.direct_pixel, 0);
}
