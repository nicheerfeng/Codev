# Terminal renderer lifecycle

This guide elaborates on `CODEV.md`. If anything here conflicts with
`CODEV.md`, `CODEV.md` wins.

## Why a lifecycle exists

Terminal sessions are kept alive so shells and development services can keep
running in the background. Every currently visible terminal gets its own
xterm.js rendering slot. Hidden idle terminals release their slot on demand;
their PTY session and recent output remain available for restoration.

The lifecycle is implemented in `src/modules/terminal/lib/rendererPool.ts`.

## Slot lifecycle

- A slot owns one xterm `Terminal`, `FitAddon`, `SearchAddon`, and
  `SerializeAddon`.
- Slots are created on demand when a visible terminal needs one. There is no
  fixed five-slot limit and visible terminals are never displaced to make room
  for another visible terminal.
- `releaseSlot` detaches a hidden idle terminal and parks its host with
  `display:none` before the slot becomes reusable.
- After a grace period, surplus idle slots are disposed. At least one idle slot
  stays warm.

## Parking vs releasing

When a terminal becomes hidden:

1. `parkLeafSlot` first pauses rendering with `display:none` while the xterm
   buffer remains available.
2. If the terminal has a foreground command or alternate-screen TUI, its slot
   stays parked so its live screen is preserved.
3. If the terminal is idle, `releaseSlot` detaches the slot after the idle
   check. The PTY stays alive and subsequent output enters `DormantRing`.

When the terminal becomes visible again, `acquireSlot` first reuses its
retained slot, then a clean idle slot, and finally creates a new slot. A
retained buffer may be serialized before its slot is reused.

## The DormantRing

`src/modules/terminal/lib/dormantRing.ts` buffers PTY bytes while a terminal
has no slot. It is capped at 1 MiB per terminal and drops the oldest blocks on
overflow. On drain it resumes from the next line boundary rather than
resetting the terminal, so a mid-line escape sequence is not replayed from the
middle.

## Restoration

If a retained slot still belongs to the terminal, binding skips a full reset
and drains the dormant ring into its live buffer. If the slot was reused, the
serialized snapshot is restored and new dormant output is appended. For
alternate-screen TUIs, the snapshot is skipped and a PTY resize kick asks the
TUI to repaint its current screen.

## Invariants

- The number of terminal sessions is not limited by the renderer lifecycle.
- Every currently visible terminal has its own rendering slot.
- Hidden idle terminals may release their slots; their PTYs are not closed.
- Hidden busy terminals and alternate-screen TUIs keep their live slot parked.
- `DormantRing` only buffers output for a terminal without a slot.

## See also

- [`CODEV.md`](../../CODEV.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [PTY shell integration](pty-shell-integration.md) - sessions, OSC sequences,
  and terminal lifecycle integration
