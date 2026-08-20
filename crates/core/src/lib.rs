mod knowledge;
mod live;
mod scheduled;
mod thread;

pub use knowledge::*;
pub use live::*;
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
            .replacen("emma-thread-format: 4", "emma-thread-format: 1", 1)
            .lines()
            .filter(|line| {
                !line.starts_with("knowledge-base-id: ")
                    && !line.starts_with("source-knowledge-base-count: ")
                    && !line.starts_with("source-0-id: ")
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let migrated_thread = Thread::from_markdown(&thread_v1).unwrap();
        assert_eq!(
            migrated_thread.knowledge_base_id,
            KnowledgeBaseId::default_id()
        );
        assert_eq!(
            migrated_thread.source_knowledge_base_ids,
            [KnowledgeBaseId::default_id()]
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

        let page = page(1_700_000_000, "bounded");
        let oversized_page = page.to_markdown().replace(
            "cited-source-count: 1",
            &format!("cited-source-count: {}", MAX_CITED_SOURCES + 1),
        );
        assert!(KnowledgePage::from_markdown(&oversized_page).is_err());
        let source = page.sources[0].clone();
        let mut page_for_save = page;
        page_for_save.sources = vec![source; MAX_CITED_SOURCES + 1];
        assert!(
            KnowledgeStore::new(temp_child("cited-source-limit"))
                .save(&page_for_save)
                .is_err()
        );

        let job = ScheduledJob::new(
            "bounded".into(),
            "0 9 * * 1".into(),
            "prompt".into(),
            vec![],
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
    fn base_categories_and_multi_source_threads_round_trip() {
        let mut base = KnowledgeBase::new("Research", Timestamp::from_unix_seconds(1)).unwrap();
        base.categories = vec![
            Category::parse("papers").unwrap(),
            Category::parse("reviews").unwrap(),
        ];
        assert_eq!(
            KnowledgeBase::from_markdown(&base.to_markdown()).unwrap(),
            base
        );
        let legacy = base
            .to_markdown()
            .replacen(
                "emma-knowledge-base-format: 2",
                "emma-knowledge-base-format: 1",
                1,
            )
            .lines()
            .filter(|line| !line.starts_with("category-count:") && !line.starts_with("category-"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        assert!(
            KnowledgeBase::from_markdown(&legacy)
                .unwrap()
                .categories
                .is_empty()
        );

        let mut thread = Thread::new("sources", Timestamp::from_unix_seconds(2)).unwrap();
        thread.select_knowledge_base(base.id.clone());
        thread.select_source_knowledge_bases(vec![KnowledgeBaseId::default_id(), base.id.clone()]);
        assert_eq!(
            Thread::from_markdown(&thread.to_markdown()).unwrap(),
            thread
        );
        assert_eq!(thread.source_knowledge_base_ids.len(), 2);
        assert_eq!(thread.source_knowledge_base_ids[0], base.id);
    }

    #[test]
    fn knowledge_base_category_limit_is_enforced_before_save() {
        let root = temp_child("base-category-limit");
        let store = KnowledgeStore::new(root.clone());
        let mut base = KnowledgeBase::new("Research", Timestamp::from_unix_seconds(1)).unwrap();
        base.categories = (0..MAX_KNOWLEDGE_BASE_CATEGORIES)
            .map(|index| Category::parse(format!("category-{index}")).unwrap())
            .collect();

        store.save_base(&base).unwrap();
        assert_eq!(
            store.load_base(&base.id).unwrap().categories.len(),
            MAX_KNOWLEDGE_BASE_CATEGORIES
        );

        base.categories
            .push(Category::parse("category-overflow").unwrap());
        assert!(store.save_base(&base).is_err());
        assert_eq!(
            store.load_base(&base.id).unwrap().categories.len(),
            MAX_KNOWLEDGE_BASE_CATEGORIES
        );
        fs::remove_dir_all(root).unwrap();
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
        let mut assistant = ThreadMessage::new(
            ThreadRole::Assistant,
            "answer",
            Timestamp::from_unix_seconds(12),
        )
        .unwrap();
        assistant.generation = Some(GenerationTelemetry::new(24, 500).unwrap());
        old.push(assistant).unwrap();
        let version_three = old
            .to_markdown()
            .replacen("emma-thread-format: 4", "emma-thread-format: 3", 1)
            .replace("\nGeneration: none\n\n", "\n")
            .replace(
                "\nGeneration: present\nOutput-Tokens: 24\nDuration-Milliseconds: 500\n\n",
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
        assert!(fs::read_dir(&knowledge_root).is_err());
        assert_eq!(fs::read_to_string(&malformed).unwrap(), "broken");
        fs::remove_dir_all(root).unwrap();
    }
}
