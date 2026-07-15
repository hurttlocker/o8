use super::{composite_strokes, encode_png, RawCapture};
use base64::Engine;

fn white_capture(w: u32, h: u32) -> RawCapture {
    let img = image::RgbaImage::from_pixel(w, h, image::Rgba([255, 255, 255, 255]));
    RawCapture {
        trace_id: 1,
        png_bytes: encode_png(&img).expect("encode white png"),
        mon_x: 0.0,
        mon_y: 0.0,
        mon_w: w as f64,
        mon_h: h as f64,
        ax_catalog: Vec::new(),
    }
}

fn decode(b64: &str) -> image::RgbaImage {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("valid base64");
    image::load_from_memory(&bytes)
        .expect("valid png")
        .to_rgba8()
}

#[test]
fn no_strokes_yields_none() {
    let raw = white_capture(200, 160);
    assert!(composite_strokes(&raw, &[]).is_none());
    assert!(composite_strokes(&raw, &[vec![]]).is_none());
}

#[test]
fn burns_orange_ink_and_cuts_a_crop() {
    let raw = white_capture(400, 300);
    let strokes = vec![vec![(0.25, 0.25), (0.4, 0.4), (0.6, 0.6)]];
    let sc = composite_strokes(&raw, &strokes).expect("composited");

    let composite = decode(&sc.screen.png_base64);
    assert!(composite.width().max(composite.height()) <= 1568);
    assert_eq!(composite.width(), sc.screen.img_w);
    assert_eq!(composite.height(), sc.screen.img_h);
    assert_eq!(sc.screen.mon_w, 400.0);
    assert_eq!(sc.screen.trace_id, raw.trace_id);

    let mut found_ink = false;
    for py in 0..composite.height() {
        for px in 0..composite.width() {
            let p = composite.get_pixel(px, py).0;
            if p[0] > 200 && (p[2] as u16) + 40 < p[0] as u16 {
                found_ink = true;
                break;
            }
        }
        if found_ink {
            break;
        }
    }
    assert!(found_ink, "expected orange ink burned into the composite");

    let crop = decode(sc.crop_png_base64.as_ref().expect("crop present"));
    assert!(crop.width() < composite.width() || crop.height() < composite.height());
}
