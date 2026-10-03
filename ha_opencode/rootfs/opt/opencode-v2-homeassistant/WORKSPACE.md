# Home Assistant V2 workspace

The Home Assistant configuration is mounted at `/homeassistant`.
Use that absolute path for file reads, edits, searches, and shell commands.

The current working directory is a root-owned isolation boundary, not the
configuration directory. Do not create project configuration or plugins there.

When the `ha_yaml_*` tools are available, use their credential-isolated language
server for Home Assistant YAML diagnostics, completion, hover and definitions.
They accept an existing YAML path or optional in-memory draft text and never
write files. Check drafts before approved changes and request fresh diagnostics
after edits; report a failed HA/LSP connection rather than treating it as a clean
validation. The `ha_yaml_status` tool verifies the worker's live HA connection.

For read-only Zigbee checks and device dependency inspection, use the
`homeassistant_zigporter_run` MCP tool (`command: "check"` or `"inspect <device> --json"`). It
runs zigporter inside the credential-isolated sidecar without interactive setup.
`inspect` requires a device; `check` is migration preflight and requires Z2M even
on otherwise healthy ZHA-only installations. The agent shell does not inherit HA
credentials: do not create credential files or run `zigporter setup` to bypass
this boundary. The general tool also supports changes: use only check/inspect
for read-only investigation and obtain approval before any supported mutation.
