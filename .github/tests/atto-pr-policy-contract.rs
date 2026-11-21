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
#[test] fn persistent_single_owner_review_at_every_ready_age() {
    let s = block();
    for required in ["No Ready-age review windows", "No mandatory AI provider reviews",
                     "mandatory competing/overlapping-PR audit",
                     "before **every** merge", "latest genuine Draft→Ready event"] {
        assert!(s.contains(required), "one-owner policy missing: {required}");
    }
    for forbidden in ["Ready age 0–72h", "Ready age 72–240h", "Ready age ≥240h",
                      "OpenAI", "Anthropic", "resets AI freshness",
                      "fresh post-boundary reviews from all four"] {
        assert!(!s.contains(forbidden), "obsolete approval quorum present: {forbidden}");
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