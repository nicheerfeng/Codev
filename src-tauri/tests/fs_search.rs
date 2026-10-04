mod common;

use common::FsFixture;
use codev_lib::modules::fs::grep::fs_glob;
use codev_lib::modules::fs::search::fs_list_files;
use codev_lib::modules::fs::tree::{fs_read_dir, list_subdirs, EntryKind};

#[test]
fn glob_finds_files_by_pattern() {
    let fx = FsFixture::new();
    fx.write("src/a.rs", "");
    fx.write("src/b.rs", "");
    fx.write("README.md", "");

    let res = fs_glob("**/*.rs".into(), fx.root_str(), None, None).expect("glob");

    let mut rels: Vec<&str> = res.hits.iter().map(|h| h.rel.as_str()).collect();
    rels.sort();
    assert_eq!(rels, vec!["src/a.rs", "src/b.rs"]);
}

#[test]
fn glob_truncates_on_limit() {
    let fx = FsFixture::new();
    for i in 0..20 {
        fx.write(&format!("file{i}.txt"), "");
    }

    let res = fs_glob("*.txt".into(), fx.root_str(), Some(5), None).expect("glob");
    assert!(res.hits.len() <= 5);
    assert!(res.truncated);
}

#[test]
fn glob_empty_pattern_errors() {
    let fx = FsFixture::new();
    assert!(fs_glob("".into(), fx.root_str(), None, None).is_err());
}

#[test]
fn list_files_returns_sorted_relative_paths() {
    let fx = FsFixture::new();
    fx.write("z.txt", "");
    fx.write("a.txt", "");
    fx.write("nested/b.txt", "");

    let res = fs_list_files(fx.root_str(), None, None, None, None).expect("list");
    assert_eq!(res.files, vec!["a.txt", "nested/b.txt", "z.txt"]);
}

#[test]
fn list_files_max_depth_clamps() {
    let fx = FsFixture::new();
    fx.write("d1/d2/d3/deep.txt", "");
    fx.write("shallow.txt", "");

    let res = fs_list_files(fx.root_str(), None, Some(1), None, None).expect("list");
    assert!(res.files.contains(&"shallow.txt".to_string()));
    assert!(!res.files.iter().any(|f| f.contains("deep.txt")));
}

#[test]
fn list_files_non_dir_errors() {
    assert!(fs_list_files("/no/such/dir".into(), None, None, None, None).is_err());
}

#[test]
fn read_dir_orders_dirs_before_files_then_alpha() {
    let fx = FsFixture::new();
    fx.mkdir("zdir");
    fx.mkdir("adir");
    fx.mkdir("dir10");
    fx.mkdir("dir2");
    fx.write("zfile.txt", "");
    fx.write("afile.txt", "");
    fx.write("file10.txt", "");
    fx.write("file2.txt", "");

    let entries = fs_read_dir(fx.root_str(), false, None).expect("read_dir");
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "adir",
            "dir2",
            "dir10",
            "zdir",
            "afile.txt",
            "file2.txt",
            "file10.txt",
            "zfile.txt",
        ],
    );
    assert!(matches!(entries[0].kind, EntryKind::Dir));
    assert!(matches!(entries[4].kind, EntryKind::File));
}

#[test]
fn read_dir_hides_dotfiles_by_default() {
    let fx = FsFixture::new();
    fx.write(".secret", "");
    fx.write("visible.txt", "");

    let hidden_off = fs_read_dir(fx.root_str(), false, None).expect("read_dir");
    let names: Vec<&str> = hidden_off.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["visible.txt"]);

    let hidden_on = fs_read_dir(fx.root_str(), true, None).expect("read_dir");
    let names: Vec<&str> = hidden_on.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&".secret"));
}

#[test]
fn read_dir_returns_size_for_files() {
    let fx = FsFixture::new();
    fx.write("known.txt", "abcdef");

    let entries = fs_read_dir(fx.root_str(), false, None).expect("read_dir");
    let entry = entries.iter().find(|e| e.name == "known.txt").unwrap();
    assert_eq!(entry.size, 6);
    assert!(matches!(entry.kind, EntryKind::File));
}

#[test]
fn list_subdirs_returns_only_directories() {
    let fx = FsFixture::new();
    fx.mkdir("dir_10");
    fx.mkdir("dir_2");
    fx.write("not_a_dir.txt", "");

    let dirs = list_subdirs(fx.root_str(), false, None).expect("list_subdirs");
    assert_eq!(dirs, vec!["dir_2", "dir_10"]);
}

#[test]
fn list_subdirs_hides_dot_dirs_by_default() {
    let fx = FsFixture::new();
    fx.mkdir(".hidden");
    fx.mkdir("visible");

    let off = list_subdirs(fx.root_str(), false, None).expect("list_subdirs");
    assert_eq!(off, vec!["visible"]);

    let on = list_subdirs(fx.root_str(), true, None).expect("list_subdirs");
    assert!(on.contains(&".hidden".to_string()));
}
