use std::fs;
fn block() -> String {
    let source = fs::read_to_string("AGENTS.md").expect("AGENTS.md must exist");
    let start_tag = "<!-- org-merge-review-policy:begin -->";
    let end_tag = "<!-- org-merge-review-policy:end -->";
    assert_eq!(source.matches(start_tag).count(), 1, "policy start marker must be unique");
    assert_eq!(source.matches(end_tag).count(), 1, "policy end marker must be unique");
    let start = source.find(start_tag).unwrap();
    let end = source.find(end_tag).unwrap();
    assert!(start < end, "policy marker order");
    source[start..end].to_string()
}
#[test] fn either_human_once_and_persistent() {
    let s = block();
    for required in ["either", "the1mills", "ORESoftware", "2148448", "11139560",
                     "Never require both", "do **not** demand another human approval",
                     "No self-approval", "CHANGES_REQUESTED"] {
        assert!(s.contains(required), "human policy missing: {required}");
    }
    assert!(!s.contains("fresh post-boundary reviews from all four"));
}
#[test] fn ready_cycle_review_lanes() {
    let s = block();
    for required in ["Ready age 0–72h", "Ready age 72–240h", "Ready age ≥240h",
                     "OpenAI", "Anthropic", "mandatory competing/overlapping-PR audit",
                     "latest genuine Draft→Ready event", "resets AI freshness"] {
        assert!(s.contains(required), "ready-cycle policy missing: {required}");
    }
}
#[test] fn holds_and_real_ci() {
    let s = block();
    for required in ["keep-as-draft", "keep-draft", "not-ready",
                     "passing exact-head material CI", "verified current labels",
                     "automatic promotion", "automated merging"] {
        assert!(s.contains(required), "draft policy missing: {required}");
    }
}
#[test] fn canonical_source_and_private_code_safety() {
    let s = block();
    for required in ["https://github.com/atto-lang/.github/blob/main/AGENTS.md",
                     "CODEOWNERS", "GitHub protections",
                     "Approval policy text is not merge authorization",
                     "authorized private SHA-verified Git-tree carrier"] {
        assert!(s.contains(required), "safety policy missing: {required}");
    }
}
#[test] fn workflow_runs_on_exact_head_without_checkout_tokens() {
    let flow = fs::read_to_string(".github/workflows/atto-pr-policy-parity.yml")
        .expect("governance workflow must exist");
    for required in [
        "pull_request:", "push:", "workflow_dispatch:",
        "EXPECTED_HEAD: ${{ github.event.pull_request.head.sha || github.sha }}",
        "ref: ${{ github.event.pull_request.head.sha || github.sha }}",
        "persist-credentials: false",
        "test \"$(git rev-parse HEAD)\" = \"$EXPECTED_HEAD\"",
        "rustc --edition=2021 -D warnings --test",
    ] {
        assert!(flow.contains(required), "exact-head CI requirement missing: {required}");
    }
    assert!(!flow.contains("paths:"), "required policy check cannot be path-skipped");
}
