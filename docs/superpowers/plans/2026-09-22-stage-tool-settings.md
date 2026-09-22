# Stage-Scoped FPGA Tool Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single global FPGA tool selection with a three-section settings model—common tools, module-stage tools, and project-stage tools—while preserving old values, keeping AI-directed `auto` choices, and presenting long explanations through accessible question-mark tooltips.

**Architecture:** `lib/toolchain.js` remains the single source of truth. A common tool catalog owns installation paths and invocation facts; stage binding definitions own per-stage selection and optional override paths; pure resolvers feed the status route and mode prompt. `lib/client.js` remains metadata-driven and renders the returned section/stage layout without hardcoding setting keys.

**Tech Stack:** Node.js ESM, DSH settings + Schemastery, hand-written React CJS client bundle, repository assertion scripts.

**Spec:** `docs/superpowers/specs/2026-09-22-stage-tool-settings-design.md`

## Global Constraints

- Modify settings behavior only; do not read, edit, stage, or commit `presets/**/skills/**`.
- The module stages remain five independently reusable capabilities; no current-stage state, progress percentage, next-stage action, or automatic pipeline may be added.
- Stage path precedence is exactly: non-empty stage override, then selected tool's common path, then unconfigured.
- `auto` means AI judgment from registered tools; `none` means the user explicitly disabled that role.
- Keep atomic `scope.mutate()` saves, unsaved preview, browse/detect generation guards, host-side path validation, and zero runtime deletion.
- Do not install/sync the plugin or mutate the DSH Desktop profile; the user will restart and validate after repository checks pass.
- Long explanations move behind a small `?` affordance visible on mouse hover and keyboard focus; current warnings and save state remain inline.

## Review Focus

- A machine with both members of a tool category configured must retain both paths when a stage choice changes; Task 1 tests simultaneous Verilator/Icarus, ModelSim/XSim, and Vivado/Quartus values.
- Very old `verilatorPath` / `modelsimPath` / `vivadoPath` values must be promoted in place, while ambiguous current shared paths migrate to custom slots instead of being guessed; Task 1 tests both paths.
- `auto`, `none`, invalid values, missing common paths, and a stage override whose kind differs from another option must resolve to distinct states; Task 1 tests all five.
- A late detection or preview response must not overwrite newer stage choices or drafts; Task 2 retains and updates the existing out-of-order response tests.
- Help text must be reachable without a mouse and must not hide errors such as an invalid path; Task 2 tests focusable help controls plus inline warning text.

---

### Task 1: Host-side tool catalog, stage bindings, migration, status, detection, and prompt

**Files:**
- Modify: `lib/toolchain.js`
- Modify: `lib/index.js`
- Modify: `tools/check-toolchain.mjs`

**Interfaces:**
- Produces: `TOOL_CATALOG`, `SETTINGS_SECTIONS`, `STAGES`, `BINDINGS`, `resolveBinding(values, binding, probe)`, and `resolveBindings(values, probe)` from `lib/toolchain.js`.
- Produces: `statusOf(values)` payload `{ tools, sections, stages, bindings, missing, ok }`; `tools` remains the flat schema/render list for compatibility.
- Produces: detection hits `{ field, tool, label, path, source, ...version }`, where `field` is always a common tool path field.
- Preserves: `FIELDS`, `inspectTools`, `legacyMigrationPatch`, `describeEnv`, `detectTools`, `probeFilesystem`, template helpers, and unrelated preset/safety exports.
- Consumed by Task 2: `section`, `sectionLabel`, `stage`, `stageLabel`, `advanced`, and `bindingKey` field metadata, plus `sections`, `stages`, and `bindings` status arrays.

- [ ] **Step 1: Replace brittle field-count assertions with failing semantic tests**

In `tools/check-toolchain.mjs`, import the new exports and replace the old `20 fields / 6 groups / 3 required shared paths` assertions with tests shaped as follows:

```js
import {
  BINDINGS,
  SETTINGS_SECTIONS,
  STAGES,
  TOOL_CATALOG,
  resolveBinding,
  resolveBindings
} from "../lib/toolchain.js";

const sectionKeys = SETTINGS_SECTIONS.map((section) => section.key);
check(sectionKeys.join(",") === "common,module,project", "设置只有通用工具、模块工具、工程工具三个顶层区");
check(STAGES.filter((stage) => stage.section === "module").length === 5, "模块工具显示五个可反复切换的环节");
check(STAGES.filter((stage) => stage.section === "project").length === 8, "工程工具显示八个独立环节");

for (const [tool, pathKey, kind] of [
  ["python", "pythonPath", "file"],
  ["verilator", "verilatorPath", "file"],
  ["iverilog", "iverilogPath", "file"],
  ["modelsim", "modelsimPath", "file"],
  ["xsim", "xsimPath", "directory"],
  ["vivado", "vivadoPath", "file"],
  ["quartus", "quartusPath", "file"]
]) {
  check(TOOL_CATALOG[tool]?.pathKey === pathKey && TOOL_CATALOG[tool]?.kind === kind, `${tool} 有独立通用路径与正确类型`);
}

const commonPaths = {
  verilatorPath: "C:\\tools\\verilator_bin.exe",
  iverilogPath: "C:\\tools\\iverilog.exe",
  modelsimPath: "C:\\tools\\vsim.exe",
  xsimPath: "C:\\Vivado\\bin",
  vivadoPath: "C:\\Vivado\\bin\\vivado.bat",
  quartusPath: "C:\\Quartus\\bin64\\quartus_sh.exe"
};
const allPresent = probeTyped([commonPaths.xsimPath], Object.values(commonPaths).filter((path) => path !== commonPaths.xsimPath));
const inspectedCommon = new Map(inspectTools(commonPaths, allPresent).map((field) => [field.key, field]));
check(Object.keys(commonPaths).every((key) => inspectedCommon.get(key)?.present === true), "多套工具路径可以同时保存且互不覆盖");

const rtlBinding = BINDINGS.find((binding) => binding.key === "moduleRtlCompiler");
const inherited = resolveBinding({ ...commonPaths, moduleRtlCompilerTool: "verilator" }, rtlBinding, allPresent);
check(inherited.path === commonPaths.verilatorPath && inherited.source === "common" && inherited.state === "ready", "环节留空时继承通用路径");
const overridden = resolveBinding(
  { ...commonPaths, moduleRtlCompilerTool: "verilator", moduleRtlCompilerPath: "D:\\wrapped\\verilator.exe" },
  rtlBinding,
  probeWith(["D:\\wrapped\\verilator.exe"])
);
check(overridden.path === "D:\\wrapped\\verilator.exe" && overridden.source === "stage", "环节路径覆盖通用路径");
check(resolveBinding({ moduleRtlCompilerTool: "auto" }, rtlBinding, probeWith([])).state === "auto", "auto 保留 AI 判断");
check(resolveBinding({ moduleRtlCompilerTool: "none" }, rtlBinding, probeWith([])).state === "none", "none 明确禁用");
check(resolveBinding({ moduleRtlCompilerTool: "bogus" }, rtlBinding, probeWith([])).state === "invalid", "非法选择不会假装可用");
check(resolveBinding({ moduleRtlCompilerTool: "verilator" }, rtlBinding, probeWith([])).state === "missing", "显式工具缺路径时只标记该绑定缺失");
```

Add migration assertions with exact target behavior:

```js
const migratedV2 = legacyMigrationPatch({
  settingsModelVersion: "",
  compiler: "iverilog",
  compilerPath: "C:\\iverilog\\bin\\iverilog.exe",
  simulator: "xsim",
  simulatorPath: "C:\\Vivado\\bin",
  synthesizer: "quartus",
  synthesizerPath: "C:\\Quartus\\bin64\\quartus_sh.exe",
  python: "python",
  pythonPath: "C:\\Python314\\python.exe"
});
check(migratedV2.settingsModelVersion === "2", "迁移写入模型版本 2");
check(migratedV2.iverilogPath?.endsWith("iverilog.exe"), "共享编译路径迁到 Icarus 专属字段");
check(migratedV2.xsimPath === "C:\\Vivado\\bin", "共享 XSim 路径保持目录语义");
check(migratedV2.quartusPath?.endsWith("quartus_sh.exe"), "共享综合路径迁到 Quartus 专属字段");
check(migratedV2.moduleRtlCompilerTool === "iverilog" && migratedV2.projectIntegrateCompilerTool === "iverilog", "旧编译选择迁到相关环节");
check(migratedV2.moduleVerifSimulatorTool === "xsim" && migratedV2.projectSyssimSimulatorTool === "xsim", "旧仿真选择迁到相关环节");
check(migratedV2.compilerPath === "" && migratedV2.simulatorPath === "" && migratedV2.synthesizerPath === "", "共享来源键清空防止复活");
check(Object.keys(legacyMigrationPatch({ settingsModelVersion: "2", compilerPath: "C:\\old.exe" })).length === 0, "版本 2 不重复迁移");

const promoted = legacyMigrationPatch({ settingsModelVersion: "", verilatorPath: "C:\\old\\verilator_bin.exe" });
check(promoted.verilatorPath === undefined, "老的工具专属字段原地保留、不清空");
check(promoted.moduleRtlCompilerTool === "verilator", "老的工具专属路径可恢复相关环节偏好");

const ambiguous = legacyMigrationPatch({ settingsModelVersion: "", compilerPath: "C:\\vendor\\compile.exe" });
check(ambiguous.customCompilerPath === "C:\\vendor\\compile.exe", "无法识别的旧路径进入自定义槽位");
check(ambiguous.moduleRtlCompilerTool === "custom-compiler", "无法识别的旧编译器不猜厂商");
```

Add status/detection/prompt assertions:

```js
const stagedStatus = statusOf({ ...commonPaths, moduleRtlCompilerTool: "verilator" }, allPresent);
check(stagedStatus.sections.length === 3 && stagedStatus.stages.length === 13, "状态载荷包含三层布局与全部环节");
check(stagedStatus.bindings.find((binding) => binding.key === "moduleRtlCompiler")?.state === "ready", "状态载荷包含解析后的环节绑定");
check(stagedStatus.ok === true, "单个环节缺工具不会把整个 FPGA 模式判坏");

const detected = detectTools(probe, list, env, readVersion);
check(detected.some((hit) => hit.field === "verilatorPath" && hit.tool === "verilator"), "检测结果落到 Verilator 专属字段");
check(detected.some((hit) => hit.field === "iverilogPath" && hit.tool === "iverilog"), "检测结果落到 Icarus 专属字段");
check(!detected.some((hit) => ["compilerPath", "simulatorPath", "synthesizerPath"].includes(hit.field)), "检测不再写共享旧字段");

const envText = describeEnv({ ...commonPaths, moduleRtlCompilerTool: "verilator", moduleVerifSimulatorTool: "auto", moduleSynthFpgaTool: "none" }, allPresent);
check(envText.includes("能力配置，不是执行顺序"), "会话提示明确不是流水线");
check(envText.includes("RTL") && envText.includes(commonPaths.verilatorPath), "显式环节首选给出有效路径");
check(envText.includes("由 AI 根据当前任务判断"), "auto 的含义写清");
check(envText.includes("明确不用"), "none 的含义写清");
```

- [ ] **Step 2: Run the host-side check and verify RED**

Run:

```powershell
node tools/check-toolchain.mjs
```

Expected: FAIL because the new catalog/layout/binding exports do not exist and the current detection targets still use shared path fields. A syntax/import error caused only by the missing named exports is acceptable for this first RED; fix test typos until the failure points only at the absent feature.

- [ ] **Step 3: Implement the catalog and stage schema in `lib/toolchain.js`**

Add these exact top-level structures, with full labels/hints/usages copied from the existing known-tool options rather than duplicated elsewhere:

```js
export const SETTINGS_SECTIONS = [
  { key: "common", label: "通用工具", hint: "登记本机实际安装的工具；这里不决定环节顺序。" },
  { key: "module", label: "模块工具", hint: "五个能力环节可以按任务反复切换，不是流水线。" },
  { key: "project", label: "工程工具", hint: "各工程环节分别设置首选工具，不自动执行。" }
];

export const TOOL_CATALOG = {
  python: { role: "script", label: "Python 3", pathKey: "pythonPath", kind: "file" },
  verilator: { role: "compiler", label: "Verilator", pathKey: "verilatorPath", kind: "file" },
  iverilog: { role: "compiler", label: "Icarus Verilog", pathKey: "iverilogPath", kind: "file" },
  modelsim: { role: "simulator", label: "ModelSim / Questa", pathKey: "modelsimPath", kind: "file" },
  xsim: { role: "simulator", label: "Vivado XSim", pathKey: "xsimPath", kind: "directory" },
  vivado: { role: "fpga", label: "Vivado", pathKey: "vivadoPath", kind: "file" },
  quartus: { role: "fpga", label: "Quartus Prime", pathKey: "quartusPath", kind: "file", supportNote: "当前只保证路径与检测，不代表已有完整工程流程。" },
  "custom-compiler": { role: "compiler", label: "自定义编译工具", pathKey: "customCompilerPath", nameKey: "customCompilerName", notesKey: "customCompilerNotes", kind: "file" },
  "custom-simulator": { role: "simulator", label: "自定义仿真工具", pathKey: "customSimulatorPath", nameKey: "customSimulatorName", notesKey: "customSimulatorNotes", kind: "file" },
  "custom-fpga": { role: "fpga", label: "自定义 FPGA 工具", pathKey: "customFpgaToolPath", nameKey: "customFpgaToolName", notesKey: "customFpgaToolNotes", kind: "file" }
};
```

Define all stages and bindings explicitly; do not derive an execution order from array position:

```js
export const STAGES = [
  { key: "module-spec", section: "module", label: "规格", bindings: ["moduleSpecScript"] },
  { key: "module-rtl", section: "module", label: "RTL", bindings: ["moduleRtlCompiler"] },
  { key: "module-verif", section: "module", label: "验证", bindings: ["moduleVerifSimulator", "moduleVerifScript"] },
  { key: "module-synth", section: "module", label: "综合", bindings: ["moduleSynthFpga"] },
  { key: "module-review", section: "module", label: "审查", bindings: [], note: "按审查对象复用其他环节工具，不单设工具。" },
  { key: "project-spec", section: "project", label: "规格", bindings: ["projectSpecScript"] },
  { key: "project-integrate", section: "project", label: "集成", bindings: ["projectIntegrateCompiler", "projectIntegrateFpga"] },
  { key: "project-constraints", section: "project", label: "约束", bindings: ["projectConstraintsFpga"] },
  { key: "project-syssim", section: "project", label: "系统仿真", bindings: ["projectSyssimSimulator", "projectSyssimScript"] },
  { key: "project-impl", section: "project", label: "实现", bindings: ["projectImplFpga"] },
  { key: "project-timing", section: "project", label: "时序", bindings: ["projectTimingFpga"] },
  { key: "project-board", section: "project", label: "上板", bindings: ["projectBoardFpga"] },
  { key: "project-release", section: "project", label: "发布", bindings: ["projectReleaseFpga"] }
];
```

Create `BINDINGS` with one entry per name above. Each entry must contain `key`, `section`, `stage`, `label`, `role`, `toolKey`, `pathKey`, and the exact allowed `tools` list. Use these lists:

```js
const ROLE_TOOLS = {
  script: ["python"],
  compiler: ["verilator", "iverilog", "custom-compiler"],
  simulator: ["modelsim", "xsim", "custom-simulator"],
  fpga: ["vivado", "quartus", "custom-fpga"]
};

const bind = (key, section, stage, label, role) => ({
  key,
  section,
  stage,
  label,
  role,
  toolKey: `${key}Tool`,
  pathKey: `${key}Path`,
  tools: ROLE_TOOLS[role]
});

export const BINDINGS = [
  bind("moduleSpecScript", "module", "module-spec", "脚本工具", "script"),
  bind("moduleRtlCompiler", "module", "module-rtl", "编译 / lint 工具", "compiler"),
  bind("moduleVerifSimulator", "module", "module-verif", "仿真工具", "simulator"),
  bind("moduleVerifScript", "module", "module-verif", "参考模型 / 比对脚本工具", "script"),
  bind("moduleSynthFpga", "module", "module-synth", "综合工具", "fpga"),
  bind("projectSpecScript", "project", "project-spec", "脚本工具", "script"),
  bind("projectIntegrateCompiler", "project", "project-integrate", "编译 / elaboration 工具", "compiler"),
  bind("projectIntegrateFpga", "project", "project-integrate", "FPGA 套件", "fpga"),
  bind("projectConstraintsFpga", "project", "project-constraints", "约束工具", "fpga"),
  bind("projectSyssimSimulator", "project", "project-syssim", "系统仿真工具", "simulator"),
  bind("projectSyssimScript", "project", "project-syssim", "参考模型 / 比对脚本工具", "script"),
  bind("projectImplFpga", "project", "project-impl", "实现工具", "fpga"),
  bind("projectTimingFpga", "project", "project-timing", "时序工具", "fpga"),
  bind("projectBoardFpga", "project", "project-board", "下载 / 调试工具", "fpga"),
  bind("projectReleaseFpga", "project", "project-release", "重建 / 复核工具", "fpga")
];
```

Generate the stage selector and override fields from `BINDINGS`; selector options are `auto`, each allowed tool, then `none`. Generate/common fields so every visible field has `section`, `sectionLabel`, and `group`; stage fields additionally have `stage`, `stageLabel`, and override fields have `advanced: true` plus `bindingKey`. Keep templates/language/library fields under `section: "common"`. Promote `verilatorPath`, `modelsimPath`, and `vivadoPath` to visible common fields. Retain the old shared selectors/paths plus `python` as `control: "hidden"`, all with `default: ""`; add hidden `settingsModelVersion`.

Implement the resolver with these exact states:

```js
export function resolveBinding(values, binding, probe) {
  const selection = String(values?.[binding.toolKey] ?? "auto").trim() || "auto";
  if (selection === "auto") return { ...binding, selection, state: "auto", present: true };
  if (selection === "none") return { ...binding, selection, state: "none", present: true, unused: true };
  if (!binding.tools.includes(selection) || TOOL_CATALOG[selection] === undefined) {
    return { ...binding, selection, state: "invalid", present: false, reason: "工具选择无效" };
  }
  const tool = TOOL_CATALOG[selection];
  const override = String(values?.[binding.pathKey] ?? "").trim();
  const common = String(values?.[tool.pathKey] ?? "").trim();
  const path = override || common;
  const source = override ? "stage" : common ? "common" : undefined;
  let present = false;
  if (path !== "") {
    try { present = probe(path, tool.kind) === true; } catch { present = false; }
  }
  return {
    ...binding,
    selection,
    tool: selection,
    toolLabel: tool.nameKey && String(values?.[tool.nameKey] ?? "").trim() ? String(values[tool.nameKey]).trim() : tool.label,
    kind: tool.kind,
    path,
    source,
    configured: path !== "",
    present,
    state: present ? "ready" : "missing",
    supportNote: tool.supportNote,
    notes: tool.notesKey ? String(values?.[tool.notesKey] ?? "").trim() : ""
  };
}

export function resolveBindings(values, probe) {
  return BINDINGS.map((binding) => resolveBinding(values, binding, probe));
}
```

For stage override field inspection, use the selected tool's `kind`; for `auto`/`none`, treat the override as inactive. Plain name/note fields have no path status and no browse button metadata.

- [ ] **Step 4: Implement versioned migration, tool-specific detection, status, and prompt**

Replace the direction of the current legacy migration. The implementation must:

```js
const SETTINGS_MODEL_VERSION = "2";
const LEGACY_STAGE_TARGETS = {
  compiler: ["moduleRtlCompilerTool", "projectIntegrateCompilerTool"],
  simulator: ["moduleVerifSimulatorTool", "projectSyssimSimulatorTool"],
  synthesizer: [
    "moduleSynthFpgaTool", "projectIntegrateFpgaTool", "projectConstraintsFpgaTool",
    "projectImplFpgaTool", "projectTimingFpgaTool", "projectBoardFpgaTool", "projectReleaseFpgaTool"
  ],
  python: ["moduleSpecScriptTool", "moduleVerifScriptTool", "projectSpecScriptTool", "projectSyssimScriptTool"]
};
```

- Return `{}` immediately for version `2`.
- Preserve non-empty tool-specific and stage fields.
- Use explicit old selections first; if a shared path exists without a selection, classify recognizable basenames and otherwise use the matching custom slot.
- Use existing `verilatorPath` / `modelsimPath` / `vivadoPath` as evidence for very old installs without clearing them.
- Clear only old shared selectors/paths after copying; never clear promoted tool-specific paths or `pythonPath`.
- Set `settingsModelVersion: "2"` even when there was no legacy data.

Change `DETECT_TARGETS` so every known tool targets its own common field. Include both Icarus and Quartus, and retain XSim's directory result conversion. Detection hits carry a `tool` id rather than relying on an owning global selector.

Change `statusOf(values, probe = probeFilesystem)` to return `sections`, `stages`, and resolved `bindings`. `missing` lists only concrete/invalid binding keys; `ok` remains `true` because one unavailable capability must not disable the mode. Keep `tools` as visible `FIELDS` metadata for the client. The route continues calling it with one argument; tests inject a deterministic probe as the second argument.

Rewrite only the tool-capability part of `describeEnv()`: start with “这是能力配置，不是执行顺序，可以按任务反复切换”; list all present common tools; then list module/project stage preferences. For `auto`, say AI chooses from the registered tools; for `none`, say explicitly disabled; for concrete missing paths, explain only that binding is unavailable. Preserve the existing template, language, output-location, and bundled-command sections.

- [ ] **Step 5: Run host-side checks and the full suite GREEN**

Run:

```powershell
node tools/check-toolchain.mjs
npm test
```

Expected: both exit `0`; the toolchain check reports no `FAIL`, and the full suite reports every repository check passed. If old assertions describe shared global paths, update those assertions to the new semantic model rather than adding compatibility behavior that contradicts the spec.

- [ ] **Step 6: Commit Task 1 without user skill changes**

Stage exactly:

```powershell
git add -- lib/toolchain.js lib/index.js tools/check-toolchain.mjs
git diff --cached --name-only
git commit -m "feat(settings): add stage-scoped FPGA tool model"
```

Expected staged names: only the three files above.

---

### Task 2: Three-section settings UI and accessible question-mark help

**Files:**
- Modify: `lib/client.js`
- Modify: `tools/check-load-contract.mjs`
- Modify: `tools/check-toolchain.mjs`

**Interfaces:**
- Consumes: Task 1 status payload `sections`, `stages`, `tools`, and `bindings`.
- Consumes: field metadata `section`, `group`, `stage`, `advanced`, and `bindingKey`.
- Produces: metadata-driven section/stage cards; no hardcoded setting keys in the client.
- Preserves: one atomic save, draft/revert behavior, status preview, browse panel, detection auto-fill, theme handling, and request generation guards.

- [ ] **Step 1: Update the fake status payload and write failing UI assertions**

In `tools/check-load-contract.mjs`, replace the global compiler fixture with a minimal metadata-driven payload containing:

```js
const hostValues = {
  verilatorPath: "C:\\tools\\verilator_bin.exe",
  moduleRtlCompilerTool: "verilator",
  moduleRtlCompilerPath: "",
  projectImplFpgaTool: "auto",
  modelsimIniPath: "C:\\modelsim\\modelsim.ini"
};

const payload = {
  sections: [
    { key: "common", label: "通用工具", hint: "登记本机工具" },
    { key: "module", label: "模块工具", hint: "不是流水线" },
    { key: "project", label: "工程工具", hint: "分别设置" }
  ],
  stages: [
    { key: "module-rtl", section: "module", label: "RTL", bindings: ["moduleRtlCompiler"] },
    { key: "module-review", section: "module", label: "审查", bindings: [], note: "复用相关环节工具" },
    { key: "project-impl", section: "project", label: "实现", bindings: ["projectImplFpga"] }
  ],
  tools: [
    { key: "verilatorPath", label: "Verilator", hint: "填写 verilator_bin.exe", section: "common", sectionLabel: "通用工具", group: "编译工具", control: "text", kind: "file", path: "C:\\tools\\verilator_bin.exe", configured: true, present: true, detectable: true },
    { key: "moduleRtlCompilerTool", label: "编译 / lint 工具", hint: "该环节首选工具", section: "module", sectionLabel: "模块工具", stage: "module-rtl", stageLabel: "RTL", group: "RTL", control: "select", path: "verilator", configured: true, present: true, default: "auto", options: [{ value: "auto", label: "由 AI 根据任务判断" }, { value: "verilator", label: "Verilator" }, { value: "none", label: "不用" }] },
    { key: "moduleRtlCompilerPath", label: "本环节覆盖路径", hint: "留空使用通用路径", section: "module", sectionLabel: "模块工具", stage: "module-rtl", stageLabel: "RTL", group: "RTL", control: "text", kind: "file", path: "", configured: false, present: false, advanced: true, bindingKey: "moduleRtlCompiler", blankNote: "留空使用通用路径" },
    { key: "projectImplFpgaTool", label: "实现工具", hint: "该环节首选 FPGA 套件", section: "project", sectionLabel: "工程工具", stage: "project-impl", stageLabel: "实现", group: "实现", control: "select", path: "auto", configured: true, present: true, default: "auto", options: [{ value: "auto", label: "由 AI 根据任务判断" }, { value: "vivado", label: "Vivado" }, { value: "none", label: "不用" }] },
    { key: "legacyCompiler", label: "旧键", hint: "不显示", section: "common", group: "旧键", control: "hidden", path: "", configured: false, present: false }
  ],
  bindings: [
    { key: "moduleRtlCompiler", section: "module", stage: "module-rtl", label: "编译 / lint 工具", selection: "verilator", toolLabel: "Verilator", state: "ready", source: "common", path: "C:\\tools\\verilator_bin.exe", present: true },
    { key: "projectImplFpga", section: "project", stage: "project-impl", label: "实现工具", selection: "auto", state: "auto", present: true }
  ],
  missing: [],
  ok: true
};

let detectPayload = {
  found: [
    { field: "verilatorPath", tool: "verilator", label: "Verilator", path: "C:\\tools\\verilator_bin.exe", source: "known" }
  ]
};

const previewAnswer = (fieldKey, fieldOverrides, bindingKey, bindingOverrides = {}) => ({
  ...payload,
  tools: payload.tools.map((field) => field.key === fieldKey ? { ...field, ...fieldOverrides } : field),
  bindings: payload.bindings.map((binding) => binding.key === bindingKey ? { ...binding, ...bindingOverrides } : binding)
});
```

Add assertions:

```js
const rendered = JSON.stringify(secondTree ?? {});
for (const expected of ["通用工具", "模块工具", "工程工具", "RTL", "审查", "实现", "Verilator", "来自通用路径"]) {
  check(rendered.includes(expected), `三层设置界面出现「${expected}」`);
}
const help = findByProp(secondTree, (props) => props.className === "fpga-set-help");
check(help?.type === "button" && help.children?.[0] === "?", "字段说明以可聚焦的问号按钮显示");
check(findByProp(help, (props) => props.role === "tooltip") !== undefined, "问号说明使用 tooltip 语义");
check(typeof help?.props?.["aria-describedby"] === "string", "问号可通过键盘聚焦读取说明");
check(rendered.includes("填写 verilator_bin.exe"), "完整说明仍存在于 tooltip 中");
check(!rendered.includes("当前阶段") && !rendered.includes("下一阶段") && !rendered.includes("完成百分比"), "界面不引入流水线状态");

const overrideBefore = findByProp(secondTree, (props) => props.key === "moduleRtlCompilerPath");
check(overrideBefore !== undefined, "显式工具时显示环节覆盖路径");
findByProp(secondTree, (props) => props.key === "moduleRtlCompilerTool").children.find((node) => node?.type === "select").props.onChange({ target: { value: "auto" } });
fake.reset();
const autoTree = captured();
check(findByProp(autoTree, (props) => props.key === "moduleRtlCompilerPath") === undefined, "auto 时隐藏无意义的路径覆盖框");
check(hostValues.verilatorPath === "C:\\tools\\verilator_bin.exe", "换环节选择不清空通用路径");
```

Retain the existing tests for atomic save, discard, browse, late preview/detect/browse responses, and theme detection. Change their fixture keys to metadata keys instead of hardcoded `compilerPath` assumptions.

In `tools/check-toolchain.mjs`, replace the old static requirement that `changeTool()` force-clears a shared path with these source-contract assertions:

```js
check(clientSource.includes("status?.sections") && clientSource.includes("status?.stages"), "客户端按宿主布局渲染三层设置");
check(clientSource.includes("field.section") && clientSource.includes("field.stage"), "字段归属完全来自宿主元数据");
check(!clientSource.includes("force.includes(entry.key)"), "切换环节工具不再强制清空路径");
check(clientSource.includes('role: "tooltip"') && clientSource.includes('"aria-describedby"'), "长说明通过可访问问号提示显示");
```

- [ ] **Step 2: Run client checks and verify RED**

Run:

```powershell
node tools/check-load-contract.mjs
```

Expected: FAIL because the current client renders only flat `group` headers, displays `field.hint` permanently, force-clears a shared path on tool changes, and does not understand the `sections/stages/bindings` payload.

- [ ] **Step 3: Implement nested layout, binding badges, and non-destructive stage choices**

In `lib/client.js`:

1. Store the whole preview response, not only `data.tools`, so unsaved choices can preview both fields and bindings.
2. Remove `changeTool()` and its forced detection/clear behavior. Every selector calls `stage(field.key, next)` only.
3. Restrict auto-detection to common fields with `detectable === true`; do not filter by a global selected option and never target stage override fields.
4. Change `renderFields()` to iterate `status.sections`, then common subgroups or `status.stages` for module/project. Render empty stages such as module review from stage metadata.
5. Pass the matching resolved binding records into each stage card and render one short visible state:

```js
function bindingBadge(binding) {
  if (binding?.state === "auto") return "由 AI 根据当前任务判断";
  if (binding?.state === "none") return "明确不用";
  if (binding?.state === "ready") return `${binding.toolLabel} · ${binding.source === "stage" ? "本环节覆盖路径" : "来自通用路径"}`;
  if (binding?.state === "invalid") return "工具选择无效";
  return binding?.path ? "路径不可用" : "尚未配置路径";
}
```

6. Hide `advanced` override fields when their binding selector is `auto` or `none`; do not delete the stored override when hidden.
7. Render `textarea` for custom notes; plain name/note fields have no browse button or path-ready badge.
8. Change the field-row root from a wrapping `<label>` to a `<div>` before adding the help button, and give each input/select/textarea `aria-label: field.label`; this avoids nesting an interactive help button inside a label.

- [ ] **Step 4: Implement accessible question-mark help and compact styling**

Replace the permanent field hint row with:

```js
function helpBubble(key, text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const id = `fpga-help-${String(key)}`;
  return h(
    "button",
    {
      type: "button",
      className: "fpga-set-help",
      "aria-label": "查看说明",
      "aria-describedby": id
    },
    "?",
    h("span", { id, className: "fpga-set-tooltip", role: "tooltip" }, text)
  );
}
```

Use it beside field, section, and stage labels. Add CSS that keeps the tooltip hidden until hover/focus and keeps it above surrounding cards:

```css
.fpga-set-help { position: relative; width: 18px; height: 18px; padding: 0; border-radius: 50%; border: 1px solid currentColor; background: transparent; color: inherit; opacity: .58; font: inherit; font-size: 11px; line-height: 16px; cursor: help; }
.fpga-set-help:hover, .fpga-set-help:focus-visible { opacity: 1; outline: none; }
.fpga-set-tooltip { display: none; position: absolute; z-index: 20; left: 22px; top: -6px; width: min(340px, 70vw); padding: 8px 10px; border: 1px solid var(--dsh-border, rgba(128,128,128,.3)); border-radius: 6px; background: var(--fpga-set-field-bg); color: inherit; box-shadow: 0 6px 20px rgba(0,0,0,.2); text-align: left; line-height: 1.5; white-space: normal; }
.fpga-set-help:hover .fpga-set-tooltip, .fpga-set-help:focus .fpga-set-tooltip, .fpga-set-help:focus-visible .fpga-set-tooltip { display: block; }
```

Keep these visible outside tooltips: ready/missing state, invalid path, `none`, unsaved marker, save failure, detection failure, and preset synchronization failure.

- [ ] **Step 5: Run client and full-suite GREEN**

Run:

```powershell
node tools/check-load-contract.mjs
node tools/check-toolchain.mjs
npm test
```

Expected: all exit `0`, no `FAIL` output. The fake React rendering must include all three sections, stage cards, keyboard-readable tooltips, inline status, and a save footer after the final field/card.

- [ ] **Step 6: Commit Task 2 without user skill changes**

Stage exactly:

```powershell
git add -- lib/client.js tools/check-load-contract.mjs tools/check-toolchain.mjs
git diff --cached --name-only
git commit -m "feat(settings): render tools by module and project stage"
```

Expected staged names: only the three files above.

---

### Task 3: Settings documentation, regression simulation, and restart handoff

**Files:**
- Modify: `README.md`
- Modify: `docs/CLIENT_CHECKLIST.md`
- Test: `tools/check-toolchain.mjs`

**Interfaces:**
- Consumes: Task 1 schema and Task 2 UI behavior.
- Produces: user-facing instructions that match the shipped settings page and a restart checklist for DSH Desktop 2.0.13.
- Does not produce or change any skill behavior.

- [ ] **Step 1: Add failing documentation-contract assertions**

In `tools/check-toolchain.mjs`, read `README.md` and `docs/CLIENT_CHECKLIST.md` and add:

```js
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
check(readme.includes("通用工具") && readme.includes("模块工具") && readme.includes("工程工具"), "README 说明设置页三个顶层区");
check(readme.includes("不是流水线") && readme.includes("自动判断"), "README 说明环节可反复切换与 auto 语义");
check(readme.includes("环节覆盖") && readme.includes("通用路径"), "README 说明路径优先级");

const clientChecklist = readFileSync(new URL("../docs/CLIENT_CHECKLIST.md", import.meta.url), "utf8");
check(clientChecklist.includes("问号") && clientChecklist.includes("键盘"), "人工检查表覆盖悬浮与键盘说明");
check(clientChecklist.includes("Verilator") && clientChecklist.includes("Icarus"), "人工检查表覆盖同类工具路径互不覆盖");
```

- [ ] **Step 2: Run documentation contract and verify RED**

Run:

```powershell
node tools/check-toolchain.mjs
```

Expected: FAIL only on the new README/checklist assertions because existing documentation still describes three global required paths and detection on tool switching.

- [ ] **Step 3: Update only settings documentation**

In `README.md`:

- Replace the “three required paths” overview with the three-section model.
- Document `auto`, explicit tool, `none`, and “stage override > common path”.
- State that stage settings are preferences/capabilities, not a pipeline.
- State that common-tool detection runs independently and changing a stage selector never overwrites a common path.
- Mention the question-mark help and that warnings remain inline.

In `docs/CLIENT_CHECKLIST.md`, add restart/manual checks:

1. Open Settings → FPGA 开发模式 and confirm exactly three top-level sections.
2. Configure Verilator and Icarus simultaneously, change the module RTL preference twice, save/reopen, and confirm both common paths remain.
3. Set a stage override, save/reopen, and confirm the stage badge says the path comes from the override; clear it and confirm common fallback.
4. Confirm `auto` and `none` display different states and neither is presented as a pipeline step.
5. Hover a `?`, then focus it with Tab, and confirm the same explanation is visible; confirm an invalid path warning remains visible without opening the tooltip.
6. Start a new FPGA-mode conversation and confirm the environment prompt says the configuration is not an execution order and lists the selected stage preference.

Do not edit `HANDOFF.md` historical entries or any skill documentation in this task.

- [ ] **Step 4: Run fresh repository verification and simulated UI checks**

Run:

```powershell
node tools/check-toolchain.mjs
node tools/check-load-contract.mjs
npm test
npm run test:safety
git diff --check
```

Expected: every command exits `0`; no check prints `FAIL`; `git diff --check` prints nothing. `check-load-contract` is the self-contained DSH-client simulation: it loads the bundle, renders twice with fake settings services, exercises detection/browse/save/preview races, and inspects the resulting tree.

- [ ] **Step 5: Review the settings-only diff and commit**

Run:

```powershell
git diff --name-only HEAD
git diff --stat HEAD
```

Expected: only `lib/toolchain.js`, `lib/index.js`, `lib/client.js`, `tools/check-toolchain.mjs`, `tools/check-load-contract.mjs`, `README.md`, `docs/CLIENT_CHECKLIST.md`, and the already-approved spec/plan documentation appear as this work's files. Existing dirty `presets/**/skills/**` paths remain unstaged and untouched.

Stage and commit exactly the Task 3 files:

```powershell
git add -- README.md docs/CLIENT_CHECKLIST.md
git diff --cached --name-only
git commit -m "docs(settings): explain stage-scoped tool configuration"
```

- [ ] **Step 6: Prepare the restart handoff**

Report the fresh `npm test` and `npm run test:safety` results, the commits, and the exact changed settings files. Tell the user the repository-side simulation is complete and ask them to restart DSH Desktop 2.0.13, then follow `docs/CLIENT_CHECKLIST.md`. Do not claim installed-profile validation because this plan deliberately does not run sync/install commands.
