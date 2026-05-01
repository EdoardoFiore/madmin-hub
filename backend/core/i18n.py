"""
i18n — IT/EN backend translations.
Usage:
    from core.i18n import tr, get_lang
    lang = get_lang(request)
    raise HTTPException(status_code=404, detail=tr("instance_not_found", lang))
"""
from fastapi import Request

MESSAGES: dict[str, dict[str, str]] = {
    "it": {
        "invalid_credentials":        "Username o password non validi",
        "2fa_not_enabled":             "2FA non abilitata",
        "invalid_2fa_code":            "Codice 2FA non valido",
        "invalid_current_password":    "Password attuale non valida",
        "password_updated":            "Password aggiornata",
        "2fa_already_enabled":         "2FA già abilitata",
        "no_2fa_setup":                "Nessun setup 2FA iniziato",
        "invalid_code":                "Codice non valido",
        "2fa_enabled":                 "2FA attivata",
        "2fa_enforced":                "2FA enforced — non disabilitabile",
        "2fa_disabled":                "2FA disattivata",
        "user_not_found":              "Utente non trovato",
        "protected_owner_only":        "Utente protetto: solo il proprietario può modificarlo",
        "protected_no_delete":         "Utente protetto non eliminabile",
        "cannot_delete_self":          "Non puoi eliminare te stesso",
        "user_deleted":                "Eliminato",
        "instance_not_found":          "Istanza non trovata",
        "instance_revoked":            "Istanza revocata",
        "group_not_found":             "Gruppo non trovato",
        "group_deleted":               "Gruppo eliminato",
        "token_not_found":             "Token non trovato",
        "token_revoked":               "Token revocato",
        "ssh_key_not_found":           "Chiave SSH non trovata",
        "key_not_found":               "Chiave non trovata",
        "key_deleted":                 "Chiave eliminata",
        "active_assignments_exist":    "Revoca prima le assegnazioni attive",
        "assignment_not_found":        "Assegnazione non trovata",
        "already_revoked":             "Già revocata",
        "invalid_target_type":         "target_type deve essere 'instance' o 'group'",
        "preferences_invalid_json":    "Le preferenze devono essere JSON valido",
    },
    "en": {
        "invalid_credentials":        "Invalid username or password",
        "2fa_not_enabled":             "2FA not enabled",
        "invalid_2fa_code":            "Invalid 2FA code",
        "invalid_current_password":    "Current password is invalid",
        "password_updated":            "Password updated",
        "2fa_already_enabled":         "2FA already enabled",
        "no_2fa_setup":                "No 2FA setup initiated",
        "invalid_code":                "Invalid code",
        "2fa_enabled":                 "2FA enabled",
        "2fa_enforced":                "2FA enforced — cannot disable",
        "2fa_disabled":                "2FA disabled",
        "user_not_found":              "User not found",
        "protected_owner_only":        "Protected user: only the owner can modify it",
        "protected_no_delete":         "Protected user cannot be deleted",
        "cannot_delete_self":          "You cannot delete yourself",
        "user_deleted":                "Deleted",
        "instance_not_found":          "Instance not found",
        "instance_revoked":            "Instance revoked",
        "group_not_found":             "Group not found",
        "group_deleted":               "Group deleted",
        "token_not_found":             "Token not found",
        "token_revoked":               "Token revoked",
        "ssh_key_not_found":           "SSH key not found",
        "key_not_found":               "Key not found",
        "key_deleted":                 "Key deleted",
        "active_assignments_exist":    "Revoke active assignments first",
        "assignment_not_found":        "Assignment not found",
        "already_revoked":             "Already revoked",
        "invalid_target_type":         "target_type must be 'instance' or 'group'",
        "preferences_invalid_json":    "Preferences must be valid JSON",
    },
}

_SUPPORTED = frozenset(MESSAGES.keys())


def get_lang(request: Request) -> str:
    lang = request.headers.get("X-Language", "it")[:2].lower()
    return lang if lang in _SUPPORTED else "it"


def tr(key: str, lang: str = "it") -> str:
    return MESSAGES.get(lang, MESSAGES["it"]).get(key, MESSAGES["it"].get(key, key))
