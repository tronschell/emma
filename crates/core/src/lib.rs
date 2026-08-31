mod live;
mod record;
mod research;
mod scheduled;
mod thread;

pub use live::*;
pub use record::*;
pub use research::*;
pub use scheduled::*;
pub use thread::*;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    const STALE_FRONT_MATTER: &str = concat!(
        "---\n",
        "emma-thread-format: 11\n",
        "id: \"1700000000-1a2b-3c4d-0\"\n",
        "title: \"Kept thread\"\n",
        "parent-thread-id: \"\"\n",
        "kind: \"main\"\n",
        "scheduled-job-id: \"\"\n",
        "knowledge-base-id: \"default\"\n",
        "source-knowledge-base-count: 2\n",
        "source-0-id: \"default\"\n",
        "source-1-id: \"research\"\n",
        "a-key-no-version-of-emma-ever-wrote: \"whatever\"\n",
        "created-at: \"2023-11-14T22:13:20Z\"\n",
        "updated-at: \"2023-11-14T22:13:20Z\"\n",
        "archived-at: \"\"\n",
        "message-count: 1\n",
        "trace-count: 0\n",
        "---\n",
        "\n",
        "## Message 1\n",
        "\n",
        "Role: user\n",
        "\n",
        "Time: 2023-11-14T22:13:20Z\n",
        "\n",
        "Generation: none\n",
        "\n",
        "\"hello\"\n",
    );

    fn temp_child(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "emma-core-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn a_thread_file_with_front_matter_this_version_does_not_know_still_loads() {
        let thread = Thread::from_markdown(STALE_FRONT_MATTER).unwrap();
        assert_eq!(thread.title, "Kept thread");
        assert_eq!(thread.messages.len(), 1);
        assert_eq!(thread.messages[0].content, "hello");
        assert_eq!(
            thread.created_at,
            Timestamp::from_unix_seconds(1_700_000_000)
        );

        let rewritten = thread.to_markdown();
        assert!(!rewritten.contains("knowledge-base-id"));
        assert!(!rewritten.contains("source-0-id"));
        assert!(!rewritten.contains("a-key-no-version-of-emma-ever-wrote"));
        assert_eq!(Thread::from_markdown(&rewritten).unwrap(), thread);

        let root = temp_child("stale-front-matter");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(format!("{}.md", thread.id)), STALE_FRONT_MATTER).unwrap();
        let store = ThreadStore::new(root.clone());
        let listing = store.list().unwrap();
        assert!(listing.malformed.is_empty());
        assert_eq!(listing.threads.len(), 1);
        assert_eq!(store.load(&thread.id).unwrap(), thread);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_thread_edited_outside_the_host_is_reread_even_when_its_size_is_unchanged() {
        let root = temp_child("thread-cache");
        let store = ThreadStore::new(root.clone());
        let mut thread = Thread::new("aaaa", Timestamp::from_unix_seconds(10)).unwrap();
        let path = store.save(&thread).unwrap();
        assert_eq!(store.load(&thread.id).unwrap().title, "aaaa");
        assert_eq!(store.list().unwrap().threads[0].title, "aaaa");

        let stamped = fs::metadata(&path).unwrap().modified().unwrap();
        thread.title = "bbbb".into();
        fs::write(&path, thread.to_markdown()).unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(stamped + std::time::Duration::from_secs(1))
            .unwrap();

        assert_eq!(store.load(&thread.id).unwrap().title, "bbbb");
        assert_eq!(store.list().unwrap().threads[0].title, "bbbb");

        fs::remove_file(&path).unwrap();
        assert!(store.list().unwrap().threads.is_empty());
        assert!(store.load(&thread.id).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn traces_round_trip_are_bounded_and_a_pre_trace_thread_still_loads() {
        let mut thread = Thread::new("traced", Timestamp::from_unix_seconds(1)).unwrap();
        thread.record_trace(
            ThreadTrace::new(
                Timestamp::from_unix_seconds(2),
                "trace v1 spans=1\n#1 bash 1.20s failed\n   in {\"command\":\"npm ci\"}",
            )
            .unwrap(),
        );
        let markdown = thread.to_markdown();
        assert_eq!(markdown.matches("\n---\n").count(), 1);
        assert_eq!(Thread::from_markdown(&markdown).unwrap(), thread);

        let lines = MAX_TRACE_BYTES / 8;
        let runaway = (0..lines)
            .map(|index| format!("#{index} bash 1ms ok"))
            .collect::<Vec<_>>()
            .join("\n");
        let clamped = ThreadTrace::new(Timestamp::from_unix_seconds(3), &runaway).unwrap();
        assert!(clamped.text.len() <= MAX_TRACE_BYTES);
        assert!(clamped.text.starts_with("#0 bash"));
        assert!(
            clamped
                .text
                .ends_with(&format!("#{} bash 1ms ok", lines - 1))
        );
        assert!(clamped.text.contains("lines elided"));

        let unbroken = "A".repeat(MAX_TRACE_BYTES * 4);
        let kept = ThreadTrace::new(Timestamp::from_unix_seconds(3), &unbroken).unwrap();
        assert!(kept.text.len() <= MAX_TRACE_BYTES);
        assert!(kept.text.starts_with("AAAA"));
        assert!(kept.text.ends_with("AAAA"));
        assert!(kept.text.contains("bytes elided"));

        let headed = format!("{}\ntail line", "B".repeat(MAX_TRACE_BYTES * 4));
        let kept = ThreadTrace::new(Timestamp::from_unix_seconds(3), &headed).unwrap();
        assert!(kept.text.starts_with("BBBB"));
        assert!(kept.text.ends_with("tail line"));

        for index in 0..MAX_THREAD_TRACES + 4 {
            thread.record_trace(
                ThreadTrace::new(Timestamp::from_unix_seconds(4), &format!("run {index}")).unwrap(),
            );
        }
        assert_eq!(thread.traces.len(), MAX_THREAD_TRACES);
        assert_eq!(thread.traces[MAX_THREAD_TRACES - 1].text, "run 67");

        let older = Thread::new("older", Timestamp::from_unix_seconds(5)).unwrap();
        let legacy = older
            .to_markdown()
            .replacen("emma-thread-format: 15", "emma-thread-format: 7", 1)
            .lines()
            .filter(|line| {
                !line.starts_with("trace-count:")
                    && !line.starts_with("kind: ")
                    && !line.starts_with("scheduled-job-id: ")
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(Thread::from_markdown(&legacy).unwrap(), older);
    }

    #[test]
    fn an_owned_thread_round_trips_its_kind_and_refuses_to_be_its_own_parent() {
        let parent = Thread::new("root", Timestamp::from_unix_seconds(1)).unwrap();
        let mut child = Thread::new("subagent", Timestamp::from_unix_seconds(2)).unwrap();
        child.parent_thread_id = Some(parent.id.clone());
        child.kind = ThreadKind::Subagent;
        let markdown = child.to_markdown();
        assert_eq!(Thread::from_markdown(&markdown).unwrap(), child);

        let mut sub = child.clone();
        sub.kind = ThreadKind::Main;
        assert_eq!(Thread::from_markdown(&sub.to_markdown()).unwrap(), sub);

        let legacy = child
            .to_markdown()
            .replacen("emma-thread-format: 15", "emma-thread-format: 8", 1)
            .replace("kind: \"subagent\"\n", "")
            .replace("scheduled-job-id: \"\"\n", "");
        assert_eq!(Thread::from_markdown(&legacy).unwrap(), child);

        let orphan = child.to_markdown().replace(
            &format!("parent-thread-id: \"{}\"", parent.id),
            "parent-thread-id: \"\"",
        );
        assert!(
            Thread::from_markdown(&orphan)
                .unwrap_err()
                .to_string()
                .contains("must have a parent")
        );

        let root = Thread::new("root", Timestamp::from_unix_seconds(3)).unwrap();
        assert_eq!(
            Thread::from_markdown(&root.to_markdown())
                .unwrap()
                .parent_thread_id,
            None
        );
        let older = root
            .to_markdown()
            .replacen("emma-thread-format: 15", "emma-thread-format: 5", 1)
            .lines()
            .filter(|line| {
                !line.starts_with("parent-thread-id:")
                    && !line.starts_with("trace-count:")
                    && !line.starts_with("kind: ")
                    && !line.starts_with("scheduled-job-id: ")
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(Thread::from_markdown(&older).unwrap(), root);

        let looped = child.to_markdown().replace(
            &format!("parent-thread-id: \"{}\"", parent.id),
            &format!("parent-thread-id: \"{}\"", child.id),
        );
        assert!(
            Thread::from_markdown(&looped)
                .unwrap_err()
                .to_string()
                .contains("its own parent")
        );
    }

    #[test]
    fn durable_store_collection_limits_reject_oversized_counts() {
        let thread = Thread::new("bounded", Timestamp::from_unix_seconds(1)).unwrap();
        let oversized_thread = thread.to_markdown().replace(
            "message-count: 0",
            &format!("message-count: {}", MAX_THREAD_MESSAGES + 1),
        );
        assert!(Thread::from_markdown(&oversized_thread).is_err());
        let message =
            ThreadMessage::new(ThreadRole::User, "message", Timestamp::from_unix_seconds(1))
                .unwrap();
        let mut thread_for_save = thread;
        thread_for_save.messages = vec![message; MAX_THREAD_MESSAGES + 1];
        assert!(
            ThreadStore::new(temp_child("thread-message-limit"))
                .save(&thread_for_save)
                .is_err()
        );

        let job = ScheduledJob::new(
            "bounded".into(),
            "0 9 * * 1".into(),
            "prompt".into(),
            String::new(),
            vec![],
            "ask".into(),
            Timestamp::from_unix_seconds(1_700_000_000),
        )
        .unwrap();
        let oversized_job = job.to_markdown().replace(
            "source-domain-count: 0",
            &format!("source-domain-count: {}", MAX_SCHEDULED_SOURCE_DOMAINS + 1),
        );
        assert!(ScheduledJob::from_markdown(&oversized_job).is_err());
        let mut job_for_save = job;
        job_for_save.source_domains = vec!["example.com".into(); MAX_SCHEDULED_SOURCE_DOMAINS + 1];
        assert!(
            ScheduledJobStore::new(temp_child("source-domain-limit"))
                .save(&job_for_save)
                .is_err()
        );
    }

    #[test]
    fn unsafe_paths_text_and_malformed_unicode_are_rejected() {
        for id in [
            "../../outside",
            "/tmp/outside",
            "ordinary-thread.md",
            "UPPERCASE-THREAD-ID",
        ] {
            assert!(ThreadId::parse(id).is_err());
        }
        assert!(
            ThreadMessage::new(
                ThreadRole::User,
                "bad\0text",
                Timestamp::from_unix_seconds(1)
            )
            .is_err()
        );
        assert!(Thread::from_markdown("éééééééééé").is_err());
    }

    #[test]
    fn timestamps_cover_epoch_leap_day_and_day_boundaries() {
        for (seconds, expected) in [
            (0, "1970-01-01T00:00:00Z"),
            (-1, "1969-12-31T23:59:59Z"),
            (951_782_400, "2000-02-29T00:00:00Z"),
            (4_102_444_799, "2099-12-31T23:59:59Z"),
        ] {
            let timestamp = Timestamp::from_unix_seconds(seconds);
            assert_eq!(timestamp.to_iso8601(), expected);
            assert_eq!(expected.parse::<Timestamp>().unwrap(), timestamp);
        }
        assert!("1900-02-29T00:00:00Z".parse::<Timestamp>().is_err());
        assert_eq!(
            Timestamp::from(std::time::UNIX_EPOCH - std::time::Duration::from_millis(1)),
            Timestamp::from_unix_seconds(-1)
        );
    }

    #[test]
    fn threads_round_trip_and_keep_malformed_files_where_they_are() {
        let root = temp_child("threads");
        let store = ThreadStore::new(root.clone());
        let mut old = Thread::new("unsafe\n---\ntitle", Timestamp::from_unix_seconds(10)).unwrap();
        old.push(
            ThreadMessage::new(
                ThreadRole::User,
                "hello\n---\nforged",
                Timestamp::from_unix_seconds(11),
            )
            .unwrap(),
        )
        .unwrap();
        let mut assistant = ThreadMessage::new(
            ThreadRole::Assistant,
            "answer",
            Timestamp::from_unix_seconds(12),
        )
        .unwrap();
        assistant.generation = Some(
            GenerationTelemetry::new(24, 500)
                .unwrap()
                .with_provider_usage(Some(12), Some(24), Some(3), Some(456))
                .unwrap(),
        );
        old.push(assistant).unwrap();
        let version_thirteen = old
            .to_markdown()
            .replacen("emma-thread-format: 15", "emma-thread-format: 13", 1)
            .lines()
            .filter(|line| !line.starts_with("Cache-") && !line.starts_with("Cost-Micro-Usd:"))
            .collect::<Vec<_>>()
            .join("\n");
        let legacy_generation = Thread::from_markdown(&version_thirteen).unwrap().messages[1]
            .generation
            .clone()
            .unwrap();
        assert_eq!(legacy_generation.cache_read_tokens, None);
        assert_eq!(legacy_generation.cache_input_tokens, None);
        assert_eq!(legacy_generation.cache_write_tokens, None);
        assert_eq!(legacy_generation.cost_micro_usd, None);
        let version_three = old
            .to_markdown()
            .replacen("emma-thread-format: 15", "emma-thread-format: 3", 1)
            .replace("archived-at: \"\"\n", "")
            .replace("parent-thread-id: \"\"\n", "")
            .replace("trace-count: 0\n", "")
            .replace("kind: \"main\"\n", "").replace("scheduled-job-id: \"\"\n", "")
            .replace("\nGeneration: none\n\n", "\n")
            .replace(
                "\nGeneration: present\nOutput-Tokens: 24\nDuration-Milliseconds: 500\nInput-Tokens: 0\nCache-Read-Tokens: \"12\"\nCache-Input-Tokens: \"24\"\nCache-Write-Tokens: \"3\"\nCost-Micro-Usd: \"456\"\nModel: \"\"\n\n",
                "\n",
            );
        assert!(
            Thread::from_markdown(&version_three)
                .unwrap()
                .messages
                .iter()
                .all(|message| message.generation.is_none())
        );
        let new = Thread::new("new", Timestamp::from_unix_seconds(20)).unwrap();
        assert_eq!(Thread::from_markdown(&old.to_markdown()).unwrap(), old);
        store.save(&old).unwrap();
        store.save(&new).unwrap();
        let malformed = root.join("malformed-thread-id.md");
        fs::write(&malformed, "broken").unwrap();

        assert_eq!(store.load(&old.id).unwrap(), old);
        let listing = store.list().unwrap();
        assert_eq!(listing.threads.len(), 2);
        assert_eq!(listing.threads[0].title, "new");
        assert_eq!(listing.malformed.len(), 1);
        assert_eq!(fs::read_to_string(&malformed).unwrap(), "broken");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_goal_survives_the_round_trip_and_an_older_thread_has_none() {
        let mut thread = Thread::new("Ship it", Timestamp::from_unix_seconds(10)).unwrap();
        assert!(thread.goal.is_none());
        thread
            .set_goal(
                "  Make the flaky suite green  ",
                50_000,
                Timestamp::from_unix_seconds(11),
            )
            .unwrap();
        thread.note_goal_turn(1_200, 8_400, Timestamp::from_unix_seconds(12));
        let goal = thread.goal.clone().unwrap();
        assert_eq!(goal.objective, "Make the flaky suite green");
        assert_eq!(goal.status, GoalStatus::Active);
        assert_eq!(goal.tokens_used, 1_200);
        assert_eq!(goal.time_used_seconds, 8);
        assert_eq!(goal.turns, 1);
        assert_eq!(goal.tokens_left(), 48_800);

        let markdown = thread.to_markdown();
        assert_eq!(Thread::from_markdown(&markdown).unwrap(), thread);
        assert!(Thread::from_markdown(&markdown).unwrap().goal.is_some());

        let older = markdown
            .replacen("emma-thread-format: 15", "emma-thread-format: 12", 1)
            .lines()
            .filter(|line| !line.starts_with("goal-"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            Thread::from_markdown(&format!("{older}\n"))
                .unwrap()
                .goal
                .is_none()
        );
    }

    #[test]
    fn a_goal_is_complete_only_with_evidence() {
        let mut thread = Thread::new("Ship it", Timestamp::from_unix_seconds(10)).unwrap();
        assert!(
            thread
                .update_goal(
                    GoalStatus::Complete,
                    "all green",
                    "",
                    Timestamp::from_unix_seconds(11)
                )
                .is_err()
        );
        thread
            .set_goal("Make the suite green", 0, Timestamp::from_unix_seconds(11))
            .unwrap();
        assert_eq!(
            thread.goal.as_ref().unwrap().token_budget,
            DEFAULT_GOAL_TOKEN_BUDGET
        );
        assert!(
            thread
                .update_goal(
                    GoalStatus::Complete,
                    "   ",
                    "",
                    Timestamp::from_unix_seconds(12)
                )
                .is_err()
        );
        assert_eq!(thread.goal.as_ref().unwrap().status, GoalStatus::Active);
        thread
            .update_goal(
                GoalStatus::Complete,
                "cargo test --workspace: 214 passed, 0 failed",
                "",
                Timestamp::from_unix_seconds(13),
            )
            .unwrap();
        assert_eq!(thread.goal.as_ref().unwrap().status, GoalStatus::Complete);
        assert!(
            thread
                .update_goal(GoalStatus::Paused, "", "", Timestamp::from_unix_seconds(14))
                .is_err()
        );
        assert!(thread.clear_goal());
        assert!(!thread.clear_goal());
    }

    #[test]
    fn blocked_needs_the_same_blocker_three_turns_running() {
        let mut thread = Thread::new("Ship it", Timestamp::from_unix_seconds(10)).unwrap();
        thread
            .set_goal("Deploy the service", 0, Timestamp::from_unix_seconds(11))
            .unwrap();
        let at = Timestamp::from_unix_seconds(12);
        for turn in 0..2 {
            thread
                .update_goal(GoalStatus::Blocked, "", "no deploy credentials", at)
                .unwrap();
            thread
                .update_goal(GoalStatus::Blocked, "", "no deploy credentials", at)
                .unwrap();
            let goal = thread.goal.as_ref().unwrap();
            assert_eq!(goal.status, GoalStatus::Active);
            assert_eq!(goal.blocked_streak, turn + 1);
            thread.note_goal_turn(10, 1_000, at);
        }
        thread
            .update_goal(GoalStatus::Blocked, "", "No Deploy Credentials", at)
            .unwrap();
        assert_eq!(thread.goal.as_ref().unwrap().status, GoalStatus::Blocked);
        assert_eq!(thread.goal.as_ref().unwrap().blocked_streak, 3);

        let mut other = Thread::new("Ship it", Timestamp::from_unix_seconds(10)).unwrap();
        other
            .set_goal("Deploy", 0, Timestamp::from_unix_seconds(11))
            .unwrap();
        other
            .update_goal(GoalStatus::Blocked, "", "no credentials", at)
            .unwrap();
        other.note_goal_turn(10, 1_000, at);
        other
            .update_goal(GoalStatus::Blocked, "", "the API is down", at)
            .unwrap();
        assert_eq!(other.goal.as_ref().unwrap().blocked_streak, 1);
        assert_eq!(other.goal.as_ref().unwrap().status, GoalStatus::Active);
    }

    #[test]
    fn a_goal_stops_at_its_budget_until_it_is_extended() {
        let mut thread = Thread::new("Ship it", Timestamp::from_unix_seconds(10)).unwrap();
        thread
            .set_goal("Port the callers", 1_000, Timestamp::from_unix_seconds(11))
            .unwrap();
        thread.note_goal_turn(600, 1_000, Timestamp::from_unix_seconds(12));
        assert_eq!(thread.goal.as_ref().unwrap().status, GoalStatus::Active);
        thread.note_goal_turn(600, 1_000, Timestamp::from_unix_seconds(13));
        let goal = thread.goal.as_ref().unwrap();
        assert_eq!(goal.status, GoalStatus::BudgetLimited);
        assert_eq!(goal.tokens_used, 1_200);
        assert_eq!(goal.tokens_left(), 0);

        thread.note_goal_turn(600, 1_000, Timestamp::from_unix_seconds(14));
        let goal = thread.goal.as_ref().unwrap();
        assert_eq!(goal.turns, 3);
        assert_eq!(goal.tokens_used, 1_800);

        thread
            .extend_goal(1_000, Timestamp::from_unix_seconds(15))
            .unwrap();
        let goal = thread.goal.as_ref().unwrap();
        assert_eq!(goal.status, GoalStatus::Active);
        assert_eq!(goal.token_budget, 2_000);

        assert_eq!(goal.turns, 0);

        thread
            .update_goal(GoalStatus::Paused, "", "", Timestamp::from_unix_seconds(16))
            .unwrap();
        thread.note_goal_turn(600, 1_000, Timestamp::from_unix_seconds(17));
        let goal = thread.goal.as_ref().unwrap();
        assert_eq!(goal.tokens_used, 1_800);
        assert_eq!(goal.turns, 0);
    }

    #[test]
    fn a_second_set_cannot_buy_a_goal_a_fresh_allowance() {
        let mut thread = Thread::new("Ship it", Timestamp::from_unix_seconds(10)).unwrap();
        thread
            .set_goal("Port the callers", 1_000, Timestamp::from_unix_seconds(11))
            .unwrap();
        thread.note_goal_turn(1_200, 1_000, Timestamp::from_unix_seconds(12));
        assert_eq!(
            thread.goal.as_ref().unwrap().status,
            GoalStatus::BudgetLimited
        );

        let goal = thread
            .set_goal(
                "Port the callers",
                200_000,
                Timestamp::from_unix_seconds(13),
            )
            .unwrap();
        assert_eq!(goal.tokens_used, 1_200);
        assert_eq!(goal.turns, 1);
        assert_eq!(goal.created_at, Timestamp::from_unix_seconds(11));

        thread
            .update_goal(
                GoalStatus::Complete,
                "cargo test passed",
                "",
                Timestamp::from_unix_seconds(14),
            )
            .unwrap();
        let goal = thread
            .set_goal(
                "Something else entirely",
                5_000,
                Timestamp::from_unix_seconds(15),
            )
            .unwrap();
        assert_eq!(goal.tokens_used, 0);
        assert_eq!(goal.token_budget, 5_000);
    }

    #[test]
    fn a_settled_goal_keeps_its_verdict_and_a_stopped_one_keeps_its_reason() {
        let mut thread = Thread::new("Ship it", Timestamp::from_unix_seconds(10)).unwrap();
        thread
            .set_goal("Port the callers", 1_000, Timestamp::from_unix_seconds(11))
            .unwrap();
        thread
            .update_goal(
                GoalStatus::UsageLimited,
                "",
                "429 from the provider",
                Timestamp::from_unix_seconds(12),
            )
            .unwrap();
        assert_eq!(
            thread.goal.as_ref().unwrap().blocked_reason,
            "429 from the provider"
        );

        thread
            .update_goal(
                GoalStatus::Complete,
                "cargo test passed",
                "",
                Timestamp::from_unix_seconds(13),
            )
            .unwrap();
        assert!(
            thread
                .update_goal(GoalStatus::Active, "", "", Timestamp::from_unix_seconds(14))
                .is_err()
        );
        assert_eq!(thread.goal.as_ref().unwrap().status, GoalStatus::Complete);
    }

    #[test]
    fn a_goal_stops_at_the_turn_ceiling_and_a_grant_hands_it_new_turns() {
        let mut thread = Thread::new("Ship it", Timestamp::from_unix_seconds(10)).unwrap();
        thread
            .set_goal(
                "Port the callers",
                10_000_000,
                Timestamp::from_unix_seconds(11),
            )
            .unwrap();
        for turn in 0..MAX_GOAL_TURNS {
            thread.note_goal_turn(1, 1_000, Timestamp::from_unix_seconds(12 + turn as i64));
        }
        let goal = thread.goal.as_ref().unwrap();
        assert_eq!(goal.turns, MAX_GOAL_TURNS);
        assert_eq!(goal.status, GoalStatus::BudgetLimited);
        assert!(goal.tokens_left() > 0);

        thread
            .extend_goal(0, Timestamp::from_unix_seconds(200))
            .unwrap();
        let goal = thread.goal.as_ref().unwrap();
        assert_eq!(goal.status, GoalStatus::Active);
        assert_eq!(goal.turns, 0);
        assert_eq!(goal.tokens_used, MAX_GOAL_TURNS);
    }
}
