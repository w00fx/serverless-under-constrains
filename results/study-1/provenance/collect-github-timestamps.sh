#!/bin/bash
# Collects GitHub's server-side records for the Study 1 oracle commits up to 694d4c9, the source
# commit of the first cloud evidence (transport probe 4f4a29c7), into github-server-timestamps.json.
# Commit dates in git are set by the committer's machine; GitHub's push activity, events, Actions
# runs, check runs and commit statuses carry GitHub's own timestamps. Run from the repository root:
#   bash results/study-1/provenance/collect-github-timestamps.sh > results/study-1/provenance/github-server-timestamps.json
set -euo pipefail
REPO=w00fx/serverless-under-constrains
PATHS=(study-1/src/trial-oracle study-1/src/evidence-ingestion study-1/src/attempt-lifecycle study-1/test/golden study-1/tools/golden study-1/specs)
PROBE_MANIFEST=public/study-1-evidence/transport-probes/4f4a29c7-a8ee-4d30-ac2a-5cc5be9f2ce5/admission/execution-manifest.json
# The public copy is one archive; extract the probe manifest in place when it is not extracted yet.
[ -f "$PROBE_MANIFEST" ] || tar -xzf public/study-1-evidence/study-1-evidence.tar.gz -C public/study-1-evidence \
  "${PROBE_MANIFEST#public/study-1-evidence/}"

collected_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
activity=$(gh api --paginate "repos/$REPO/activity?per_page=100" | jq -s 'add | map({id, timestamp, activity_type, ref, before, after, actor: .actor.login})')
per_commit='[]'
for sha in $(git log --format='%H' 694d4c9 -- "${PATHS[@]}"); do
  runs=$(gh api "repos/$REPO/actions/runs?head_sha=$sha&per_page=100")
  checks=$(gh api "repos/$REPO/commits/$sha/check-runs?per_page=100")
  status=$(gh api "repos/$REPO/commits/$sha/status")
  # The first push whose new head contains the commit: the earliest time GitHub could have seen it.
  first_push=null
  for push in $(jq -r 'sort_by(.timestamp)[] | @base64' <<<"$activity"); do
    after=$(base64 --decode <<<"$push" | jq -r .after)
    if git merge-base --is-ancestor "$sha" "$after" 2>/dev/null; then
      first_push=$(base64 --decode <<<"$push" | jq -c '{id, timestamp, ref, after}')
      break
    fi
  done
  per_commit=$(jq -c --arg sha "$sha" --arg subject "$(git log -1 --format=%s "$sha")" \
    --arg committed "$(git log -1 --format=%cI "$sha")" --argjson first_push "$first_push" \
    --argjson runs "$runs" --argjson checks "$checks" --argjson status "$status" \
    '. + [{sha: $sha, subject: $subject, committer_date_set_by_committer: $committed, first_push_containing_it: $first_push,
           actions_runs: [$runs.workflow_runs[] | {id, event, head_branch, created_at, run_started_at}],
           check_runs: [$checks.check_runs[] | {id, name, app: .app.slug, started_at, completed_at}],
           commit_statuses: [$status.statuses[] | {context, state, created_at}]}]' <<<"$per_commit")
done
events=$(gh api --paginate "repos/$REPO/events?per_page=100" | jq -s 'add | map({id, type, created_at, actor: .actor.login, ref: .payload.ref, ref_type: .payload.ref_type, action: .payload.action, pull_request_head_sha: .payload.pull_request.head.sha})')
repository=$(gh api "repos/$REPO" | jq '{created_at, pushed_at, default_branch}')
all_runs=$(gh api "repos/$REPO/actions/runs?per_page=100" | jq '{total_count, workflow_runs: [.workflow_runs[] | {id, head_sha, event, created_at}]}')

jq -n --arg collected_at "$collected_at" --arg repo "$REPO" --arg selector "git log 694d4c9 -- ${PATHS[*]}" \
  --arg manifest "$PROBE_MANIFEST" --arg manifest_sha256 "$(shasum -a 256 "$PROBE_MANIFEST" | cut -d' ' -f1)" \
  --argjson frozen_at "$(jq .frozen_at "$PROBE_MANIFEST")" \
  --argjson per_commit "$per_commit" --argjson activity "$activity" --argjson events "$events" \
  --argjson repository "$repository" --argjson all_runs "$all_runs" '
  ($frozen_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) as $frozen_floor_s
  | {
  record_type: "github_server_timestamps",
  derived_by: "results/study-1/provenance/collect-github-timestamps.sh",
  collected_at: $collected_at,
  repository: $repo,
  oracle_commits_selector: $selector,
  first_cloud_evidence: {path: $manifest, sha256: $manifest_sha256, frozen_at: $frozen_at,
    note: "frozen_at is the operator machine clock, recorded in the frozen probe package."},
  summary: {
    oracle_commits: ($per_commit | length),
    with_actions_runs: [$per_commit[] | select(.actions_runs != [])] | length,
    with_check_runs: [$per_commit[] | select(.check_runs != [])] | length,
    with_commit_statuses: [$per_commit[] | select(.commit_statuses != [])] | length,
    first_pushed_before_first_cloud_evidence: [$per_commit[] | select(.first_push_containing_it != null and (.first_push_containing_it.timestamp | fromdateiso8601) < $frozen_floor_s)] | length,
    first_pushed_after_first_cloud_evidence: [$per_commit[] | select(.first_push_containing_it != null and (.first_push_containing_it.timestamp | fromdateiso8601) > $frozen_floor_s)] | length,
    never_pushed: [$per_commit[] | select(.first_push_containing_it == null)] | length,
    by_first_push: ($per_commit | group_by(.first_push_containing_it.id) | map({push: .[0].first_push_containing_it, commits: length}))
  },
  repository_record: $repository,
  repository_actions_runs: $all_runs,
  push_activity: $activity,
  events: $events,
  oracle_commits: $per_commit
}'
