# Reference Implementations

pi-manager contains its own implementation of indexing, IPC, scheduling, RPC
workers, naming and Pi-compatible JSONL handling. It does not import private
modules from the extensions below or require their installation.

Design references inspected during development:

- Local session-manager extension: persistent sessions and ownership.
- pi-intercom 0.13.0: addressed messaging and reply correlation; MIT, Copyright (c) 2026 Nico Bailon.
- pi-subagents 0.43.0: lifecycle observation and nested agents; MIT, Copyright (c) 2026 Nico Bailon.
- @ogulcancelik/pi-codex-subagents 0.3.3: child session lifecycle; MIT, Copyright (c) 2025 Can Celik.
- pi-rename-session 1.0.0: dynamic self-renaming behavior; MIT, Copyright (c) 2026 Braden Lamb.

The installed Pi host's public Extension API and JSONL v3 protocol are the
platform boundary. No complete upstream Pi engine or third-party extension
source is vendored in this release. If future revisions vendor source, its
original license and exact source version must be included alongside it.
