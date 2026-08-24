use std::{
    error::Error,
    fmt,
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Serialize, Serializer};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Timestamp(i64);

impl Serialize for Timestamp {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_iso8601())
    }
}

impl Timestamp {
    pub fn now() -> Self {
        Self::from(SystemTime::now())
    }

    pub const fn from_unix_seconds(seconds: i64) -> Self {
        Self(seconds)
    }

    pub const fn unix_seconds(self) -> i64 {
        self.0
    }

    pub(crate) fn utc_components(self) -> (u32, u32, u32, u32, u32) {
        let days = self.0.div_euclid(86_400);
        let seconds = self.0.rem_euclid(86_400);
        let (_, month, day) = civil_from_days(days);
        let weekday = (days + 4).rem_euclid(7) as u32;
        (
            seconds as u32 / 3_600,
            seconds as u32 / 60 % 60,
            day,
            month,
            weekday,
        )
    }

    pub fn to_iso8601(self) -> String {
        let days = self.0.div_euclid(86_400);
        let seconds = self.0.rem_euclid(86_400);
        let (year, month, day) = civil_from_days(days);
        format!(
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
            seconds / 3_600,
            seconds / 60 % 60,
            seconds % 60
        )
    }
}

impl From<SystemTime> for Timestamp {
    fn from(value: SystemTime) -> Self {
        match value.duration_since(UNIX_EPOCH) {
            Ok(duration) => Self(i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)),
            Err(error) => {
                let duration = error.duration();
                let seconds = duration.as_secs() + u64::from(duration.subsec_nanos() != 0);
                Self(-i64::try_from(seconds).unwrap_or(i64::MAX))
            }
        }
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.to_iso8601())
    }
}

impl FromStr for Timestamp {
    type Err = ValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if !value.is_ascii()
            || value.len() != 20
            || &value[4..5] != "-"
            || &value[7..8] != "-"
            || &value[10..11] != "T"
            || &value[13..14] != ":"
            || &value[16..17] != ":"
            || &value[19..] != "Z"
        {
            return Err(ValidationError::new("timestamp is not ISO-8601 UTC"));
        }
        let number = |range: std::ops::Range<usize>| {
            value[range]
                .parse::<u32>()
                .map_err(|_| ValidationError::new("timestamp contains a non-number"))
        };
        let year = number(0..4)? as i32;
        let month = number(5..7)?;
        let day = number(8..10)?;
        let hour = number(11..13)?;
        let minute = number(14..16)?;
        let second = number(17..19)?;
        let max_day = days_in_month(year, month)
            .ok_or_else(|| ValidationError::new("timestamp month is invalid"))?;
        if day == 0 || day > max_day || hour > 23 || minute > 59 || second > 59 {
            return Err(ValidationError::new("timestamp component is out of range"));
        }
        Ok(Self(
            days_from_civil(year, month, day) * 86_400
                + i64::from(hour * 3_600 + minute * 60 + second),
        ))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationError(String);

impl ValidationError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for ValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl Error for ValidationError {}

pub(crate) fn validate_text(
    name: &str,
    value: &str,
    required: bool,
) -> Result<(), ValidationError> {
    if required && value.trim().is_empty() {
        return Err(ValidationError::new(format!("{name} cannot be empty")));
    }
    if value
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(ValidationError::new(format!(
            "{name} contains a control character"
        )));
    }
    Ok(())
}

pub(crate) fn quote(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character => output.push(character),
        }
    }
    output.push('"');
    output
}

pub(crate) fn unquote(value: &str) -> Result<String, ValidationError> {
    let value = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .ok_or_else(|| ValidationError::new("expected a quoted string"))?;
    let mut output = String::new();
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            output.push(character);
            continue;
        }
        output.push(match characters.next() {
            Some('"') => '"',
            Some('\\') => '\\',
            Some('n') => '\n',
            Some('r') => '\r',
            Some('t') => '\t',
            _ => return Err(ValidationError::new("invalid string escape")),
        });
    }
    Ok(output)
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year as i32, month as u32, day as u32)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = i64::from(year) - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year - 719_468
}

fn days_in_month(year: i32, month: u32) -> Option<u32> {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => Some(31),
        4 | 6 | 9 | 11 => Some(30),
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => Some(29),
        2 => Some(28),
        _ => None,
    }
}
