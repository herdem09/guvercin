pub fn tr(msgid: &str) -> String {
    // Placeholder i18n layer: for now just return the original message.
    // This mirrors Python's `_ = gettext.gettext` API shape so that
    // real gettext/PO support can be easily added later if needed.
    msgid.to_string()
}
