import { useEffect, useState } from "react";
import { pullRequestBadge, type GitSnapshot } from "../shared/git";
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";

export function useThreadGit(folderIds: string): Record<string, GitSnapshot | null> {
  const [repos, setRepos] = useState<Record<string, GitSnapshot | null>>({});
  useEffect(() => {
    const ids = JSON.parse(folderIds) as string[];
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      const entries = await Promise.all(ids.map(async (id) => [id, await window.emma.gitStatus(id).catch(() => null)] as const));
      if (active) setRepos(Object.fromEntries(entries));
      loading = false;
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    const listener = window.emma.onChanged(() => void load());
    window.addEventListener("focus", load);
    return () => { active = false; clearInterval(timer); window.emma.offChanged(listener); window.removeEventListener("focus", load); };
  }, [folderIds]);
  return repos;
}

export function ThreadGitStatus({ snapshot }: { snapshot?: GitSnapshot | null }) {
  if (!snapshot?.pullRequest) return null;
  const badge = pullRequestBadge(snapshot.pullRequest);
  const label = `${snapshot.branch} · ${badge.label}`;
  const Icon = badge.state === "merged" ? GitMerge : badge.state === "closed" ? GitPullRequestClosed : badge.state === "draft" ? GitPullRequestDraft : GitPullRequest;
  return <span className={`thread-pr ${badge.state}`} role="img" aria-label={label} title={label}><Icon size={14} strokeWidth={1.6} aria-hidden="true" /></span>;
}
