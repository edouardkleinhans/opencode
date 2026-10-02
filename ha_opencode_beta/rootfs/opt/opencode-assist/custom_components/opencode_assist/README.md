# OpenCode Assist companion (experimental)

Targets **Home Assistant 2026.10 with Supervisor**. Companion **0.1.0b3** uses
Supervisor-only onboarding in beta **3.2.0b2**, replacing 3.2.0b1's manual pairing.

1. Configure a supported provider/model in OpenCode. Enable `ha_assist_enabled`
   in the beta app options and restart the app. It installs the bundled companion
   into HA's `custom_components/opencode_assist` before starting the Assist service.
2. **Restart Home Assistant**, not just the app, after installation or an update.
   HA must reload custom integration code. This interrupts HA automations and
   Assist while Core restarts; the app never initiates that restart automatically.
3. In **Settings → Devices & services**, configure the discovered **OpenCode
   Assist** app. Confirm the connection and choose a **Conversation agent** or
   **AI data task**. Supervisor supplies the connection details and an expiring
   bootstrap; HA generates and exchanges a scoped key automatically. Nothing
   needs copying. **Add integration → OpenCode Assist** finds the same app.
4. HA opens model/API selection as the next step. Choose a model and, for
   conversations, the HA APIs to expose. No APIs are selected automatically.
   Select the conversation entity in your Assist pipeline or the AI task entity
   for `ai_task.generate_data`.

The image and release `opencode-assist.zip` use this same source directory; no
integration code is downloaded at runtime. Automatic installation only updates
an unmodified app-managed copy. A manually installed integration (including an
earlier ZIP) or edited app-managed files cause an explicit conflict in the app
log; existing files are preserved and Assist does not start. Back up and move
that directory out of `custom_components` if you want to opt into app management,
then restart the app and HA. Old experimental manually paired HA entries should
be removed and recreated through discovery; no migration or manual pairing form
is provided. Disabling `ha_assist_enabled` stops the adapter and withdraws its
advertisement but leaves installed files, pairing and HA configuration intact.
Normal restarts and rediscovery keep the same pairing and subentries.

The administrator-only **Set up OpenCode Assist** link in both Ingress modes
provides status, installation/restart guidance and a link to HA setup, including
on mobile. If discovery is missing, check the app log for installation conflicts,
restart Core after installing/updating the companion, then retry when Supervisor
and OpenCode are available. If there are no models, configure a provider/model
in OpenCode and resubmit; no pairing is created before a model is available.

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
stored in HA's config entry; the app stores only its digest. Supervisor's persisted
discovery record contains only an expiring bootstrap, never that durable key.
Renew the connection through HA's reauthentication or Reconfigure flow; confirmation
replaces its key and cancels active requests. Internal HTTP ports **8768/8769**
must remain unpublished. The beta app's pairing store is separate from stable
and from inbound MCP credentials. Removing the integration stops its requests
and revokes its pairing when the app is reachable. If removed while the app is
offline, the next confirmed setup replaces the old key.

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
