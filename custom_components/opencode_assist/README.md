# OpenCode Assist companion (experimental)

Targets **Home Assistant 2026.10** and **OpenCode beta 3.2.0b0**.
Install this optional integration separately from the app. Earlier beta images
do not include its adapter.

1. Download `opencode-assist.zip` from the matching beta release and extract its
   `custom_components/opencode_assist` directory into your HA `config` directory,
   then restart Home Assistant. For development, copy this directory directly.
   Code updates also require a full Home Assistant restart.
2. Configure a supported provider/model in OpenCode. Enable `ha_assist_enabled`
   in the beta app options and restart the app.
3. Open the app through HA Ingress as an administrator. Open `ha-assist/` beneath
   the app's Ingress URL (`/api/hassio_ingress/<session>/ha-assist/`). Create a
   pairing and copy the URL and one-time-displayed key into **Settings → Devices &
   services → Add integration → OpenCode Assist**.
4. Add a **Conversation agent** or **AI data task** subentry. Choose a model and,
   for conversations, the HA APIs to expose. No APIs are selected automatically.
   Select the conversation entity in your Assist pipeline or the AI task entity
   for `ai_task.generate_data`.

HA owns conversation history, user/device context, exposure rules and tool
execution. The app receives only that request's history, prompt and selected tool
schemas; it returns structured tool calls to HA. Each request uses a disposable,
deny-by-default OpenCode session with no coding/admin-tool fallback. HA history
is sent to the chosen model provider; its normal usage charges and data policies
apply. Choose a provider that supports external/companion use; OpenCode free-tier
restrictions also apply to this private agent. Transient OpenCode sessions are removed on completion or cancellation;
this is not a secure-erasure guarantee for database files or provider logs.

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
Pairing/setup, native images and full supervised HA acceptance remain release
gates; see the repository `PLAN.md` for tested evidence.
