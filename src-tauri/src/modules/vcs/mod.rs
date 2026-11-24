pub mod ai_commit;
pub mod process;
pub mod repo;
pub mod types;
pub mod watch;

pub use repo::VcsService;
pub use types::*;
pub use watch::VcsWatcher;
