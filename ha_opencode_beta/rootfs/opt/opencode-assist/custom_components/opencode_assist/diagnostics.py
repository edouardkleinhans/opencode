"""Diagnostics deliberately exclude credentials, URLs and conversation content."""

async def async_get_config_entry_diagnostics(hass, entry):
    return {
        "protocol_version": entry.runtime_data.info.get("version"),
        "conversation": entry.runtime_data.info.get("conversation"),
        "generate_data": entry.runtime_data.info.get("generate_data"),
        "subentries": [{"type": item.subentry_type, "selected_api_count": len(item.data.get("llm_hass_api", []))}
                       for item in entry.subentries.values()],
    }
