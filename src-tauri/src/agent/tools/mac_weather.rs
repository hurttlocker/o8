//! Weather — the minute-one voice ask ("what's the weather?").
//!
//! Keyless by design so it works fresh out of the box: location comes from IP
//! geolocation (ipapi.co, fallback ip-api.com) or a spoken place name via
//! Open-Meteo's geocoder; the forecast comes from Open-Meteo (free, no key).
//! The tool returns a compact, already-summarized payload so the model just
//! phrases it — no raw API dumps in the context.

use serde_json::{json, Value};
use std::time::Duration;

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("o8-symon-weather")
        .build()
        .map_err(|e| format!("http client failed: {e}"))
}

fn net_err(e: reqwest::Error) -> String {
    format!("weather lookup failed (network): {e}")
}

/// Percent-encode a query value (our reqwest build has no `query` feature).
fn urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// WMO weather interpretation codes → spoken words.
fn wmo_words(code: i64) -> &'static str {
    match code {
        0 => "clear",
        1 => "mostly clear",
        2 => "partly cloudy",
        3 => "overcast",
        45 | 48 => "foggy",
        51 | 53 | 55 => "drizzling",
        56 | 57 => "freezing drizzle",
        61 | 63 => "raining",
        65 => "raining heavily",
        66 | 67 => "freezing rain",
        71 | 73 => "snowing",
        75 | 77 => "snowing heavily",
        80 | 81 => "rain showers",
        82 => "heavy rain showers",
        85 | 86 => "snow showers",
        95 => "thunderstorms",
        96 | 99 => "thunderstorms with hail",
        _ => "mixed conditions",
    }
}

struct Location {
    lat: f64,
    lon: f64,
    label: String,
    country: String,
}

/// Locate by IP — ipapi.co first, ip-api.com as fallback (both keyless).
async fn locate_by_ip(client: &reqwest::Client) -> Result<Location, String> {
    if let Ok(resp) = client.get("https://ipapi.co/json/").send().await {
        if let Ok(v) = resp.json::<Value>().await {
            if let (Some(lat), Some(lon)) = (
                v.get("latitude").and_then(|x| x.as_f64()),
                v.get("longitude").and_then(|x| x.as_f64()),
            ) {
                return Ok(Location {
                    lat,
                    lon,
                    label: v
                        .get("city")
                        .and_then(|x| x.as_str())
                        .unwrap_or("your area")
                        .to_string(),
                    country: v
                        .get("country_code")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                });
            }
        }
    }
    let v: Value = client
        .get("http://ip-api.com/json/")
        .send()
        .await
        .map_err(net_err)?
        .json()
        .await
        .map_err(net_err)?;
    let lat = v
        .get("lat")
        .and_then(|x| x.as_f64())
        .ok_or("I couldn't work out your location from the network.")?;
    Ok(Location {
        lat,
        lon: v.get("lon").and_then(|x| x.as_f64()).unwrap_or(0.0),
        label: v
            .get("city")
            .and_then(|x| x.as_str())
            .unwrap_or("your area")
            .to_string(),
        country: v
            .get("countryCode")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Resolve a spoken place name via Open-Meteo's geocoder.
async fn locate_by_name(client: &reqwest::Client, place: &str) -> Result<Location, String> {
    let url = format!(
        "https://geocoding-api.open-meteo.com/v1/search?name={}&count=1",
        urlenc(place)
    );
    let v: Value = client
        .get(&url)
        .send()
        .await
        .map_err(net_err)?
        .json()
        .await
        .map_err(net_err)?;
    let hit = v
        .get("results")
        .and_then(|r| r.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| format!("I couldn't find a place called '{place}'."))?;
    Ok(Location {
        lat: hit.get("latitude").and_then(|x| x.as_f64()).unwrap_or(0.0),
        lon: hit.get("longitude").and_then(|x| x.as_f64()).unwrap_or(0.0),
        label: hit
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or(place)
            .to_string(),
        country: hit
            .get("country_code")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// `mac_weather` — current conditions + today's outlook, spoken-ready.
pub async fn current(args: Value) -> Result<Value, String> {
    let place = args
        .get("place")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let client = http()?;

    let loc = if place.is_empty() {
        locate_by_ip(&client).await?
    } else {
        locate_by_name(&client, &place).await?
    };

    let fahrenheit = loc.country.eq_ignore_ascii_case("US");
    let unit = if fahrenheit { "fahrenheit" } else { "celsius" };
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}\
         &current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m\
         &daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code\
         &forecast_days=1&timezone=auto&temperature_unit={unit}",
        loc.lat, loc.lon
    );
    let v: Value = client
        .get(&url)
        .send()
        .await
        .map_err(net_err)?
        .json()
        .await
        .map_err(net_err)?;

    let cur = v.get("current").cloned().unwrap_or(json!({}));
    let daily = v.get("daily").cloned().unwrap_or(json!({}));
    let first = |key: &str| {
        daily
            .get(key)
            .and_then(|a| a.as_array())
            .and_then(|a| a.first())
            .cloned()
            .unwrap_or(Value::Null)
    };
    let code = cur
        .get("weather_code")
        .and_then(|x| x.as_i64())
        .unwrap_or(-1);
    let day_code = first("weather_code").as_i64().unwrap_or(code);
    let deg = if fahrenheit { "°F" } else { "°C" };

    Ok(json!({
        "location": loc.label,
        "unit": deg,
        "now": {
            "temperature": cur.get("temperature_2m").cloned().unwrap_or(Value::Null),
            "feels_like": cur.get("apparent_temperature").cloned().unwrap_or(Value::Null),
            "condition": wmo_words(code),
            "humidity_percent": cur.get("relative_humidity_2m").cloned().unwrap_or(Value::Null),
            "wind": cur.get("wind_speed_10m").cloned().unwrap_or(Value::Null),
        },
        "today": {
            "high": first("temperature_2m_max"),
            "low": first("temperature_2m_min"),
            "rain_chance_percent": first("precipitation_probability_max"),
            "condition": wmo_words(day_code),
        }
    }))
}
