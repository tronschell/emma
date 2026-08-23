mod knowledge;
mod live;
mod research;
mod scheduled;
mod thread;

pub use knowledge::*;
pub use live::*;
pub use research::*;
pub use scheduled::*;
pub use thread::*;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
        // A trace is one quoted line, so nothing in it can forge a second frame.
        assert_eq!(markdown.matches("\n---\n").count(), 1);
        assert_eq!(Thread::from_markdown(&markdown).unwrap(), thread);

        // A runaway turn loses the middle of its trace, never the whole turn.
        let runaway = (0..4_096)
            .map(|index| format!("#{index} bash 1ms ok"))
            .collect::<Vec<_>>()
            .join("\n");
        let clamped = ThreadTrace::new(Timestamp::from_unix_seconds(3), &runaway).unwrap();
        assert!(clamped.text.len() <= MAX_TRACE_BYTES);
        assert!(clamped.text.starts_with("#0 bash"));
        assert!(clamped.text.ends_with("#4095 bash 1ms ok"));
        assert!(clamped.text.contains("lines elided"));

        // And the thread keeps only the most recent runs.
        for index in 0..MAX_THREAD_TRACES + 4 {
            thread.record_trace(
                ThreadTrace::new(Timestamp::from_unix_seconds(4), &format!("run {index}")).unwrap(),
            );
        }
        assert_eq!(thread.traces.len(), MAX_THREAD_TRACES);
        assert_eq!(thread.traces[MAX_THREAD_TRACES - 1].text, "run 67");

        // A file written before the bump has no trace count and still loads.
        let older = Thread::new("older", Timestamp::from_unix_seconds(5)).unwrap();
        let legacy = older
            .to_markdown()
            .replacen("emma-thread-format: 11", "emma-thread-format: 7", 1)
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

        // Same parent, different kind: a sub thread is a main agent of its own.
        let mut sub = child.clone();
        sub.kind = ThreadKind::Main;
        assert_eq!(Thread::from_markdown(&sub.to_markdown()).unwrap(), sub);

        // Every owned thread written before the bump was a subagent's transcript.
        let legacy = child
            .to_markdown()
            .replacen("emma-thread-format: 11", "emma-thread-format: 8", 1)
            .replace("kind: \"subagent\"\n", "")
            .replace("scheduled-job-id: \"\"\n", "");
        assert_eq!(Thread::from_markdown(&legacy).unwrap(), child);

        // A subagent with nothing to belong to is not a shape that exists.
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

        // A root stays parentless, and a file written before the bump still loads.
        let root = Thread::new("root", Timestamp::from_unix_seconds(3)).unwrap();
        assert_eq!(
            Thread::from_markdown(&root.to_markdown())
                .unwrap()
                .parent_thread_id,
            None
        );
        let older = root
            .to_markdown()
            .replacen("emma-thread-format: 11", "emma-thread-format: 5", 1)
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
    fn artifact_blocks_round_trip_in_order_and_keep_unknown_fallbacks() {
        let source = ArtifactSource::new(
            Some("thread-123456789012".into()),
            Some("https://example.com/source".into()),
        )
        .unwrap();
        let page = page(1_700_000_000, "artifact page")
            .with_artifacts(vec![
                ArtifactBlock::new(
                    "summary",
                    "rich-text",
                    1,
                    source.clone(),
                    json!({"markdown": "A summary"}),
                    "A summary",
                )
                .unwrap(),
                ArtifactBlock::new(
                    "plugin-view",
                    "plugin.example/view",
                    7,
                    source,
                    json!({"value": [1, 2, 3]}),
                    "Unsupported plugin view; showing its portable fallback.",
                )
                .unwrap(),
            ])
            .unwrap();
        let markdown = page.to_markdown();
        let restored = KnowledgePage::from_markdown(&markdown).unwrap();
        assert_eq!(restored, page);
        assert_eq!(restored.artifacts[1].block_type, "plugin.example/view");
        assert!(markdown.contains("Unsupported plugin view"));
    }

    #[test]
    fn artifact_limits_are_enforced_before_persistence() {
        assert!(
            ArtifactBlock::new(
                "too-large",
                "rich-text",
                1,
                ArtifactSource::default(),
                json!({"markdown": "x".repeat(MAX_ARTIFACT_PAYLOAD_BYTES)}),
                "fallback",
            )
            .is_err()
        );
        let blocks = (0..=MAX_ARTIFACT_BLOCKS)
            .map(|index| {
                ArtifactBlock::new(
                    format!("block-{index}"),
                    "list",
                    1,
                    ArtifactSource::default(),
                    json!({"items": [format!("Item {index}")]}),
                    "- item",
                )
                .unwrap()
            })
            .collect();
        let mut bounded = page(1_700_000_000, "bounded");
        assert!(bounded.replace_artifacts(blocks).is_err());
    }

    #[test]
    fn v1_page_and_thread_markdown_map_to_the_default_base() {
        let original_page = page(1_700_000_000, "legacy page");
        let page_v2 = original_page
            .to_markdown()
            .replacen("emma-format: 4", "emma-format: 2", 1)
            .lines()
            .take_while(|line| *line != "## Artifact document")
            .filter(|line| {
                !line.starts_with("artifact-") && !line.starts_with("conversation-thread-id: ")
            })
            .collect::<Vec<_>>()
            .join("\n")
            .trim_end()
            .to_owned()
            + "\n";
        let page_v1 = page_v2
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
            .replacen("emma-thread-format: 11", "emma-thread-format: 1", 1)
            .lines()
            .filter(|line| {
                !line.starts_with("archived-at: ")
                    && !line.starts_with("parent-thread-id: ")
                    && !line.starts_with("knowledge-base-id: ")
                    && !line.starts_with("source-knowledge-base-count: ")
                    && !line.starts_with("source-0-id: ")
                    && !line.starts_with("trace-count: ")
                    && !line.starts_with("kind: ")
                    && !line.starts_with("scheduled-job-id: ")
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
    fn saving_mirrors_the_page_as_plain_markdown_anyone_can_read() {
        let root = temp_child("knowledge-export");
        let export = temp_child("knowledge-export-plain");
        let store = KnowledgeStore::new(root.clone()).with_export(export.clone());
        let mut saved = page(10, "Satellite clocks: drift & repair");
        store.save(&saved).unwrap();

        let named = export.join(format!("satellite-clocks-drift-repair--{}.md", saved.id));
        let written = fs::read_to_string(&named).unwrap();
        assert!(written.starts_with("---\ntitle: \"Satellite clocks: drift & repair\"\n"));
        assert!(written.contains("source: \"https://example.com/a?q=1\"\n"));
        assert!(written.contains("\n---\n\n# Satellite clocks: drift & repair\n\n"));
        // The document itself, in its portable form, not Emma's escaped storage.
        assert!(written.contains("\nanalysis\n"));

        // Retitling renames the copy instead of leaving a stale one behind.
        saved.title = "Satellite clocks".into();
        store.save(&saved).unwrap();
        assert!(!named.exists());
        let renamed = export.join(format!("satellite-clocks--{}.md", saved.id));
        assert!(renamed.exists());

        // The mirror is derived: an unwritable export folder never fails a save.
        let store = KnowledgeStore::new(root.clone()).with_export(renamed);
        assert!(store.save(&page(20, "still saved")).is_ok());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(export).unwrap();
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
            .replacen("emma-thread-format: 11", "emma-thread-format: 3", 1)
            .replace("archived-at: \"\"\n", "")
            .replace("parent-thread-id: \"\"\n", "")
            .replace("trace-count: 0\n", "")
            .replace("kind: \"main\"\n", "").replace("scheduled-job-id: \"\"\n", "")
            .replace("\nGeneration: none\n\n", "\n")
            .replace(
                "\nGeneration: present\nOutput-Tokens: 24\nDuration-Milliseconds: 500\nInput-Tokens: 0\nModel: \"\"\n\n",
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
