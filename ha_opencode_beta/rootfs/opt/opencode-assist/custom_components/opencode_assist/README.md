# OpenCode Assist companion (experimental)

Targets **Home Assistant 2026.10**. Beta **3.2.0b1** bundles this matching companion;
beta **3.2.0b0** requires the separate ZIP installation described below.

1. Configure a supported provider/model in OpenCode. Enable `ha_assist_enabled`
   in the beta app options and restart the app. It installs the bundled companion
   into HA's `custom_components/opencode_assist` before starting the Assist service.
2. **Restart Home Assistant**, not just the app, after installation or an update.
   HA must reload custom integration code. This interrupts HA automations and
   Assist while Core restarts; the app never initiates that restart automatically.
3. Open the app through HA Ingress as an administrator. Tap **Set up OpenCode
   Assist** in either terminal or OpenChamber mode (also usable without an address
   bar in the HA mobile app). It stays inside the current Ingress session. Create a
   pairing and copy the URL and one-time-displayed key into **Settings → Devices &
   services → Add integration → OpenCode Assist**.
4. Add a **Conversation agent** or **AI data task** subentry. Choose a model and,
   for conversations, the HA APIs to expose. No APIs are selected automatically.
   Select the conversation entity in your Assist pipeline or the AI task entity
   for `ai_task.generate_data`.

The image and release `opencode-assist.zip` use this same source directory; no
integration code is downloaded at runtime. Automatic installation only updates
an unmodified app-managed copy. A manually installed integration (including an
earlier ZIP) or edited app-managed files cause an explicit conflict in the app
log; existing files are preserved and Assist does not start. Back up and move
that directory out of `custom_components` if you want to opt into app management,
then restart the app and HA. Do not remove your HA integration/config entry.
Disabling `ha_assist_enabled` stops the adapter but leaves installed files and
HA configuration intact. Manual ZIP installation remains available for 3.2.0b0;
extract `custom_components/opencode_assist` into HA's config directory and restart
HA. Pairing still requires entering the displayed URL and key in HA's config flow;
automatic pairing is not implemented.

HA owns conversation history, user/device context, exposure rules and tool
execution. The app receives only that request's history, prompt and selected tool
schemas; it returns structured tool calls to HA. Each request uses a disposable,
deny-by-default OpenCode session with no coding/admin-tool fallback. HA history
is sent to the chosen model provider; its normal usage charges and data policies
apply. Choose a provider that supports external/companion use; OpenCode free-tier
restrictions also apply to this private agent. Transient OpenCode sessions are removed on completion or cancellation;
this is not a secure-erasure guarantee for database files or provider logs.
A worker/runtime crash can leave a temporary session behind; automatic orphan
cleanup and crash-recovery retention are not qualified in this first beta.

The pairing key permits model usage through this scoped adapter only. It is
stored in HA's config entry; the app stores only its digest. Replace/revoke it on
the same Ingress page to cancel active requests and invalidate old access. Use
HA's reauthentication flow after replacement. Internal HTTP ports **8768/8769**
must remain unpublished. The beta app's pairing store is separate from stable
and from inbound MCP credentials. Removing the integration stops its requests
and revokes its pairing when the app is reachable. If the app is offline, revoke
the key on its pairing page once it is available again.

AI data tasks support text and JSON validated against the requested schema.
They fail if the model returns invalid structured output; this adapter does not
claim provider-enforced JSON generation. Attachments, images and binary outputs
are not advertised. Selected custom HA APIs retain their own authorization
semantics; selecting a broader API does not acquire Assist's exposure boundary.

Requests are bounded to two minutes, eight concurrent generations, 128 selected
tools, 32 tool calls, 256 history messages and a 512 KiB request body. Oversized
history fails explicitly instead of being silently compacted outside HA.

Diagnostics contain protocol/capability flags and selected-API counts only.
Full supervised HA installation, pairing/setup and voice-pipeline acceptance
remain experimental follow-up work; see the repository `PLAN.md` for tested
evidence and remaining qualification.
