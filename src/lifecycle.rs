//! Note lifecycle: retention, a slowly decaying prior on how useful a note still is.

use chrono::{DateTime, Utc};

use crate::model::Note;

/// What retention depends on: a note's usage record, so a search
/// index can keep it without the note's text.
#[derive(Clone, Debug, PartialEq)]
pub struct Usage {
    pub pinned: bool,
    pub confidence: f64,
    pub updated_at: DateTime<Utc>,
    pub last_accessed_at: Option<DateTime<Utc>>,
    pub access_count: i64,
    pub positive_feedback: i64,
    pub negative_feedback: i64,
}

impl Usage {
    pub fn of(note: &Note) -> Self {
        Self {
            pinned: note.input.pinned,
            confidence: note.input.confidence,
            updated_at: note.updated_at,
            last_accessed_at: note.last_accessed_at,
            access_count: note.access_count,
            positive_feedback: note.positive_feedback,
            negative_feedback: note.negative_feedback,
        }
    }
}

/// Retention is separate from query PageRank and is recalculated from original
/// timestamps, never compounded on the previously stored retention score.
///
/// score = clamp(confidence × feedback × usage × 2^(-age_months*30/half_life_days)).
/// age_months counts complete 30-day periods since the latest edit or consumption.
/// feedback uses Beta(2,2) smoothing: clamp(2*(positive+2)/(positive+negative+4), .1, 1.5).
/// Usage contributes at most 15%, saturating with 20 consumed accesses. Search
/// previews should not be counted as consumption by the caller. Pinned notes have
/// retention 1, which protects their presence without asserting factual certainty.
pub fn retention(note: &Note, now: DateTime<Utc>, half_life_days: f64) -> f64 {
    retention_of(&Usage::of(note), now, half_life_days)
}

/// [`retention`] from a usage record alone.
pub fn retention_of(note: &Usage, now: DateTime<Utc>, half_life_days: f64) -> f64 {
    if note.pinned {
        return 1.0;
    }
    if !note.confidence.is_finite() {
        return 0.0;
    }
    let half_life_days = if half_life_days.is_finite() && half_life_days > 0.0 {
        half_life_days
    } else {
        90.0
    };
    let recent = note
        .last_accessed_at
        .unwrap_or(note.updated_at)
        .max(note.updated_at);
    let age_seconds = now.signed_duration_since(recent).num_seconds().max(0) as f64;
    let age_months = (age_seconds / (30.0 * 86_400.0)).floor();
    let positive = note.positive_feedback.max(0) as f64;
    let negative = note.negative_feedback.max(0) as f64;
    let feedback = (2.0 * (positive + 2.0) / (positive + negative + 4.0)).clamp(0.1, 1.5);
    let accesses = note.access_count.max(0) as f64;
    let usage = 1.0 + 0.15 * accesses / (accesses + 20.0);
    let decay = 2.0_f64.powf(-age_months * 30.0 / half_life_days);
    (note.confidence.clamp(0.0, 1.0) * feedback * usage * decay).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{note, now};
    use chrono::Duration;

    #[test]
    fn retention_is_monthly_usage_sensitive_and_feedback_bounded() {
        let mut old = note("old", "local");
        old.updated_at = now() - Duration::days(60);
        assert!((retention(&old, now(), 30.0) - 0.2).abs() < 1e-12);
        let mut recent = old.clone();
        recent.last_accessed_at = Some(now());
        assert_eq!(retention(&recent, now(), 30.0), 0.8);
        recent.positive_feedback = 20;
        assert!(retention(&recent, now(), 30.0) > 0.8);
        recent.negative_feedback = 100;
        assert!(retention(&recent, now(), 30.0) < 0.8);
        old.input.pinned = true;
        assert_eq!(retention(&old, now(), 30.0), 1.0);
        recent.positive_feedback = i64::MAX;
        recent.access_count = i64::MAX;
        assert!((0.0..=1.0).contains(&retention(&recent, now(), 30.0)));
    }

    #[test]
    fn retention_does_not_decay_before_first_month_or_compound_previous_score() {
        let mut a = note("a", "local");
        a.updated_at = now() - Duration::days(29);
        a.retention_score = 0.01;
        assert_eq!(retention(&a, now(), 30.0), 0.8);
        a.last_accessed_at = Some(now() + Duration::days(2));
        assert_eq!(retention(&a, now(), 30.0), 0.8);
    }
}
