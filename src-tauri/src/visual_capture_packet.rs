//! A capture's selected moments, marked pixels and private source artifacts.
use base64::Engine;
use image::{Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone)]
pub struct Sample {
    pub at_ms: u64,
    pub image: RgbaImage,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
    pub t: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Mark {
    pub points: Vec<Point>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moment {
    pub at_ms: u64,
    pub kind: String,
    pub x: f64,
    pub y: f64,
}

pub fn scene_difference(a: &RgbaImage, b: &RgbaImage) -> f64 {
    if a.dimensions() != b.dimensions() {
        return 1.0;
    }
    let mut difference = 0.0;
    let mut count = 0;
    for y in (0..a.height()).step_by(16) {
        for x in (0..a.width()).step_by(16) {
            let p = a.get_pixel(x, y);
            let q = b.get_pixel(x, y);
            difference += (0..3)
                .map(|c| (p[c] as f64 - q[c] as f64).abs())
                .sum::<f64>()
                / 765.0;
            count += 1;
        }
    }
    difference / f64::from(count.max(1))
}

/// Prioritize the user's marks, then changed click results, then settled scene changes.
pub fn select(samples: &[Sample], marks: &[Mark], events: &[Moment], duration: u64) -> Vec<Moment> {
    let mut choices: Vec<(u8, Moment)> = marks
        .iter()
        .filter_map(|mark| {
            mark.points
                .last()
                .filter(|point| point.t <= duration)
                .map(|p| {
                    (
                        3,
                        Moment {
                            at_ms: p.t,
                            kind: "mark".into(),
                            x: p.x,
                            y: p.y,
                        },
                    )
                })
        })
        .collect();
    for event in events.iter().filter(|event| event.at_ms <= duration) {
        let before = samples
            .iter()
            .rev()
            .find(|sample| sample.at_ms <= event.at_ms.saturating_sub(250));
        let after = samples
            .iter()
            .position(|sample| sample.at_ms >= event.at_ms && sample.at_ms <= duration);
        if let (Some(before), Some(after)) = (before, after) {
            let settled = (after..samples.len()).find(|&index| {
                samples[index].at_ms <= event.at_ms + 1_500
                    && samples.get(index + 1).is_some_and(|next| {
                        scene_difference(&samples[index].image, &next.image) < 0.015
                    })
            });
            if let Some(index) = settled {
                if scene_difference(&before.image, &samples[index].image) > 0.025 {
                    choices.push((
                        2,
                        Moment {
                            at_ms: samples[index].at_ms,
                            ..event.clone()
                        },
                    ));
                }
            }
        }
    }
    let mut previous = samples.first();
    for pair in samples.windows(2).filter(|pair| pair[0].at_ms <= duration) {
        if let Some(reference) = previous {
            if scene_difference(&reference.image, &pair[0].image) > 0.06
                && scene_difference(&pair[0].image, &pair[1].image) < 0.015
            {
                choices.push((
                    1,
                    Moment {
                        at_ms: pair[0].at_ms,
                        kind: "change".into(),
                        x: 0.5,
                        y: 0.5,
                    },
                ));
                previous = Some(&pair[0]);
            }
        }
    }
    if choices.is_empty() {
        choices.push((
            0,
            Moment {
                at_ms: duration.saturating_sub(100),
                kind: "view".into(),
                x: 0.5,
                y: 0.5,
            },
        ));
    }
    choices.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.at_ms.cmp(&b.1.at_ms)));
    let mut selected: Vec<Moment> = Vec::new();
    for (_, choice) in choices {
        if selected.iter().any(|old| {
            old.at_ms.abs_diff(choice.at_ms) < 700
                && !(old.kind == "mark" && choice.kind == "mark" && old.at_ms != choice.at_ms)
        }) {
            continue;
        }
        selected.push(choice);
        if selected.len() == 12 {
            break;
        }
    }
    selected.sort_by_key(|choice| choice.at_ms);
    selected
}

fn paint_line(image: &mut RgbaImage, a: &Point, b: &Point) {
    let ax = a.x * f64::from(image.width());
    let ay = a.y * f64::from(image.height());
    let bx = b.x * f64::from(image.width());
    let by = b.y * f64::from(image.height());
    let steps = ((bx - ax).abs().max((by - ay).abs()).ceil() as usize).max(1);
    let radius = ((image.width() as f64 / 900.0).round() as i32).clamp(2, 5);
    for step in 0..=steps {
        let t = step as f64 / steps as f64;
        let x = (ax + (bx - ax) * t).round() as i32;
        let y = (ay + (by - ay) * t).round() as i32;
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                if dx * dx + dy * dy > radius * radius {
                    continue;
                }
                let px = x + dx;
                let py = y + dy;
                if px >= 0 && py >= 0 && px < image.width() as i32 && py < image.height() as i32 {
                    image.put_pixel(px as u32, py as u32, Rgba([255, 90, 31, 255]));
                }
            }
        }
    }
}

pub fn marked_crop(mut image: RgbaImage, moment: &Moment, marks: &[Mark]) -> (RgbaImage, [f64; 4]) {
    let active: Vec<&Mark> = marks
        .iter()
        .filter(|mark| {
            moment.kind == "mark"
                && mark
                    .points
                    .last()
                    .is_some_and(|last| last.t == moment.at_ms)
        })
        .collect();
    for mark in &active {
        for pair in mark.points.windows(2) {
            paint_line(&mut image, &pair[0], &pair[1]);
        }
        if let [point] = mark.points.as_slice() {
            paint_line(&mut image, point, point);
        }
    }
    let mut bounds = [1.0_f64, 1.0_f64, 0.0_f64, 0.0_f64];
    for point in active.iter().flat_map(|mark| &mark.points) {
        bounds[0] = bounds[0].min(point.x);
        bounds[1] = bounds[1].min(point.y);
        bounds[2] = bounds[2].max(point.x);
        bounds[3] = bounds[3].max(point.y);
    }
    if active.is_empty() {
        return (image, [0.0, 0.0, 1.0, 1.0]);
    }
    let center = [(bounds[0] + bounds[2]) / 2.0, (bounds[1] + bounds[3]) / 2.0];
    let size = [
        (bounds[2] - bounds[0] + 0.16).clamp(0.38, 1.0),
        (bounds[3] - bounds[1] + 0.18).clamp(0.38, 1.0),
    ];
    let left = (center[0] - size[0] / 2.0).clamp(0.0, 1.0 - size[0]);
    let top = (center[1] - size[1] / 2.0).clamp(0.0, 1.0 - size[1]);
    let x = (left * image.width() as f64).floor() as u32;
    let y = (top * image.height() as f64).floor() as u32;
    let width = ((size[0] * image.width() as f64).ceil() as u32)
        .min(image.width() - x)
        .max(1);
    let height = ((size[1] * image.height() as f64).ceil() as u32)
        .min(image.height() - y)
        .max(1);
    (
        image::imageops::crop_imm(&image, x, y, width, height).to_image(),
        [left, top, size[0], size[1]],
    )
}

pub fn png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image.clone())
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|_| "Could not encode a captured frame.")?;
    Ok(bytes.into_inner())
}

pub fn frame(
    image: RgbaImage,
    moment: &Moment,
    marks: &[Mark],
    directory: &Path,
    n: usize,
) -> Result<serde_json::Value, String> {
    let (cropped, crop) = marked_crop(image, moment, marks);
    let bytes = png(&cropped)?;
    let path = directory.join(format!("frame-{n:02}.png"));
    std::fs::write(&path, &bytes).map_err(|_| "Could not save a captured frame.")?;
    Ok(
        serde_json::json!({"atMs": moment.at_ms, "kind": moment.kind, "width": cropped.width(), "height": cropped.height(),
        "crop": crop, "file": path.to_string_lossy(), "dataUri": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn marked_moments_win_and_crops_retain_real_ink_pixels() {
        let samples = [Sample {
            at_ms: 0,
            image: RgbaImage::from_pixel(800, 600, Rgba([255; 4])),
        }];
        let marks = [Mark {
            points: vec![
                Point {
                    x: 0.4,
                    y: 0.5,
                    t: 800,
                },
                Point {
                    x: 0.6,
                    y: 0.5,
                    t: 1_000,
                },
            ],
        }];
        let selected = select(
            &samples,
            &marks,
            &[Moment {
                at_ms: 1_100,
                kind: "click".into(),
                x: 0.5,
                y: 0.5,
            }],
            2_000,
        );
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].kind, "mark");
        let (image, crop) = marked_crop(samples[0].image.clone(), &selected[0], &marks);
        assert!(image.pixels().any(|pixel| pixel.0 == [255, 90, 31, 255]));
        assert!(crop[0] < 0.4 && crop[0] + crop[2] > 0.6);
    }
    #[test]
    fn selection_is_bounded_and_temporally_ordered() {
        let marks: Vec<Mark> = (0..200)
            .map(|n| Mark {
                points: vec![Point {
                    t: n * 900,
                    x: 0.5,
                    y: 0.5,
                }],
            })
            .collect();
        let selected = select(&[], &marks, &[], 90_000);
        assert_eq!(selected.len(), 12);
        assert!(selected
            .windows(2)
            .all(|pair| pair[0].at_ms < pair[1].at_ms));
        assert!(selected.iter().all(|moment| moment.at_ms <= 90_000));
    }
    #[test]
    fn a_mark_cannot_be_painted_on_a_different_screen_moment() {
        let image = RgbaImage::from_pixel(800, 600, Rgba([255; 4]));
        let marks = [Mark {
            points: vec![
                Point {
                    x: 0.2,
                    y: 0.3,
                    t: 1_000,
                },
                Point {
                    x: 0.5,
                    y: 0.5,
                    t: 1_200,
                },
            ],
        }];
        for (at_ms, kind) in [(1_100, "view"), (1_100, "mark"), (1_300, "change")] {
            let moment = Moment {
                at_ms,
                kind: kind.into(),
                x: 0.5,
                y: 0.5,
            };
            let (actual, crop) = marked_crop(image.clone(), &moment, &marks);
            assert_eq!(actual, image);
            assert_eq!(crop, [0.0, 0.0, 1.0, 1.0]);
        }
    }
    #[test]
    fn clicks_wait_for_a_changed_settled_screen_and_ignore_unchanged_clicks() {
        let samples: Vec<Sample> = [
            (0, 255),
            (220, 255),
            (440, 100),
            (660, 0),
            (880, 0),
            (1_100, 0),
        ]
        .into_iter()
        .map(|(at_ms, color)| Sample {
            at_ms,
            image: RgbaImage::from_pixel(80, 60, Rgba([color, color, color, 255])),
        })
        .collect();
        let clicks = [
            Moment {
                at_ms: 470,
                kind: "click".into(),
                x: 0.5,
                y: 0.5,
            },
            Moment {
                at_ms: 900,
                kind: "click".into(),
                x: 0.5,
                y: 0.5,
            },
        ];
        let selected = select(&samples, &[], &clicks, 1_200);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].at_ms, 660);
        assert_eq!(selected[0].kind, "click");
    }
}
