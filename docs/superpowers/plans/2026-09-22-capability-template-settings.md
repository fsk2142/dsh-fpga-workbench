# FPGA Capability and Template Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace stage-specific FPGA settings with seven capability cards backed by one ready-tool registry and an on-demand categorized template library.

**Architecture:** `lib/toolchain.js` owns the string settings schema metadata, capability resolution, migration, and prompt description. A new pure Node module `lib/template-library.js` owns the fixed category catalog, safe recursive scans, stable selection ids, and selected-template resolution; `lib/index.js` exposes it through an allowlisted read-only route. `lib/client.js` renders collapsible tool/capability cards and requests templates only when a capability opens.

**Tech Stack:** Node.js ESM, React-compatible DSH client bundle, `@deepseek-ai/schemastery`, built-in `node:fs`/`node:path`, repository self-check scripts.

**Spec:** `docs/superpowers/specs/2026-09-22-capability-template-settings-design.md`

## Global Constraints

- Do not modify any file below `presets/fpga-workbench/skills/**`.
- Do not add an automatic workflow, command queue, polling loop, or automatic tool execution.
- Module and project capability cards never own paths; they only select tools registered as ready at the top.
- Settings remain strings and `settingsModelVersion` becomes exactly `3`.
- Template scanning is read-only, capability-allowlisted, recursive only inside fixed category roots, and runs only when a capability card opens.
- Missing explicit tool/template selections remain selected and warn; they never silently fall back.
- Preserve the six flat templates as unscanned compatibility assets during this settings-only phase.
- Preserve unrelated dirty files and stage/commit only exact files owned by this plan.

## Review Focus

- A selected tool path disappears after save: the card must preserve the choice, warn, and not switch to `auto`.
- A selected user-library template disappears or the library root changes: the selection must remain visible as missing and not fall back.
- A slow scan/detection response arrives after a newer request: it must be discarded.
- The template library contains symlink/junction loops, hidden files, unreadable subdirectories, or over 500 files: scanning must stay bounded and report partial errors/truncation.
- v2 project FPGA stages disagree or contain different override paths: migration must choose `auto`, retain legacy values, and surface a warning without exposing full paths.

---

### Task 1: Capability model and v3 migration

**Files:**
- Modify: `lib/toolchain.js`
- Modify: `tools/check-toolchain.mjs`

**Interfaces:**
- Produces: `CAPABILITIES`, `resolveCapability(values, capability, probe)`, `resolveCapabilities(values, probe)`, v3 `legacyMigrationPatch(values)`, and `statusOf(...).capabilities`.
- Consumes: existing `TOOL_CATALOG`, `TOOL_GROUPS`, `probeFilesystem`, and string `FIELDS` schema contract.

- [ ] **Step 1: Write failing capability-shape tests**

Add assertions with literal expected keys and counts:

```js
check(CAPABILITIES.filter((item) => item.section === "module").map((item) => item.key).join(",") ===
  "module-rtl,module-simulation,module-verification,module-gate", "模块设置是四张能力卡");
check(CAPABILITIES.filter((item) => item.section === "project").map((item) => item.key).join(",") ===
  "project-main,project-simulation,project-verification", "工程设置是三张能力卡");
check(!FIELDS.some((field) => field.control !== "hidden" && field.pathKey?.endsWith("Path")), "能力卡没有覆盖路径");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node tools/check-toolchain.mjs`

Expected: FAIL because `CAPABILITIES` and v3 fields do not exist and old stage/path assertions still describe the v2 model.

- [ ] **Step 3: Implement capability metadata and resolution**

Replace stage bindings with seven records shaped as:

```js
{
  key: "module-rtl",
  section: "module",
  label: "RTL 编译工具",
  hint: "用于 RTL 语法、lint 与编译检查；不是固定的第一步。",
  role: "compiler",
  toolKey: "moduleRtlTool",
  tools: ROLE_TOOLS.compiler,
  templates: [{ key: "moduleRtlTemplate", category: "rtl", label: "RTL 模板" }]
}
```

Generate visible select/template fields from these records, retain all v1/v2 keys as hidden strings, remove visible per-stage override fields, and resolve explicit tools only through `TOOL_CATALOG[selection].pathKey`.

- [ ] **Step 4: Write failing migration tests**

Cover v2 agreement, v2 conflict, consistent override adoption, conflicting override warning, old template fan-out, missing old template preservation, v1 direct migration, idempotence at version `3`, and preservation of every legacy input key.

- [ ] **Step 5: Run migration tests and verify RED**

Run: `node tools/check-toolchain.mjs`

Expected: FAIL on version `2`, old stage targets, destructive clearing, or absent migration warnings.

- [ ] **Step 6: Implement v3 migration and capability status**

Create a non-destructive v1 normalization helper, merge its result in memory, derive v3 capability selections, group override paths by explicit tool, and write `settingsMigrationWarnings` as a JSON string of path-free labels. Return `settingsModelVersion: "3"` and never emit a patch that clears a legacy key. Make `statusOf` return tool cards, capabilities, template-library metadata, parsed migration warnings, and `ok: true`.

- [ ] **Step 7: Run the focused suite GREEN**

Run: `node tools/check-toolchain.mjs`

Expected: PASS with all capability and migration assertions, while unrelated cleanup/detection/template compatibility assertions still pass or are deliberately replaced in later tasks.

- [ ] **Step 8: Commit exact Task 1 files**

```bash
git add lib/toolchain.js tools/check-toolchain.mjs
git commit -m "feat(settings): model module and project capabilities"
```

### Task 2: Categorized template library, assets, and route

**Files:**
- Create: `lib/template-library.js`
- Create: categorized files below `presets/fpga-workbench/templates/{rtl,constraints,verification,simulation,synthesis,implementation,programming}/`
- Modify: `lib/toolchain.js`
- Modify: `lib/index.js`
- Modify: `tools/check-toolchain.mjs`
- Modify: `tools/check-load-contract.mjs`
- Modify: `tools/check-fpga-tools.mjs`

**Interfaces:**
- Produces: `TEMPLATE_CATEGORIES`, `BUILTIN_TEMPLATES`, `scanTemplates({ capability, capabilities, libraryRoot })`, `resolveTemplateSelection(...)`, and `TEMPLATE_PATH`.
- Consumes: Task 1 `CAPABILITIES[*].templates` and settings fields `templateLibraryPath` plus per-slot selection strings.

- [ ] **Step 1: Write failing scanner and resolver tests**

Use a temporary fixture library with nested files, a hidden file, an unreadable/missing category, a symlink when supported, and 501 ordinary files. Assert literal ids such as `library:rtl/vendor/custom.sv`, no root-level legacy files, per-category truncation, no link traversal, and explicit missing-selection state without fallback.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node tools/check-toolchain.mjs`

Expected: FAIL because the template-library module, stable ids, and scanner are absent.

- [ ] **Step 3: Implement the pure template library module**

Define the nine category directories, builtin records with compatibility metadata, a maximum of 500 files per category, hidden/temp filtering, non-following recursion, safe relative id validation, and exact-path resolution for `builtin:`, `library:`, and legacy absolute strings. Return source-specific errors without throwing away builtin entries.

- [ ] **Step 4: Add categorized standard templates**

Copy/adapt the current RTL, XDC, Python comparison, Testbench, and synthesis contents into their categorized names. Add a compile-only ModelSim `.do`, a run-only ModelSim `.do`, a Vivado implementation `.tcl`, and a Vivado programming `.tcl`. Each script must fail loudly for missing required facts and must not call the next stage. Keep the six flat compatibility files unchanged.

- [ ] **Step 5: Add the allowlisted host route and tests**

Export `TEMPLATE_PATH = "/plugins/fpga-workbench/templates"`. Register a route that accepts only `capability`, obtains categories from `CAPABILITIES`, reads the saved library root, and returns scan results. Unknown capabilities and unexpected failures return non-2xx JSON errors. Extend load-contract checks to assert the route registration and handler response shape.

- [ ] **Step 6: Integrate selected templates into status and prompt**

Resolve saved selections without scanning directories. Empty values resolve only to compatible builtins; explicit missing selections remain missing. Update `describeEnv` to list the seven capabilities and their template decisions without creating a command order.

- [ ] **Step 7: Run focused suites GREEN**

Run: `node tools/check-toolchain.mjs`

Expected: PASS.

Run: `node tools/check-load-contract.mjs`

Expected: PASS.

Run: `node tools/check-fpga-tools.mjs`

Expected: PASS with legacy flat-template checks intact and new categorized-template behavior verified.

- [ ] **Step 8: Commit exact Task 2 files**

```bash
git add lib/template-library.js lib/toolchain.js lib/index.js tools/check-toolchain.mjs tools/check-load-contract.mjs tools/check-fpga-tools.mjs presets/fpga-workbench/templates
git commit -m "feat(settings): add categorized template library"
```

### Task 3: Collapsible capability-card client

**Files:**
- Modify: `lib/client.js`
- Modify: `tools/check-load-contract.mjs`

**Interfaces:**
- Consumes: `status.capabilities`, `status.toolCards`, `status.toolGroups`, `status.migrationWarnings`, and `GET TEMPLATE_PATH?capability=` from Tasks 1-2.
- Produces: one collapsible top tool section, seven independently saved capability cards, and on-open template requests with stale-response protection.

- [ ] **Step 1: Replace client fixture and add failing render assertions**

Use four module capability fixtures and three project fixtures. Assert collapsed rows include tool/template summaries, no visible override path, no “开发约定与模板”, and a collapsed “工具设置” summary. Assert unready tool `<option disabled>` while `auto` and `none` remain enabled.

- [ ] **Step 2: Run client contract and verify RED**

Run: `node tools/check-load-contract.mjs`

Expected: FAIL because the client still renders stages, binding paths, and the old conventions block.

- [ ] **Step 3: Implement capability-card rendering and independent saves**

Track `showToolSettings`, `expandedCapability`, template scan state/sequence, and per-card field keys. Render common auxiliary groups as compact foldouts. Render each capability from host metadata, add disabled readiness-aware tool options, template selects with source labels, warning text, Cancel, and “保存此能力”. Do not call tool detection from capability cards.

- [ ] **Step 4: Add failing on-demand/error/race tests**

Assert no template request on initial render, exactly one allowlisted request on open, a fresh request after close/reopen, only current card categories displayed, stale response discarded, non-2xx and malformed responses shown as “模板读取失败”, and failed tool detection shown as “工具检测失败” rather than “没检测到”.

- [ ] **Step 5: Run client contract and verify RED**

Run: `node tools/check-load-contract.mjs`

Expected: FAIL on absent template fetch/error handling and the known non-2xx detection misreport.

- [ ] **Step 6: Implement on-demand scans and strict response handling**

On capability open, increment a sequence, clear prior results, and fetch `TEMPLATE_URL?capability=<key>`. Treat non-2xx, non-object JSON, missing groups, or rejected fetch as an error. On close, invalidate the sequence and discard results. Apply the same non-2xx/malformed distinction to tool detection.

- [ ] **Step 7: Run client contract GREEN**

Run: `node tools/check-load-contract.mjs`

Expected: PASS for rendering, saving, scanning, races, and errors.

- [ ] **Step 8: Commit exact Task 3 files**

```bash
git add lib/client.js tools/check-load-contract.mjs
git commit -m "feat(settings): render capability template cards"
```

### Task 4: Documentation, installed-copy sync, and final verification

**Files:**
- Modify: `README.md`
- Modify: `docs/CLIENT_CHECKLIST.md`
- Modify: `tools/smoke-installed.mjs`
- Modify if required by shipped-file checks: `tools/check-installed.mjs`, `tools/shipped.mjs`

**Interfaces:**
- Consumes: final host status and client UI contracts.
- Produces: user-facing setup documentation and installed-copy verification for DSH Desktop 2.0.13 local installation.

- [ ] **Step 1: Write failing installed smoke assertions**

Assert the installed status has exactly four module and three project capabilities, version `3` fields, template endpoint registration, and categorized builtins. Remove assertions for five/eight stages and v2 bindings.

- [ ] **Step 2: Run installed smoke and verify RED**

Run: `node tools/smoke-installed.mjs`

Expected: FAIL because the installed copy still has the previous settings UI/model.

- [ ] **Step 3: Update documentation and client checklist**

Document the ready-tool registry, seven capability cards, independent module/project template selections, fixed library tree, on-open scans, explicit no-pipeline rule, compatibility flat templates, and the restart checklist. Do not document skills as changed.

- [ ] **Step 4: Sync the local installed copy**

Run: `node tools/sync-installed.mjs`

Expected: exit 0 and only repository-owned plugin files synchronized; user settings and preset customizations are not deleted.

- [ ] **Step 5: Run all verification commands**

Run: `node tools/check-toolchain.mjs`

Expected: PASS.

Run: `node tools/check-fpga-tools.mjs`

Expected: PASS or a clearly named external-tool SKIP, never a false PASS.

Run: `node tools/check-load-contract.mjs`

Expected: PASS.

Run: `node tools/check-installed.mjs`

Expected: PASS.

Run: `node tools/smoke-installed.mjs`

Expected: PASS.

Run: `npm test`

Expected: all source and available host checks pass; any environment-only skip or pre-existing unrelated dirty-skill failure is reported by exact name.

- [ ] **Step 6: Commit exact Task 4 files**

```bash
git add README.md docs/CLIENT_CHECKLIST.md tools/smoke-installed.mjs tools/check-installed.mjs tools/shipped.mjs
git commit -m "docs(settings): explain capability template configuration"
```

- [ ] **Step 7: Final review and one fix pass**

Build a review package from the plan workspace and inspect the complete diff against the spec, with special attention to the five Review Focus failures. Any Critical or Important finding gets one RED-GREEN fix pass followed by the full suite; Minor findings are recorded for the user instead of silently expanding scope.

