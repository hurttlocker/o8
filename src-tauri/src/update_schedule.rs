//! Wall-clock heartbeats run on native time, including with no window mounted.
const INTERVAL_MS: u64 = 30 * 60 * 1_000;
const WAKE_GAP_MS: u64 = 5_000;

#[derive(Default)]
pub struct UpdateSchedule {
    last_tick: Option<u64>,
    last_check: Option<u64>,
}

impl UpdateSchedule {
    pub fn completed(&mut self, now: u64) {
        self.last_tick = Some(now);
        self.last_check = Some(now);
    }
    pub fn due(&mut self, now: u64, requested: bool) -> bool {
        let woke = self
            .last_tick
            .is_some_and(|last| now.saturating_sub(last) > WAKE_GAP_MS || now < last);
        self.last_tick = Some(now);
        let due = requested
            || woke
            || self
                .last_check
                .map_or(true, |last| now.saturating_sub(last) >= INTERVAL_MS);
        if due {
            self.last_check = Some(now);
        }
        due
    }
}

#[cfg(test)]
#[path = "../../tests/native-update-schedule.rs"]
mod tests;
