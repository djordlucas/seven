# ADR — decision records and implementation notes

This directory holds the **record of how seven got here**: design notes,
investigation reports, implementation plans and reviews, for people changing
seven. It does not describe current behavior; `docs/` does.

## What goes where

| | `docs/` | `adr/` |
|---|---|---|
| Answers | how seven works today | why it works that way |
| Audience | users and operators | people changing seven |
| Tense | present | historical |
| Code references | avoided — components and concepts instead | expected: file paths, symbols, commits |

A document belongs here if its value is the *record* — the options weighed, the
migration sequence, the problem that motivated a change. When a plan here ships,
its behavior is absorbed into `docs/` and the plan stays as the record.

## Contents

### Implemented

| Document | What it records | Shipped |
|----------|-----------------|---------|
| `child-process-runner.md` | Replacing the QuickJS-in-wasm VM with a Node.js child process per run; the npm compatibility probe that decided it | 2026-10-21 |

### Superseded

| Document | What it records | Superseded by |
|----------|-----------------|---------------|
| `vm-runtime.md` | The QuickJS-in-wasm VM as a simpler equivalent of nine's tool VM: what was kept, what was dropped and why | `child-process-runner.md` |

## Limits

ADRs are exempt from `DOCS_STYLE.md` rule 6: they keep superseded content by
design, in past tense, and are not rewritten when a decision is later reversed.
