UI messages are bundled in `en.ts` and `zh-CN.ts`, with identical keys and interpolation tokens. `useLocale()` subscribes a component to immediate language changes. `t(key, values)` formats a catalog message; its English source is also accepted as a key.

Use `translateMessage()` at the presentation boundary for existing application status protocols and `translateError()` for errors, including unexpected worker/library failures. `templateOptions.ts` identifies nested UI messages, errors and English plural suffixes. Keep canonical protocols in state so an open operation can change languages in either direction.

Never translate PDF text, bookmark titles, field names/values, metadata, attachment names, custom stamps or other user content. Interpolation values remain unchanged unless explicitly classified as UI protocols. Language preference is stored separately from the document session under `pdf-editor.locale`; no translation service is contacted at runtime.

Run `npm run check:i18n` for resource parity, interpolation and static UI checks. `workspace-i18n.spec.ts` verifies switching, persistence, active editors, dialogs, user content and responsive access in the browser.
