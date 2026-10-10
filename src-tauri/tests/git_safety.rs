// 独立验证 Git 模块，避免其他模块的单元测试编译错误阻塞 Git 回归。
#[path = "../src/modules/proc/mod.rs"]
pub mod proc;
pub mod modules {
    pub use crate::proc;
}
#[path = "../src/modules/git.rs"]
mod git;
