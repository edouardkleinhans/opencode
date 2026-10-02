# OpenCode: implementation and release plan

Updated: 2026-10-02. This is the single shared plan for this work, tracked in Git.
Only open tasks appear as checkboxes; close them with concrete evidence and keep
the remaining list current instead of accumulating historical plans.

## Assist setup improvements — beta 3.2.0b1 release

- Worktree: `feat/assist-setup`, based on published 3.2.0b0/main `7b92996`.
- User authorized consolidating all outstanding work on `main`, committing and
  pushing it, and publishing **3.2.0b1**. Include the previously retained Lemonade
  guidance and contributor credits; older native-integration edits are already
  represented by the published b0 implementation.
- [ ] Pass main CI/native amd64+arm64 checks, publish both final images, then tag
  `beta-v3.2.0b1` and verify the release, companion ZIP and storefront update.
- One canonical companion source now lives in
  `ha_opencode_beta/rootfs/opt/opencode-assist/custom_components/opencode_assist`.
  The image's normal rootfs copy and the release ZIP both use it; no runtime
  download is needed. Companion version is `0.1.0b2`.
- `ha_assist_enabled` stays off by default. When enabled, the supervised worker
  installs before starting. Atomic directory rename/exchange, per-file ownership
  hashes and an install lock preserve manual/edited copies and fail closed on
  conflicts, links or unsupported atomic operations. Disabling leaves files.
- Installation logs and the pairing UI prompt for a **Home Assistant Core**
  restart after changes, distinguish it from an app restart, and explain the
  interruption. No automatic Core restart or automatic pairing is implemented.
- Both Ingress modes have a touch-sized **Set up OpenCode Assist** link in a
  reserved top bar. Same-frame navigation preserves the current Ingress session.
  The existing admin, CSRF, one-time key and revocation boundaries remain.
- Verification: 269 beta runtime tests passed / 3 environment skips, including
  8 filesystem installer cases through the Node runner and rendered mobile
  Chromium navigation/layout checks in both modes. All 6 actual HA 2026.10.0b0
  companion/transport contracts passed. Stable proxy regression suite: 20 passed
  when run alone (one IPv6 fixture assertion failed in a concurrent combined-
  channel run, then passed standalone; stable forwarding is unchanged).
- Native amd64 boundary image `opencode-beta:assist-setup-local` passed the
  existing boundary checks, all 8 installer cases and 4 Assist adapter/pairing
  tests. Image config:
  `sha256:82e406aab3f903dd4921104d129ba87d0e9ae604f1391e9f5e19be160e44121b`.
  All 12 companion files inside the image match the generated release ZIP
  byte-for-byte (ZIP SHA256
  `b390eca7c2bf30d881f57f2cfd7e5aeb9150b5ae98e45135ed05c56867e1ff79`).
- WebKit **26.6** / Playwright **1.63.0** also passed iPhone-sized iframe
  navigation, pairing POST, readable-key layout and return in both proxy modes.
  Tests use simulated Core metadata and representative app-layout fixtures with
  the real pairing worker; Chromium checks are wired into PR CI. Screenshots:
  `/tmp/opencode/assist-setup-artifacts/screenshots/`.
- [ ] Verify on a physical iOS HA app and supervised HA installation. Browser
  device emulation is not evidence of the native iOS app or a real HA restart.

## HA native integration beta — issue #45

- User direction: begin implementation for a new beta **based on current stable**.
  Baseline: stable **3.1.0**, `b9ea92f`, released 2026-09-30. Work in
  `ha_opencode_beta`; preserve its slug, image, app data and decision-note paths.
- Published **3.2.0b0**, an experimental first beta with the limits below
  documented, at `beta-v3.2.0b0` / `d48ac91740b510d9c70e997fd30910865a198c63`.
  Release workflow `36926495259` passed; storefront commit `24fa5b8` advertises
  beta `3.2.0b0`. Stable remains `3.1.0`.
  CLI/plugin stay at stable's **2.0.13**; OpenChamber stays at the stable pin.
- Source contract: HA **2026.10.0b0** (`64ed916d9c22640b8d41b403fda0f7ed4d4c0bd5`).
  `llm/api/list` also exists in 2026.9; endpoint probes retain older-HA support.
- Implemented: stable runtime/test baseline adoption; read-only registered
  API discovery via Supervisor WebSocket; saved-ID diagnostics in the capability
  tool/resource; separate registry versus endpoint evidence; updated native-LLM
  guide and access-model documentation. Discovery does not mutate selection.
- Native context integration: initialization guidance preserves HA instructions;
  prompts/resources stay on demand. Schema compatibility repair is limited to
  legacy unprefixed GetLiveContext, preserving modern/custom schemas and metadata.
  A real pinned 2.0.13 process exercises production MCP registration and forwarding
  against synthetic HA/provider fixtures: prompt command consumption, resource
  discovery, fresh context tool results, required fields, errors and the managed
  read-only agent's deny policy. The fixture substitutes the FFI credential broker
  and HTTP listener; existing boundary tests cover those separately.
  Bridge tests additionally cover snapshot reads/refresh, cancellation, custom
  prompt names, metadata and older servers without prompt/resource capabilities.
- Native companion in `custom_components/opencode_assist`:
  versioned config/reauth/reconfigure and subentry flows, dynamic HA API/model
  choices (no API selected by default), ConversationEntity, text/validated-JSON
  AI Task entity, unload/removal cleanup and redacted diagnostics. Enable the
  beta's `ha_assist_enabled` option and pair via administrator-only Ingress.
- Pinned 2.0.13 adapter proof: request-specific tool registration and history,
  streaming, exact arguments (including schema patterns), concurrent conversation
  isolation, cross-request result rejection, revocation and cancellation. The
  scoped HTTP facade rejects administrative paths, caller agent overrides and
  file-bearing history. Pairing credentials are digest-only in a separate store;
  ordinary cleanup removes the disposable session. A crash can leave an orphaned
  session; the private agent fails closed without an active request, and no
  secure-erasure claim is made for underlying databases/provider logs.
- Official HA **2026.10.0b0** image (`sha256:8d51a81b654093b81d90501d7f8969f634e2f77e6fc5f1cbe52031f8e2726fd9`):
  **6 contract tests passed**, using actual ChatLog, LLMContext, config-flow and
  AI Task classes. `node scripts/test-ha-assist-core.mjs` additionally joins the
  real pinned OpenCode process to HA's HTTP client/ChatLog: original caller
  context reaches HA tools, follow-up tool history survives, and client shutdown
  cancels pending HA tool execution. HTTP/provider fixtures replace real devices
  and model accounts; this is not supervised installation/voice-pipeline evidence.
  PR CI runs this suite; native image CI includes the adapter/pairing fixtures.
- Beta release preparation includes a deterministic `opencode-assist.zip` asset;
  the tag/storefront guard also checks the companion and packaging script. The
  release workflow publishes it only when a reviewed beta tag is pushed.
  Published companion **0.1.0b1**: release asset `opencode-assist.zip` matches
  the deterministic local package byte-for-byte; SHA256
  `e7ea4aa86aa9450d56484493bd269165ba5bfc6a866ec8d11a247d1d87c2bf1e`.
- Native **amd64 boundary-test image passed** with Node **24.15.0** and OpenCode
  **2.0.13**, including all four Assist adapter/pairing tests, the existing native
  credential/policy/provider/LAN/Zigbee boundary checks and forward migration.
  Local test image `opencode-beta:ha-assist-local`, image config
  `sha256:13efe92f3bdb691f35da4cba50c72d1604cf45676301404ad0cafd99f14e767f`.
  This is a boundary-test build, not a published final image or supervised run.
  The host initially lacked Buildx; a checksum-verified **0.37.2** client under
  `/tmp/opencode/ha-build-docker` enabled the successful BuildKit build.
- Local verification (Linux, Node 24.21.0): MCP suite **642 passed / 4 skipped**;
  beta runtime contracts **262 passed / 3 skipped** in the clean release worktree;
  HA-facing discovery/lifecycle
  **19 passed**. Skips require browser/editor dependencies or root-only fixtures.
  Channel separation **10 passed**; beta startup-hook security, per-channel option
  declarations, CLI/plugin pin verification and diff whitespace checks passed.
  All three generated Python starters parse (syntax only). Controlled HTTP/WS
  fixtures exercise the shipped MCP process; these host suites are not live HA
  evidence. The separate amd64 image evidence above uses the exact Node pin.

### Release execution and remaining qualification

- Release preparation uses a separate `release/3.2.0b0` worktree based on current
  main `611ee9f`, retaining stable 3.1.0 pins and adopting main's reviewed
  brace-expansion security fix. Pre-existing contributor/Lemonade documentation
  edits remain in the original worktree.
- PR **#148** merged after all eight checks passed: PR contracts `36924516475`
  and native amd64/arm64 boundary checks `36924516462`. Main contracts
  `36925216725` and native checks `36925216618` also passed.
- Both native final images and the multi-architecture manifest were published by
  workflow `36925231523` **before** pushing the release tag. Registry inspection
  confirmed `linux/amd64` and `linux/arm64`; publication and companion download
  succeeded, and the only storefront diff from the tag is the beta version.
- Tag-triggered build/publication `36926495368` passed both native boundaries
  and final builds. The release includes `container-images.md`,
  `image-manifest.txt` and `opencode-assist.zip`; the manifest asset agrees with
  the final registry index
  `sha256:3935c453b6bd15d5a26c2a3cd2f3c018fd14242f372afdb584968a19f72d5537`.
  Platform manifests: amd64
  `sha256:bdfa1034828fa185510a609a303cbc725d5e58106d8434c3d7cc1bac084afb5e`;
  arm64 `sha256:a794a4ab289c32c982f173b36ec53e18e6e90e04ddaf1b2720795c170c035a13`.
  Release: https://github.com/magnusoverli/opencode/releases/tag/beta-v3.2.0b0.

The user authorized publication as an experimental beta. The following remain
explicit qualification/follow-up work, rather than claims of completed support:

- [ ] Qualify both MCP directions on real HA 2026.10: discovery/confirmation,
  authentication/reauthentication, restart/removal, stable+beta coexistence,
  selected native catalog and a bounded read-only call. Record exact versions.
- [ ] Qualify UI resource reading on the shipped clients; the pinned-runtime model
  path currently uses the native live-context tool, with resource discovery tested.
  Inspection of the built pinned OpenChamber UI source found only an
  `mcp.resources.changed` event handler and no resource-read/list invocation; a
  rendered-resource workflow is not yet established for this client pin.
- [ ] Expose discovered API choices in setup UI; keep Supervisor options as the
  supported saved configuration, with no silent change to broader APIs.
- [ ] Qualify companion installation/config/subentry/reauth/reconfigure/removal
  flows through a real supervised HA UI, then an Assist pipeline and AI Task
  service with a compatible account-backed model. Verify caller/exposure behavior
  for the built-in Assist API; selected custom APIs retain their own boundaries.
- [ ] Qualify restart/crash recovery, inspect temporary-session retention and
  decide whether a narrowly marked orphan cleanup is needed. The first
  experimental release documents this limitation with the adapter disabled by default.
- [ ] Requalify the separately installed companion against the final HA 2026.10
  release and test installation from the packaged beta ZIP.
- [ ] Complete supervised release acceptance before claiming fully qualified
  native integration support. Native image checks/publication are tracked above.

The sections below preserve the earlier stable-release record.

## Stable 3.0.0 promotion — 2026-09-23

- **Published:** `v3.0.0` at `3ccd803f67ec070f4a42b23757bae72bff7280d2`
  (adoption `8ef709a`, release-link correction `3ccd803`); storefront `8f66fa2`
  advertises stable `3.0.0`. Beta remains `3.0.0b22`.
- Repository CI `35875611963`, native stable image checks `35875460284`, initial
  publication `35875472577`, release `35876412293` and final tag publication
  `35876412229` passed. Both native release builds ran the V2 boundary fixture.
- Release assets `container-images.md` and `image-manifest.txt` are attached;
  the manifest attachment agrees with the registry's final index
  `sha256:8324ebe345b4cbfdaaad27efe071f9e0f549145e27e49345a978248439e9b45b`.
  Platform manifests: amd64
  `sha256:c066452dbbe0dcbd7aff5efd770c10e027f4f9b93ec9c47327edf2d1949a5cb1`, arm64
  `sha256:4b075537d434062bc6bee06cbc73d0498d02c53fe5cbbc5d78aaafb3d0e4646f`.
- User explicitly ended the broad acceptance campaign and authorized stable
  publication from final beta b22. The earlier gate table below is historical;
  unperformed HAOS/soak/account checks remain unperformed, not implicitly passed.
- Adopt b22 runtime, protected migration, integration workers, UI patches and
  tests into the stable folder. Preserve stable slug/image, `/data`, notes,
  startup-hook paths and existing stable changelog history. Beta stays separate.
- Stable release notes consolidate the user-visible changes since 2.5.6. The
  upgrade guide covers backup/recovery, provider reauthentication, LAN/custom
  config changes, upstream preview status and unresolved custom-skill discovery.
- Retire V1-only helpers and the SIGHUP-based terminal quit overlay rather than
  applying its process-control assumptions to V2. The guide records this change.
- Stable CI adopts the V2 contracts and target-native boundary stage. Publication
  completed after repository checks and native amd64/arm64 stable image builds.

## Starting point

- Implementation baseline: `cbe9cfe`, released as beta `3.0.0b20`; storefront
  version commit `398617e` is on `main`. Includes the I1/I3/I5/I8 work below and
  CI fixture corrections, retaining b19's Ingress session-creation fix.
- Published releases: beta `3.0.0b20`, stable `2.5.6`. Stable still uses V1.
  b20 is a qualification beta, not stable promotion.
- Pins: OpenCode CLI/plugin `2.0.13`, Node `24.15.0`, Prettier `3.9.8`.
  OpenChamber preview `2.0.0-preview.8` is built from commit
  `9fba129ddf968df1e5fb6916b84d3ceb35493198` and its lockfile, independently of
  the backend pin. Its upstream web package reports `1.24.2`.
- Already implemented: one managed V2 backend, non-starting CLI diagnostics,
  credential-isolated agent LSP tools, modern YAML completion fixes, native YAML
  formatting, forward-generation cleanup, and the OpenChamber preview connection.
  Initial amd64 devcontainer, browser Ingress, upgrade-preservation and independent
  UI/backend lifecycle checks passed. b19 CI, native amd64/arm64 boundary builds
  and multi-architecture image publication passed. Full ARM UI/HAOS qualification
  remains open.

## Fixed decisions

- Develop in `ha_opencode_beta`; adopt into `ha_opencode` through a reviewed change.
  Preserve each channel's slug, image identity, data volume and user customizations.
- Ship one pinned V2 runtime. No V1 executable, runtime selector, automatic runtime
  fallback, downgrade path or retained rollback generations. Preserve one-way
  imports, validated atomic forward upgrades and ordinary Home Assistant backups.
- Keep `opencode2` as a compatibility alias throughout 3.x. It must execute the
  same managed V2 client as `opencode`, never select or start another runtime.
- **Update ownership (2026-09-23):** Home Assistant Supervisor is the sole supported
  updater for the app and its packaged OpenCode/OpenChamber components. Do not add
  a custom app updater or enable independent in-container component upgrades.
  Retain the controls needed to preserve the pinned runtime, matching plugins,
  managed backend and forward-upgrade contract; prefer minimal customization.
- Failed migration must preserve its input and report the failure, never silently
  start another runtime or replace populated state with an empty installation.
- All interfaces use the authenticated s6-owned backend at `127.0.0.1:4100`.
  Keep Supervisor credentials in integration workers and managed backend
  credentials out of model/shell environments, arguments and logs.
- Native `lsp: false` is intentional: `homeassistant.lsp` supplies the agent tools.
  Filesystem snapshots remain disabled by resource policy. Neither flag is itself
  an outstanding defect to fix by simply enabling it.
- **Accepted free-tier limitation (2026-09-23):** `opencode/big-pickle` works with
  the normal Build agent, verified through OpenChamber Ingress and a direct API
  control. The same provider/model still rejects `home-assistant-read-only` with
  "OpenCode's free tier can only be used from within OpenCode". Respect and
  document the restriction; it is not a remediation task or release blocker.
  Use a compatible provider/model for read-only acceptance without weakening the
  agent's permissions. This evidence does not certify every free model.

## Stable-promotion critical path

Release completed (2026-09-23): `beta-v3.0.0b21` tags implementation commit
`a2540752ea69f783650f66dc1d87307b384ac4e9`. PR Checks `35848521142` and native
amd64/arm64 image checks `35848521155` passed. Build/publication `35849088283`
passed before tag push; Create Beta Release `35862139707` then published the
prerelease and storefront commit `a1c9105`. Tag build `35862139570` also passed
both native boundary fixtures and publication, attaching `container-images.md`
and `image-manifest.txt`. Verified final multi-architecture image index:
`sha256:e3f1303b8be4b8560500f91f9d34a608f10a51cf4444b31ea18fe09f771c25cb`.
Stable remains `2.5.6`. Real HAOS beta acceptance contributes to the gates below;
it does not automatically qualify a separately adopted stable-channel image.

Scope directive (2026-09-23): focus solely on promotion to stable `3.0.0`.
Use the gates below to prioritize the detailed work items. Add implementation
only to restore supported behavior or correct a demonstrated release blocker.

| Gate | Required result | Relevant work |
| --- | --- | --- |
| 1. Supported configuration works | Finish authenticated LAN access and verify the implemented provider/PPQ options under supervision. Invalid settings fail visibly; credentials stay isolated; all clients use the existing backend. | I3, I4; I5 only where packaging/startup is affected |
| 2. Existing users can upgrade and recover | Representative stable/earlier-beta upgrades and a real HA backup/restore preserve sessions, supported credentials, permissions and customizations. Failed conversion preserves input and can be retried. | V3, V4 |
| 3. Core workflows are reliable | Verify chat/streaming/reconnect, permissions, approved configuration edit/format/validate/reload, MCP concurrency, editor/worker recovery and session resume on the candidate. Use representative supported provider/auth flows. | V1, V2, V5, V6 |
| 4. The actual stable candidate is qualified | Review stable-channel adoption; pass native amd64/arm64 builds and supervised acceptance; complete the planned seven-day HAOS soak on both architectures with no blocking defects. | I6, V8, V9 |
| 5. Release artifacts agree | Publish the approved stable images and matching version, release notes and storefront metadata, with Supervisor retaining sole update ownership. | I7 |

- **I4 implementation and supervised amd64 acceptance passed.** Continue with
  representative upgrade/provider qualification; native ARM and final stable
  candidate testing remain required. Do not add unrelated remote-access features.
- **Next acceptance priority: V4.** Upgrade and backup/restore safety is required
  before asking existing stable users to move from V1 to V2.
- Freeze the candidate after release-blocking changes. A subsequent fix requires
  relevant requalification; earlier-image evidence is not exact-candidate evidence.
- D1–D4, exhaustive V7 hardware/tool permutations and cosmetic/dead-code cleanup
  are not independent reasons to delay promotion. Reopen them on the critical
  path only for a reproduced defect in a supported release workflow, a security
  or data-loss concern, or a misleading release claim. Keep unsupported or
  unqualified capabilities explicit in the release documentation.
- Account-dependent checks and access to amd64/arm64 HAOS installations are
  concrete external prerequisites. Report missing access directly; do not replace
  those results with more mock tests or silently mark them passed.

## 1. Implementation work

- **I1 — OpenChamber editor LSP implemented and live-rendered acceptance passed.** Connect the editor's diagnostics and
  autocomplete to the credential-isolated HA language server. Agent-facing
  `ha_yaml_*` tools already exist. Preserve sensitive-file, cancellation and
  read-only boundaries; prove actual editor suggestions and diagnostic refresh.
  Security prerequisite (2026-09-23 working tree): include diagnostics/definitions
  now reject outside-workspace and sensitive targets before filesystem access,
  use anchored no-follow metadata checks, and never probe `!secret` locations.
  LSP tests passed all 87 checks on Linux amd64/Node `24.15.0` in the official
  devcontainer, including real anchored symlink checks. The source patch, bounded
  HTTP bridge and CodeMirror lifecycle implementation are integrated; 28 focused
  Windows checks passed; the shared LSP client's four Linux checks also passed.
  Rendered acceptance now has opt-in `HA_EDITOR_LSP_ACCEPTANCE=live|unavailable`
  scenarios using the built FilesView, in-memory file fixtures and real Core
  Ingress via a localhost browser origin (no forged fetch metadata). Ingress checks
  validate the original Origin/Host before normalizing the internal editor hop;
  mandatory browser same-origin fetch metadata proves the external scheme;
  forwarded-header claims and LAN mode cannot authorize this route. Plain-HTTP
  LAN origins that omit fetch metadata fail closed (HTTPS/localhost supported).
  CI now installs isolated editor test dependencies and runs strict type/lifecycle
  checks plus the native provider-loader test as root. On candidate `f0dc73098e72…`,
  real Core Ingress acceptance passed rendered entity/service completion,
  corrected unsaved-draft diagnostics, controlled HTTP-503 recovery and a read-only
  FilesView with no LSP dispatch or writes. Remaining stopped-worker, resource and
  platform qualification is tracked in V2/V8/V9 rather than as missing integration.
- [ ] **I3 — Provider/configuration parity.** Implement native custom-provider
  and PPQ wiring, validated raw `opencode_config`, and remaining supported user
  environment settings. Preserve reserved credential/policy variables. Verify
  selected requests reach the intended provider/proxy and invalid/missing-key
  configurations have actionable outcomes. Until wired, saved raw config and the
  PPQ proxy option must continue to report their limitations honestly.
  Bounded implementation (2026-09-23 working tree): pinned native V2 schema
  validates supported raw fields; custom-provider keys and managed PPQ models
  are wired. Controlled V2 `2.0.13` requests verified endpoint/model selection,
  environment-key authentication and PPQ loopback routing without logging fixture
  keys. Initial focused checks passed 85 tests on Node `24.15.0` with one native
  Linux-loader skip. Security review's missing-provider-env issue is fixed, and
  the native loader's compile/execute boundary test now passes as Linux root in
  the official devcontainer (Node `24.15.0`). Final documentation/runtime/state
  integration checks passed 46/46 on Windows. Remaining: other environment
  settings, full native startup, real accounts and actual PPQ upstream acceptance.
  Follow-up (2026-09-23, after b20): added the documented `websearch` selection
  (`exa`, `firecrawl`, `parallel`, `tavily`, `random`, or disabled) to the validated
  native subset. The pinned schema accepts extensible search IDs, so the app also
  checks the shipped provider list explicitly. Search API keys remain separately
  staged; managed permissions and reserved variables are unchanged. Focused
  provider/docs/runtime/state checks passed 80/80 on Node `24.15.0`; the standalone
  controlled provider/PPQ request fixture also passed. Linux root loader coverage
  passed for all four search keys. The extended native boundary fixture passed
  first against the existing amd64 image with the changed validator mounted read-only,
  then in the rebuilt working-tree boundary-test image:
  generated config -> secured environment -> native launcher -> authenticated
  model request, with `websearch:false` absent from model tools. This is component
  evidence, not supervised option/restart, real-search, ARM or HAOS acceptance.
- **I4 — Authenticated LAN access implemented; supervised amd64 acceptance passed.** Implement remote V2 client attachment,
  CORS and OpenChamber LAN access against the existing managed backend. Test
  authentication, allowed and
  rejected browser origins, client attachment and service ownership.
  Source-grounded design is available: retain loopback backend/UI and use the
  existing LAN service slots as authenticated frontends with a separate LAN
  credential (never distribute the internal backend credential). User-approved
  design (2026-09-23): require HTTPS termination at a reverse proxy and use native
  OpenChamber login; when LAN mode is enabled, the extra OpenChamber login through
  Ingress is accepted. Implementation must define trusted proxy/origin handling
  and test it before enabling the existing listener slots. This is shared
  administrator access, not multi-user/read-only-account isolation. Keep editor
  LAN requests denied; password rotation must invalidate sessions and streams.
  Promotion-focused source review: the pinned preview accepts `uiPassword` as a
  startup option, but its UI JWT verification uses a persisted signing secret
  without checking the current password. Simply setting a new password is not
  sufficient evidence of session revocation. Verify native cookie/client-token
  invalidation and trusted-proxy handling before activating either listener.
  Implementation (2026-09-23 working tree): opt-in `4096` API and `4097` native UI
  frontends use separate `lan_password`, explicit HTTPS public origins and exact
  trusted proxy IPs. They validate socket peer, preserved Host, HTTPS forwarding
  and browser Origin, sanitize forwarding headers, deny editor/inbound-MCP Ingress
  paths, and preserve HTTP bodies, SSE and WebSocket traffic. No extra backend.
  Credentials/configuration are staged root-only and loaded into non-dumpable
  frontend processes, never their arguments or inherited environment. Native UI
  cookies and paired-client authentication use a separate private `/run` directory;
  app restart clears authentication state and closes streams while retaining UI
  settings and conversations. Password changes require app restart.
  Eight behavioral LAN tests passed on Windows and Linux. Combined LAN/runtime/
  state/provider-docs/editor-origin checks passed 59/59; migration/CLI/runtime-guard
  checks passed 15/15. Actual pinned native UI auth tests passed login plus cookie
  and paired-token revocation across activation. Native amd64 boundary image passed
  API access through separate LAN authentication, origin rejection, forward migration,
  policy self-test (36 passed/1 optional skip), provider and Zigbee fixtures.
  Image index: `sha256:259e65aae7839a4fef66c0246120cc9ce96ec84bc5e2d3b1da460ea4c9be782e`.
  Supervised acceptance passed through a certificate-verified HTTPS proxy in the
  official amd64 devcontainer: API authentication, native UI login, allowed/rejected
  origins, common backend session IDs, SSE termination and old-password/cookie/
  paired-token rejection after credential rotation. Native login via the new
  password worked. The original terminal interface and disabled LAN options were
  restored. The first run hit a test-only response-header casing assumption; fixed
  to normalize HTTP header names, then the complete scenario passed.
  Native ARM and representative interactive remote-client qualification remain
  in V8/V1; these component/protocol checks do not claim every desktop client.
- [ ] **I5 — Finish obsolete-artifact cleanup.** Inventory unused SDK dependencies,
  generated files, caches, helpers and s6 definitions. Remove only superseded
  app-owned artifacts after required data is preserved. Keep user SSH files,
  customized skills and HA configuration. Confirm the intended compatibility
  lifetime of `opencode2`; it already aliases the same V2 client. V1 execution
  and rollback-generation retention are already removed.
  Source audit (2026-09-23 working tree): removed four unused beta-only V1
  permission-helper/test and standalone smoke-probe files. Retained stable's
  still-used copies, the migration-fixture CLI dependency, transitive SDK packages,
  and registered LAN/PPQ services needed by I3/I4. No persisted files or user
  assets were removed. Compatibility alias lifetime is fixed above. The focused
  runtime-contract suite passed 29/29 on Windows with Node `24.15.0`. In a staged
  source-tree fixture, MCP regression tests passed 582 checks with 10 optional/
  platform skips; the opt-in Edge browser run additionally passed its three
  HTTP/HTTPS form-Origin scenarios (27 passed, 3 platform skips in that file).
  Removed unused init-marker writes and PPQ bookkeeping without deleting old
  persisted files. Final integration checks and Linux qualification remain pending.
  Follow-up: a fresh image build exposed an unlocked PPQ transitive-dependency
  failure (npm 404 fetching `@ai-sdk/provider@4.0.18`). The standalone proxy/tsx
  now has a repository lockfile under `rootfs/opt/ppq-private-runtime`, retaining
  PPQ `0.1.0`, tsx `4.20.6`, tinfoil `1.2.1` and the already-tested AI SDK provider
  `4.0.17` tree. The unused OpenClaw peer is excluded at resolution time, replacing
  install-then-delete cleanup. Its service uses absolute image-owned paths;
  user npm prefixes cannot select a different package. Runtime pin tests passed
  30/30. The amd64 working-tree image build passed with a fresh PPQ install,
  tsx/proxy/tinfoil import smoke, forward migration and extended native boundary
  checks (authenticated policy self-test: 36 passed, 1 optional skip). Image tag:
  `ha-opencode-candidate:20260923-i3-boundary`; image index:
  `sha256:0edeb4fef5d34553673a3acbcbe933a501f6bfc4c95567bcbb1ad3515ac0f4bf`.
  This boundary-test image was not deployed over the Supervisor test app. Native
  ARM, supervised PPQ startup and real enclave/upstream acceptance remain open.
- [ ] **I6 — Stable-channel adoption.** After feature and upgrade qualification,
  port the V2-only implementation into `ha_opencode`, preserving stable identity
  and its own data. Review the disabled promotion helper and channel-specific
  build/release paths rather than mechanically copying beta over stable.
- [ ] **I7 — Release preparation.** After qualification, update version metadata,
  public docs/translations and changelogs to match implemented behavior. Publish
  the exact approved images and verify manifests and storefront metadata agree.
- **I8 — Minimal update-guidance correction completed.** OpenChamber's notice
  directs users to Home Assistant's existing app update controls without implying
  an upstream release is an app update. No update discovery, installation or
  restart machinery was added; managed-runtime restrictions remain intact.
  Implementation evidence (2026-09-23 working tree): source-only correction for
  all 12 locales, applied before the frontend build; exact pinned-revision
  dictionaries accepted by the patcher. On Windows with Node `24.15.0`,
  `node --test ha_opencode_beta/test/openchamber-app-updates.test.js ha_opencode_beta/test/runtime-contract.test.js`
  passed 40/40 checks, including source-drift rejection and retained runtime
  restrictions. Added isolated Ingress browser coverage for a newer upstream
  release, Dismiss-only guidance and dismissal persistence without real settings
  writes. Working-tree amd64 image build now passes (candidate recorded under V8),
  including the source patch and frontend compilation. Rendered English guidance,
  Dismiss-only controls and dismissal persistence after reload passed through
  Core Ingress on candidate `f0dc73098e72…`, with no component-install request.
  All 12 locales retain source coverage; no HAOS qualification is claimed yet.

## 2. Investigation and operational work

### Final-beta follow-up (3.0.0b22)

- Published `beta-v3.0.0b22` on 2026-09-23 from
  `9b34cecc61dda67a5999c0cde7dc93d2574fdee0` (implementation `ccd1501`, build-context
  fixture inclusion `9b34cec`); storefront version commit `ed125bc`.
  PR Checks `35871420141` passed after one unchanged browser-OAuth timeout rerun;
  native amd64/arm64 checks `35871420111`, initial publication `35872040313`, release
  `35872963835` and final tag publication `35872963833` all passed.
  Both `container-images.md` and `image-manifest.txt` are attached to the release;
  registry inspection agrees with the attached final index:
  `sha256:68ddbc906b10a0f2b50fd4012b26de576bebbcece3b2e33fc2592971d5b3ae0f`.
  Final platform manifests: amd64
  `sha256:c688dee15eceba3bc8265ceb6db3fa7af4575ca3a48d29a1d580ce282c9193cc`, arm64
  `sha256:1f1b721f86731a9fdf7ead6e7250984e3fbb60bc709b480d561e2dd79f4b948e`.
  Stable remains `2.5.6`; this publication is the requested final beta candidate.
- User ended general acceptance testing and requested two targeted OpenChamber
  changes, followed by commit/push and publication of a final beta candidate.
- Usage root cause verified in pinned preview source: its auth reader resolves
  `HOME=/data` to the retained V1 store, while the backend uses the activated V2
  generation. Bootstrap now supplies that generation's database path from the
  protected readiness marker; quota reads stay read-only and never merge/fall
  back to V1 credentials. Account ordering matches pinned OpenCode, refreshed
  credentials are re-read, and quota authorization errors are distinguished from
  conversation/session expiry. OpenCode retains sole OAuth refresh ownership.
- New-chat selection now consumes the already-persisted last-used model when
  present in the catalog and protects that choice from asynchronous discovery.
  Configured defaults remain the fallback; the selected agent and existing
  session selections retain their own behavior. Model memory is browser-local.
- Stable promotion is separate from this beta release. Prior unresolved findings
  (including custom-skill discovery) are retained rather than marked passed.
- Focused checks passed against the actual patched preview revision: 73 native
  store tests (including three new model-memory cases), read-only SQLite quota
  credential/login/refresh/disconnect regression, and 42 runtime/update-guidance
  contracts. Quota requests used controlled HTTP responses; production OpenAI
  quota access is not claimed. Release image builds repeat these focused checks
  with the pinned Node/Bun runtimes on each native architecture.

These need diagnosis or access to an affected environment; they are not merely
unchecked tests. Record the cause before adding an implementation fix.

- [ ] **D1 — Installation-specific Zigbee hangs.** Reproduce bounded
  `zigporter check` and `zigporter inspect ... --json` on the affected HAOS/ZHA
  installation. Identify the request/discovery/authentication step that hangs,
  then fix or integrate an upstream correction and pin it. The local no-ZHA
  instance returns within five seconds; unbounded WebSocket receives in installed
  zigporter `1.4.2` are a lead, not an established cause.
  Operator self-check follow-up: the stock first-run gate checked for a `.env`
  file before accepting environment credentials. The existing `zigporter_run`
  MCP tool already supplies HA credentials in the isolated sidecar; direct agent
  shell calls do not. The beta now pins zigporter `1.4.2` and adapts its managed
  bootstrap: use explicit environment, skip interactive setup, ignore user `.env`
  files, and give direct credential-less CLI calls actionable MCP guidance.
  Z2M preflight omits authentication when contacting the separate Z2M endpoint;
  an empty token was insufficient because upstream still formed a Bearer header.
  Real check/inspect integration passed against controlled HA HTTP/WebSocket
  fixtures in the native amd64 image, including first run without a `.env`,
  ignored project `.env` settings, credential-less shell guidance, missing-device
  output and ZHA-only migration-preflight failure. No new MCP interface was added.
  ZHA hardware/hang acceptance remains open.
- [ ] **D2 — Diagnostic-created extra daemon.** On the affected installation,
  identify the extra process's PID, owner, start time, endpoint and data roots.
  Establish whether it wrote separate session data before controlled cleanup.
  Preserve the conversation server and its sessions; never kill by a broad
  process-name match. New CLI non-starting behavior is already verified locally.
- [ ] **D3 — Desktop-browser tool connection.** Establish and document the
  supported browser connection/deployment model; configure or integrate what is
  missing. Then test navigation, clicking, debugging and advertised subtools with
  a connected test browser. HA screenshots and the OpenChamber Chromium smoke
  test are separate capabilities, not evidence for these model-facing tools.
  Documentation finding (2026-09-23): the authoritative V2 Tools guide states
  that the `browser` namespace controls a browser attached by the OpenCode
  desktop app (`https://opencode.ai/v2/docs/tools`, Browser section). OpenChamber
  Ingress and the packaged screenshot Chromium are not that attachment. Desktop
  attachment to this managed backend remains unverified and depends on a supported
  authenticated remote-client path; do not invent a CDP/environment workaround.
- [ ] **D4 — Interrupted web searches.** Capture bounded cancellation/deadline
  evidence with a controlled provider and demonstrate a completed search. Fix
  any confirmed defect. Cancelled requests do not prove provider failure, and
  successful direct web fetching does not establish search coverage.
  The V2 Websearch guide (`https://opencode.ai/v2/docs/websearch`) documents Exa,
  Firecrawl, Parallel and Tavily account/env-key integrations and selection via
  `websearch.provider`. Check I3's environment/config propagation alongside a
  controlled provider before attributing interruption to the upstream service.
  Follow-up: the app's raw-config allowlist previously rejected `websearch`;
  that configuration gap is fixed and documented under I3. This does not establish
  the cause of interrupted searches. Real search execution/cancellation remains
  open; controlled model traffic and key forwarding alone do not close D4.

## 3. Verification of implemented features

### Operator self-check follow-up (reported against current beta)

- User reports authenticated service/API and 37/37 policy checks passed, both MCP
  integrations connected, live-state/history/calendar/hab/ESPHome reads worked,
  configuration validation and an authenticated dashboard screenshot passed, and
  LSP diagnosed a malformed draft, completed values and resolved an include.
  Record as operator-reported scenario evidence; exact architecture/image and
  HA versions were not supplied, and no writes, restore or soak were exercised.
- Confirmed/fixed job reporting: `errors: []` was truthy in `get_running_jobs` and
  `get_update_progress`, unlike the health summary. Both tools and child-job
  status/metadata now share the nonempty-error-array predicate. Regression covers
  empty/null/omitted errors, actual failures, running jobs and child jobs.
- Reproduced an MCP session-interference defect: initializing a second client
  made the first client's in-flight call time out. Each authenticated session now
  owns a separate SDK Server/transport/request-ID space, with 32-session capacity,
  explicit deletion and idle reclamation that preserves active work. Tests cover
  overlapping calls, colliding-ID cancellation isolation, capacity and termination.
  This fixes a demonstrated failure mode, not proof of the operator incident's
  exact trigger. Repeat the original parallel-log scenario after deployment.
- Full MCP regression on Node `24.15.0`/Windows: 586 passed, 10 optional/platform
  skips; the expanded transport suite then passed 13/13, including idle expiry
  with an in-flight call. Full Linux MCP regression: 594 passed, 3 optional browser
  skips, including subprocess cancellation/descendant cleanup and profile enforcement.
- Linux provider/docs/runtime/state checks passed 82/82; skill checks passed 20/20
  after normalizing only staged fixture Markdown from Windows CRLF to Git/CI LF.
  The first skills run rejected those line endings, not the frontmatter content.
- Native amd64 working-tree boundary-test build passed: forward migration,
  credential ownership, authenticated policy (36 passed, 1 optional skip),
  controlled provider request/disabled search and pinned Zigbee integration.
  Image tag: `ha-opencode-candidate:20260923-selfcheck-boundary`; image index:
  `sha256:1ad12dd793f480c5eec917768b363b3830fe7f3f11a6c8f6d9bce7b5a6d8ab21`.
  This image has not been deployed over the Supervisor test app or published.
  Native ARM and supervised/HAOS acceptance remain open.

These items currently represent missing evidence rather than known missing
functionality. If a check fails, add a specific implementation or investigation
item instead of treating all untested behavior as broken.

- [ ] **V1 — Full OpenChamber workflow.** Verify real model streaming, reconnects,
  permission dialogs, UI editing, model/provider selection, OAuth and image-owned
  update behavior. Initial browser load, shared history/policy, Ingress assets,
  service-worker suppression, absent-backend recovery and independent UI stop/start
  already passed on amd64. Qualify the remaining scenarios on both architectures.
  Post-b18 session-creation fix: reproduced HTTP 400 from chunked Ingress POSTs;
  the preview retained Transfer-Encoding while adding Content-Length. Corrected
  framing (including empty JSON) passed the actual-preview HTTP regression, real
  Core Ingress session create/read/delete, and a first UI message with a displayed
  `opencode/big-pickle` reply. Standard Supervisor acceptance passed after restoring
  terminal mode. This correction is published in beta `3.0.0b19`.
- [ ] **V2 — Agent LSP coverage.** Verify live hover/definition and entity/service
  completion, including realistic modern and legacy YAML positions. Exercise
  LSP-disabled, MCP-disabled, restart/recovery and cancellation behavior under
  supervision. Modern trigger fixtures, authenticated health and unknown-entity/
  service diagnostics with corrected-draft refresh already pass. I1's editor
  surface now passes real rendered acceptance on the amd64 working-tree candidate.
  Additional real stopped-worker scenario: unavailable UI rendered, but the harness
  did not complete/clean up within 180 seconds (exit 124, empty stderr). This check
  is INCOMPLETE, not a product failure or pass. Investigation paused after bounded
  attempts; terminal mode and the running LSP service were verified restored.
  Keep disabled-option, resource and remaining platform scenarios open.
- [ ] **V3 — Persistent customizations and options.** Verify user-edited skills
  and instructions survive restarts and upgrades and actually reach sessions.
  Finish presentation, focus/context and startup-hook option checks, including
  clear unsupported combinations. Persistent skill discovery is already wired.
  Qualification failure on the published b21 image (2026-09-23): a newly added
  valid custom skill under `/data/.config/opencode/skills/<id>/SKILL.md` survives
  Supervisor restart but is missing from `/api/skill`. The five shipped HA skills
  remain present. Bounded checks also failed after location reload with a flat
  Markdown skill, a copied shipped skill under a new ID, explicit 0755/0644 modes,
  and a direct authenticated backend read (not just the managed CLI). All synthetic
  files were cleaned up. The effective native configuration lists the intended
  skill directory. Upstream `v2.0.13` skill-source/parser code documents and scans
  these forms; root cause remains unisolated. Do not mark custom-skill discovery
  passed or change runtime pins to work around it. This supported-workflow gap
  needs resolution before promotion.
- [ ] **V4 — Representative forward upgrades and backup/restore.** Exercise
  stable `2.5.6`, earlier beta and b17 data, preserving sessions, V2 credentials,
  permission rules, decision notes and supported customizations. Verify normal
  HA backup/restore, interrupted conversion, visible failure and retry. Existing
  synthetic preservation/pruning checks pass; no rollback generation is required.
  Legacy V1 provider credentials require fresh V2 sign-in.
  Prepared fixture (2026-09-23): existing official amd64 devcontainer recovered
  with Core `2026.9.3`, Supervisor `2026.09.3`, beta `3.0.0b13` and stable `2.5.4`.
  Created and verified Supervisor partial backup `c1b260f9` of the beta app before
  replacement; archive retained in the devcontainer's backup volume with mode
  `0600`. Stable app unchanged. Upgrade and restore checks are not yet complete.
  Pre-LAN-qualification backup (2026-09-23): Supervisor beta-app partial backup
  `01204a59`, `/mnt/supervisor/backup/01204a59.tar`, verified present and protected
  with mode `0600`. This is preparation, not evidence of a completed restore.
  Real restore evidence (2026-09-23, amd64 devcontainer):
  `HA_BACKUP_RESTORE_ACCEPTANCE=1 python3 scripts/devcontainer-backup-restore-acceptance.py`
  created an API session with a shell-deny permission and a uniquely named custom
  skill, made Supervisor backup `15e406b6`, changed only those synthetic assets,
  restored the beta app through Supervisor, and verified the original session
  IDs/options plus the recovered session title/permissions and skill. Synthetic
  assets were removed afterward. Archive `/mnt/supervisor/backup/15e406b6.tar` is
  retained with mode `0600`. The exact working-tree candidate image survived the
  restore and reached the managed backend normally. This closes the beta-app
  backup/restore scenario; representative stable `2.5.6`/earlier-beta upgrades and
  account-backed credential preservation remain open. HA configuration was not
  included in or overwritten by this app-only restore.
- [ ] **V5 — Providers and MCP.** Verify real API-key/OAuth sign-in and refresh,
  native and inbound MCP, and compact/configuration/full profiles. Check disabled
  options and read-only permissions at dispatch. Account-dependent flows remain
  pending until a suitable test account is available; I3's new provider wiring
  must receive its own live checks before being declared complete.
- [ ] **V6 — End-to-end HA work and recovery.** Exercise approved config writes,
  formatting, validation/reload and read-only load verification; failed writes;
  context delivery/compaction; app restart; sidecar/server crashes; plugin reload;
  and session resume. Native formatting already preserves HA YAML tags and user
  preferences and respects disabled formatting/read-only edits in runtime tests.
  Published b21 amd64 devcontainer evidence (2026-09-23):
  `scripts/devcontainer-config-acceptance.mjs` passed explicit pinned Prettier
  formatting, MCP safe-write dry-run with unchanged input, actual safe write and
  full Core validation, `script.reload`, and read-only loaded/off verification.
  A malformed-YAML write was rejected while preserving the last valid file.
  Cleanup used supported script deletion for the synthetic registry entry, then
  restored the original YAML byte-for-byte through the safe writer, reloaded and
  verified exact-entity absence. The test script was never executed; no existing
  script or device was operated. This tests the formatter explicitly; prior native
  formatter-hook contracts remain separate evidence.
  An initial negative fixture using an invalid script mode was accepted by Core's
  global check; it was not reloaded. The original YAML and synthetic registry entry
  were recovered through supported APIs. Core validation alone does not prove an
  integration's configuration loaded, reinforcing the required reload/runtime check.
  `scripts/devcontainer-restart-acceptance.py` passed session/message/permission,
  options and custom-skill-file persistence across Supervisor app restart; packaged
  policy and authenticated LSP reconnection; and a resumed real free-model reply.
  Its overall result remains FAIL because the custom skill was not discovered (V3).
  Free `opencode/big-pickle` rejected generation with the test's session-specific
  shell-deny rule, extending the known custom-agent free-tier limitation. The final
  scenario checks permission persistence while idle, then resets only its own
  synthetic session to defaults before the resumed request. All test sessions,
  skill files and checkpoints were removed. No production restart was performed.
- [ ] **V7 — Remaining tool surfaces.** Exercise MCP resources/prompts and
  permitted subagents, with read-only denials where applicable. Use controlled
  scenarios for device control, firmware/updates, deletion and secret rotation.
  Record unavailable hardware/account prerequisites explicitly. Browser/search
  acceptance follows the findings in D3/D4.
- [ ] **V8 — Exact-candidate platform qualification.** Run final official
  devcontainer lifecycle acceptance and native amd64/arm64 CI on the actual
  candidate. Verify the stable adoption too; earlier b17 results do not qualify
  the later V2-only implementation automatically.
  Beta b19 evidence: PR Checks `35819838518` and native release build/publication
  `35819967061` passed. Published amd64/arm64 manifest digest:
  `sha256:685fb6bb1e6c67841cc80769a81d9ec1ff885f45600f4fea9e8f4fbcf62ccc48`.
  Repeat qualification for subsequent runtime changes and the stable candidate.
  Working-tree amd64 build (2026-09-23, official devcontainer): succeeded after
  retrying the pinned source fetch over HTTP/1.1; initial Git TLS transfer failed.
  Local candidate tag `ha-opencode-candidate:20260923-i1-i3`, image/index ID
  `sha256:f0dc73098e7275a880393da1b9eb9ef00efdc6f5e042868053e1ab2dd7dc5826`.
  Frontend build, actual-preview request framing and forward-migration build
  fixtures passed. This local image reuses development version `3.0.0b19` but is
  NOT the published b19 image and has not been pushed. Full live preview/backend
  lifecycle and rendered I1/I8 acceptance passed on this exact running image.
  Initial failures were acceptance-harness defects (Sonner animation/click timing,
  waiter cleanup, keyboard API, editor selectors and fixture request handling),
  fixed without changing production code or rebuilding. ARM remains outstanding.
  Integrated Linux source snapshot: 191 passed, zero failed, one optional DOM
  skip across 21 files, including controlled provider/formatter/context runtime
  requests, skills and corrected proxy parity. Separate shared-client (4/4),
  native credential-loader (1/1), HA LSP (87/87) and Windows CodeMirror DOM checks
  passed. A subsequent isolated Linux run passed migration/managed-CLI 10/10,
  covering failed-upgrade preservation, exact session/message conversion,
  credential-input rejection and non-starting CLI behavior. Staging normalized
  CRLF in only the five skill files; host files remained untouched.
  b20 release evidence: PR Checks `35836134728` passed for tag commit `cbe9cfe`;
  native amd64/arm64 boundary checks `35835872912` passed before the final test-only
  parity correction. Native release build/publication `35836262147` then passed
  on exact tag commit `cbe9cfe`, including both boundary fixtures and multi-arch
  publication. Only after images were available was `beta-v3.0.0b20` pushed;
  Create Beta Release `35836946676` published the prerelease and advanced beta
  storefront metadata. Stable runtime/config remain `2.5.6`; only a shared-parity
  test assertion changed under the stable source folder.
  Tag-triggered build `35836946688` also passed and attached `container-images.md`
  and `image-manifest.txt` to the release. Verified final amd64/arm64 image index:
  `sha256:cda0cacf505c478c0c904cfb592f7fc99f5e8443ed8830ae902d9555dde28d17`.
  Post-b20 working-tree LAN candidate (2026-09-23): official helper
  `scripts/devcontainer-build-app.sh ha_opencode_beta` built image index
  `sha256:494acc45f575324cecf3da0c239e70244ca3a62939afd80bfb460daf7cfe1055`.
  It is locally tagged `ghcr.io/magnusoverli/ha_opencode_beta:3.0.0b20` for the
  devcontainer, NOT the published b20 image. Supervisor update first pulled the
  published image; the known local candidate was then retagged and activated via
  stop/start, and its exact image ID was verified before qualification.
  Standard supervised lifecycle acceptance passed (10 smoke checks, 1 interface
  skip; policy self-test 36 passed/1 optional skip), followed by HTTPS LAN/rotation,
  real app backup/restore and Chromium Ingress create/read/delete acceptance.
  Preview/backend independent stop/start, absent-backend recovery, shared policy
  and update-guidance checks also passed. Final staged Linux beta contracts:
  222 passed, 1 optional DOM skip. Native ARM, remaining real-provider/account
  scenarios, stable adoption and HAOS qualification remain open. No release or
  repository push was performed; the devcontainer beta is left running this image
  in terminal mode with both LAN listeners disabled, matching its original options.
  Prerequisite check after qualification: Supervisor options report PPQ disabled,
  no configured PPQ key, and no populated provider `*_API_KEY` env-var options.
  This does not inspect or establish the absence of native stored OAuth credentials.
  Real PPQ/private-inference acceptance needs an appropriate account configured
  privately; controlled requests do not close that gate.
  Published b21 follow-up (2026-09-23): after recovering the stopped official
  devcontainer, protected beta backup `b2ac5d30` was created (mode 0600) and
  Supervisor updated the development beta to the published release. Running image
  index verified as `sha256:e3f1303b8be4b8560500f91f9d34a608f10a51cf4444b31ea18fe09f771c25cb`.
  The opt-in OpenChamber driver passed real Chromium Ingress session CRUD, rendered
  editor completion/diagnostic refresh, controlled-503 recovery and read-only editor
  no-write checks, actual Zen/free-model reply display, Supervisor-only update
  guidance, absent-backend recovery and independent UI stop/start. Original terminal
  mode was restored. This closes those amd64 scenarios on the published b21 image;
  it does not add arm64 HAOS or production-restart evidence.
- [ ] **V9 — HAOS acceptance and soak.** Complete controlled HAOS acceptance on
  both architectures, then seven days of representative operation on each.
  Record versions, tool failures, crashes/restarts, orphan processes, resource
  growth and session continuity. Close blocking defects before I7's release.
  User-supplied production report (2026-09-23 12:43–12:54 UTC): installed beta
  `3.0.0b21`, amd64 HAOS 18.3/KVM, Core 2026.9.3, Supervisor 2026.09.3.
  Non-disruptive acceptance reported 37 packaged policy checks passed; managed
  loopback backend/UI and s6 ownership; successful OpenAI OAuth model/tool round
  trips; HA state/history/logbook concurrency and subsequent MCP continuity;
  native HA MCP; authenticated YAML LSP draft diagnostics/refresh/completion; and
  credential-isolated ZHA device inspection. Bounded logs showed no blocking
  failures. This is user-reported evidence, not a direct inspection from this
  development session. No production changes or restart were performed.
  Installed OCI identity remains unverified: the report began around the final
  tag-build publication, so neither version label nor latest registry digest
  alone identifies the image actually running on this host. Preserve the report
  as version-labelled evidence until its installed digest is captured.
  OpenChamber metadata discrepancy reconciled against immutable upstream source:
  both `packages/web/package.json` and `packages/sdk/package.json` at pinned
  revision `9fba129ddf968df1e5fb6916b84d3ceb35493198` declare `1.24.2`; the
  app's declared preview identity is `2.0.0-preview.8`. This is not evidence of an
  incorrect package. `/usr/local/share/openchamber-certified-version` records
  the declared preview identity, not independent proof of the running image.
  Remaining production checks: user-observed streaming/cancel/reconnect/editor,
  approved app restart/session and permission continuity, source-version/baseline
  upgrade evidence, approved harmless write/validate/reload, and seven-day soak.
  PPQ and LAN were disabled (not applicable to this installation, not globally
  qualified). Native arm64 build/boundary checks passed for b21; arm64 HAOS runtime
  acceptance is still missing. Earlier devcontainer restore/lifecycle evidence
  remains valid within its recorded candidate/platform scope.
  Correction to the report's prospective LAN test: enabling OpenChamber LAN
  also enables native login through Ingress; password rotation/app restart
  invalidates both UI access paths' authentication state and interrupts the app.
  User follow-up: production upgrade source confirmed as `3.0.0b20`; user manually
  confirms OpenChamber streaming, session creation and cancellation work. Record
  those three UI checks as operator-observed PASS. Old-session/permission and OAuth
  sign-in preservation, browser reconnect and production restart are not implied.

## Execution order

1. Finish the release-required I3 acceptance and remaining representative client
   checks; I4's implementation/amd64 HTTPS scenario is complete. Limit I5 to packaging/runtime
   defects; preserve completed behavior and stop expanding feature scope.
2. Complete V4 upgrade/restore and the V3 preservation checks, alongside bounded
   candidate acceptance of the core workflows in gate 3. Record missing account
   or hardware access as a concrete blocker.
3. Fix only failures that block gates 1–3; keep optional investigations out of the
   release sequence unless they meet the escalation criteria above.
4. Perform reviewed stable adoption I6, freeze the candidate, then qualify its
   exact amd64/arm64 images through V8 and the planned HAOS V9 soak.
5. Complete I7 and approve stable 3.0 only after all five promotion gates pass.

## Working and verification references

- Follow `AGENTS.md`, `.devcontainer/devcontainer.json` and `.vscode/tasks.json`.
  Supervisor/s6 evidence comes from the official HA Apps devcontainer, not host
  Docker or local emulation. The devcontainer is not HAOS.
- Use `scripts/devcontainer-build-app.sh ha_opencode_beta` for working-tree images
  via the **Rebuild and Start App** task. Do not use `ha apps rebuild --force`.
- Existing acceptance entry points:
  - `scripts/devcontainer-acceptance.sh ha_opencode_beta`
  - `scripts/devcontainer-cli-acceptance.py` (`HA_MANAGED_CLI_ACCEPTANCE=1`)
  - `scripts/devcontainer-lsp-acceptance.mjs` inside the app (`HA_LSP_ACCEPTANCE=1`)
   - `scripts/devcontainer-openchamber-acceptance.py` (`HA_OPENCHAMBER_ACCEPTANCE=1`;
    includes the real Core Ingress browser/session check; additionally set
     `HA_OPENCHAMBER_MODEL_ACCEPTANCE=1` for a real free-model first-message check)
   - `scripts/devcontainer-lan-acceptance.py` inside devcontainer Core
     (`HA_LAN_ACCEPTANCE=1`, `HA_LAN_APP_HOST=<beta-container-IP>`; temporarily enables
     LAN, tests through a certificate-verified local HTTPS proxy, rotates credentials
     through restart, and restores original options; take a Supervisor backup first)
   - `scripts/devcontainer-backup-restore-acceptance.py`
     (`HA_BACKUP_RESTORE_ACCEPTANCE=1`; actual beta-app partial backup/restore with
     a synthetic API session/permission and custom skill; preserves the recovery
     archive and removes only its own test assets)
   - `scripts/devcontainer-restart-acceptance.py` (`HA_RESTART_ACCEPTANCE=1`;
     real free-model session before/after Supervisor restart, persistence and
     policy/LSP checks; intentionally fails if custom-skill discovery is missing)
   - `scripts/devcontainer-config-acceptance.mjs` inside the development beta app
     (`HA_CONFIG_ACCEPTANCE=1`, root with the non-dumpable preload; requires an empty
     standard `scripts.yaml` and full MCP profile; safe-write/reload/failure/cleanup)
  - `ha_opencode_beta/test/openchamber-request-body.mjs` runs against the pinned
    preview during image builds, checking chunked/fixed-length request forwarding.
  - `ha_opencode_beta/test/v2-forward-fixture.py` and `v2-upgrade-acceptance.py`
- Run the smallest relevant source/runtime check per change. Repeat passing
  checks only when later edits affect them. Reserve broad and multi-architecture
  runs for candidate qualification or architecture/packaging changes.
- Record evidence next to the item: commit/image, architecture, HA/Core versions,
  scenario/command, outcome and residual gap. Do not store credentials here.
- Upstream references: [configuration](https://opencode.ai/v2/docs/config),
  [plugins](https://opencode.ai/v2/docs/build/plugins),
  [migration](https://opencode.ai/v2/docs/migrate-v1),
  [permissions](https://opencode.ai/v2/docs/permissions).
