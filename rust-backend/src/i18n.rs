pub fn tr(msgid: &str) -> String {
    // Placeholder i18n layer: for now just return the original message.
    // This mirrors Python's `_ = gettext.gettext` API shape so that
    // wiring real gettext/PO support later gerektirirse kolayca eklenebilir.
    msgid.to_string()
}
