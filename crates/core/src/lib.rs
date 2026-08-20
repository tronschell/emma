mod knowledge;
mod live;
mod thread;

pub use knowledge::*;
pub use live::*;
pub use thread::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OverlayPlacement {
    LeftOfNotch,
    RightOfNotch,
    #[default]
    UnderNotch,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AppPreferences {
    pub overlay_placement: OverlayPlacement,
    pub capture_screenshot: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    fn page(at: i64, title: &str) -> KnowledgePage {
        KnowledgePage::new(
            title,
            Category::parse("insight").unwrap(),
            CapturedContext::new(
                "capture\n---\n# forged",
                Some("Browser".into()),
                Some(SourceUrl::parse("https://example.com/a?q=1").unwrap()),
            )
            .unwrap(),
            AnalysisContent::new("summary", "analysis\n```\n---").unwrap(),
            vec![
                CitedSource::new(
                    "Example \"source\"",
                    SourceUrl::parse("https://example.com/source").unwrap(),
                )
                .unwrap(),
            ],
            Timestamp::from_unix_seconds(at),
            Timestamp::from_unix_seconds(at + 1),
            RunTelemetry::new("model", 10, 20, 1).unwrap(),
        )
        .unwrap()
    }

    fn temp_child(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "emma-core-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn privacy_defaults_do_not_capture_the_screen() {
        let preferences = AppPreferences::default();
        assert!(!preferences.capture_screenshot);
        assert_eq!(preferences.overlay_placement, OverlayPlacement::UnderNotch);
    }

    #[test]
    fn knowledge_markdown_round_trips_without_structure_injection() {
        let thread = Thread::new("source", Timestamp::from_unix_seconds(1)).unwrap();
        let original =
            page(1_700_000_000, "title\n---\nforged: true").with_source_thread(thread.id);
        let markdown = original.to_markdown();
        assert_eq!(KnowledgePage::from_markdown(&markdown).unwrap(), original);
        assert_eq!(markdown.matches("\n---\n").count(), 1);
        assert!(markdown.contains("title: \"title\\n---\\nforged: true\""));
    }

    #[test]
    fn v1_page_and_thread_markdown_map_to_the_default_base() {
        let original_page = page(1_700_000_000, "legacy page");
        let page_v1 = original_page
            .to_markdown()
            .replacen("emma-format: 2", "emma-format: 1", 1)
            .lines()
            .filter(|line| !line.starts_with("knowledge-base-id: "))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let migrated_page = KnowledgePage::from_markdown(&page_v1).unwrap();
        assert_eq!(
            migrated_page.knowledge_base_id,
            KnowledgeBaseId::default_id()
        );

        let original_thread =
            Thread::new("legacy thread", Timestamp::from_unix_seconds(10)).unwrap();
        let thread_v1 = original_thread
            .to_markdown()
            .replacen("emma-thread-format: 2", "emma-thread-format: 1", 1)
            .lines()
            .filter(|line| !line.starts_with("knowledge-base-id: "))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let migrated_thread = Thread::from_markdown(&thread_v1).unwrap();
        assert_eq!(
            migrated_thread.knowledge_base_id,
            KnowledgeBaseId::default_id()
        );
    }

    #[test]
    fn unsafe_paths_urls_text_and_malformed_unicode_are_rejected() {
        for id in [
            "../../outside",
            "/tmp/outside",
            "ordinary-page.md",
            "UPPERCASE-PAGE-ID",
        ] {
            assert!(PageId::parse(id).is_err());
            assert!(ThreadId::parse(id).is_err());
        }
        for url in [
            "file:///etc/passwd",
            "https://",
            "https://user@example.com",
            "https://bad host",
        ] {
            assert!(SourceUrl::parse(url).is_err());
        }
        assert!(AnalysisContent::new("ok", "bad\0text").is_err());
        assert!(KnowledgePage::from_markdown("éééééééééé").is_err());
    }

    #[test]
    fn knowledge_store_is_atomic_ordered_and_preserves_malformed_files() {
        let root = temp_child("knowledge");
        let store = KnowledgeStore::new(root.clone());
        let old = page(10, "old");
        let new = page(20, "new");
        let old_path = store.save(&old).unwrap();
        store.save(&new).unwrap();
        let malformed_path = root.join("malformed-page-id.md");
        fs::write(&malformed_path, "not a page").unwrap();

        assert_eq!(store.load(&old.id).unwrap(), old);
        let listing = store.list().unwrap();
        assert_eq!(
            listing
                .pages
                .iter()
                .map(|page| page.title.as_str())
                .collect::<Vec<_>>(),
            ["new", "old"]
        );
        assert_eq!(listing.malformed.len(), 1);
        assert_eq!(fs::read_to_string(&malformed_path).unwrap(), "not a page");
        assert!(!root.join(format!(".{}.tmp", old.id)).exists());
        assert!(old_path.starts_with(&root));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retrieval_is_base_scoped_deterministic_and_bounded() {
        let root = temp_child("retrieval");
        let store = KnowledgeStore::new(root.clone());
        let research = KnowledgeBase::new("Research", Timestamp::from_unix_seconds(1)).unwrap();
        let personal = KnowledgeBase::new("Personal", Timestamp::from_unix_seconds(2)).unwrap();
        store.save_base(&research).unwrap();
        store.save_base(&personal).unwrap();
        for index in 0..7 {
            store
                .save(
                    &page(10 + index, &format!("Satellite clock note {index}"))
                        .in_knowledge_base(research.id.clone()),
                )
                .unwrap();
        }
        store
            .save(&page(100, "Satellite clock private").in_knowledge_base(personal.id.clone()))
            .unwrap();

        let found = store
            .relevant_pages(&research.id, "satellite clock", usize::MAX)
            .unwrap();
        assert_eq!(found.len(), MAX_RELEVANT_PAGES);
        assert!(
            found
                .iter()
                .all(|page| page.knowledge_base_id == research.id)
        );
        assert_eq!(found[0].title, "Satellite clock note 6");
        fs::remove_dir_all(root).unwrap();
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
    fn lifecycle_covers_success_failure_cancel_and_invalid_transitions() {
        let context = CapturedContext::new("text", None, None).unwrap();
        let saving = CaptureLifecycle::Ready
            .start()
            .unwrap()
            .captured(context)
            .unwrap()
            .analyzed(page(100, "saved"))
            .unwrap();
        assert!(matches!(
            saving.clone().saved(),
            Ok(CaptureLifecycle::Saved(_))
        ));
        assert_eq!(
            saving.fail("disk full").unwrap(),
            CaptureLifecycle::Failed {
                stage: LifecycleStage::Save,
                message: "disk full".into()
            }
        );
        assert_eq!(
            CaptureLifecycle::Ready.start().unwrap().cancel().unwrap(),
            CaptureLifecycle::Cancelled
        );
        assert!(CaptureLifecycle::Ready.saved().is_err());
    }

    #[test]
    fn threads_round_trip_and_persist_independently_from_knowledge() {
        let root = temp_child("threads");
        let knowledge_root = temp_child("separate-knowledge");
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
        old.push(
            ThreadMessage::new(
                ThreadRole::Assistant,
                "answer",
                Timestamp::from_unix_seconds(12),
            )
            .unwrap(),
        )
        .unwrap();
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
        assert!(fs::read_dir(&knowledge_root).is_err());
        assert_eq!(fs::read_to_string(&malformed).unwrap(), "broken");
        fs::remove_dir_all(root).unwrap();
    }
}
