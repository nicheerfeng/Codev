// Standalone safety verification for the rebuilt VCS process layer.
use codev_lib::modules::vcs::process;

#[test]
fn error_classifier_gives_actionable_codes() {
    let err = process::classify_error("Author identity unknown");
    assert_eq!(err.code, process::VcsErrorCode::MissingAuthorIdentity);
    assert!(err.to_wire().contains("MissingAuthorIdentity"));
}
