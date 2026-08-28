#![allow(dead_code)]

use std::path::PathBuf;

use tempfile::TempDir;
use codev_lib::modules::fs::to_canon;

pub struct FsFixture {
    pub root: PathBuf,
    _tmp: TempDir,
}

impl FsFixture {
    pub fn new() -> Self {
        let tmp = TempDir::new().expect("tempdir");
        let root = std::fs::canonicalize(tmp.path()).expect("canonicalize");
        Self { root, _tmp: tmp }
    }

    pub fn root_str(&self) -> String {
        to_canon(&self.root)
    }

    pub fn write(&self, rel: &str, content: &str) {
        let p = self.root.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).expect("mkdir parents");
        }
        std::fs::write(&p, content).expect("write file");
    }

    pub fn mkdir(&self, rel: &str) {
        std::fs::create_dir_all(self.root.join(rel)).expect("mkdir");
    }
}
