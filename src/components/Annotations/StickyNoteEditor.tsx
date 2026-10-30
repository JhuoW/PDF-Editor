import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, t } from "../../i18n";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StickyNoteAnnotation, StickyNoteReply } from '../../annotations/types';
import { useAnnotationStore } from '../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../store/annotationHistoryStore';
import { useHistoryStore } from '../../store/historyStore';
import { registerPendingEditor } from '../../store/workspaceHistory';
import './StickyNoteEditor.css';

function findNote(id: string): StickyNoteAnnotation | undefined {
  const annotation = useAnnotationStore.getState().getAllAnnotations().find(item => item.id === id);
  return annotation?.type === 'sticky-note' ? annotation : undefined;
}

function NotePanel({ note }: { note: StickyNoteAnnotation }) {
  useLocale();
  const batch = useRef<{ before: StickyNoteAnnotation; after: StickyNoteAnnotation } | null>(null);
  const [replyContent, setReplyContent] = useState('');
  const [replyAuthor, setReplyAuthor] = useState('');
  const contentRef = useRef<HTMLTextAreaElement>(null);

  const finishEdit = useCallback(() => {
    const pending = batch.current;
    batch.current = null;
    // Do not reinsert an edit after undo, a document switch, or an external edit.
    if (pending && findNote(pending.after.id) === pending.after) {
      useHistoryStore.getState().endGroup();
    }
  }, []);
  useEffect(() => registerPendingEditor(finishEdit), [finishEdit]);
  useEffect(() => {
    contentRef.current?.focus();
    return finishEdit;
  }, [finishEdit]);

  const change = (updates: Partial<StickyNoteAnnotation>) => {
    const current = findNote(note.id);
    if (!current) return;
    const before = batch.current?.before ?? structuredClone(current);
    useAnnotationStore.getState().updateAnnotation(note.id, updates);
    const after = findNote(note.id)!;
    useAnnotationHistoryStore.getState().recordUpdate(after, current, `note:${note.id}`);
    batch.current = { before, after };
  };
  const changeReply = (reply: StickyNoteReply, updates: Partial<StickyNoteReply>) => {
    const current = findNote(note.id);
    if (!current) return;
    change({ replies: (current.replies ?? []).map(item => item.id === reply.id ? { ...item, ...updates, modifiedAt: new Date() } : item) });
  };
  const close = () => {
    finishEdit();
    const store = useAnnotationStore.getState();
    store.selectAnnotation(null);
    store.setCurrentTool('select');
    const viewer = window.document.querySelector<HTMLElement>('.pdf-viewer-container');
    if (viewer) { viewer.tabIndex = -1; viewer.focus({ preventScroll: true }); }
  };

  return (
    <section className="sticky-note-editor" role="dialog" aria-modal="false" aria-labelledby="sticky-note-editor-title"
      onKeyDown={event => {
        // Keep drawing-layer/global shortcuts away from the note's controls.
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        else event.stopPropagation();
      }}>
      <header><h2 id="sticky-note-editor-title">{t("m.note.page.ea08c3")}{' '}{note.pageNumber}</h2><button type="button" onClick={close} aria-label={t("m.close.note.editor.bb637c")}>×</button><div className="dialog-language"><LanguageSwitcher /></div></header>
      <label>{t("m.author.5fda23")}<input aria-label={t("m.note.author.843bdb")} value={note.author ?? ''} onChange={event => change({ author: event.target.value })} onBlur={finishEdit} /></label>
      <label>{t("m.note.2c924e")}<textarea ref={contentRef} aria-label={t("m.note.content.319782")} rows={5} value={note.content} onChange={event => change({ content: event.target.value })} onBlur={finishEdit} /></label>
      <div className="sticky-note-actions">
        <button type="button" onClick={finishEdit}>{t("m.save.note.d69ca0")}</button>
        <button type="button" className="danger" onClick={() => {
          finishEdit();
          const current = findNote(note.id);
          if (!current) return;
          useAnnotationHistoryStore.getState().recordDelete(structuredClone(current));
          useAnnotationStore.getState().deleteAnnotation(note.id);
          close();
        }}>{t("m.delete.note.a8ed43")}</button>
      </div>
      <p className="sticky-note-hint">{t("m.changes.stay.editable.export.to.include.them.in..ce3891")}</p>
      <h3>{t("m.replies.c8a103")}</h3>
      {(note.replies ?? []).map((reply, index) => (
        <fieldset key={reply.id} className="sticky-note-reply">
          <legend>{t("m.reply.6c2bb7")}{' '}{index + 1}</legend>
          <label>{t("m.author.5fda23")}<input aria-label={t("m.reply.author.183b32", { v0: index + 1 })} value={reply.author ?? ''} onChange={event => changeReply(reply, { author: event.target.value })} onBlur={finishEdit} /></label>
          <label>{t("m.reply.6c2bb7")}<textarea aria-label={t("m.reply.content.2ff1b5", { v0: index + 1 })} rows={3} value={reply.content} onChange={event => changeReply(reply, { content: event.target.value })} onBlur={finishEdit} /></label>
          <button type="button" className="danger" aria-label={t("m.delete.reply.09b892", { v0: index + 1 })} onClick={() => {
            finishEdit();
            const current = findNote(note.id);
            if (!current) return;
            change({ replies: (current.replies ?? []).filter(item => item.id !== reply.id) });
            finishEdit();
          }}>{t("m.delete.reply.2538fc")}</button>
        </fieldset>
      ))}
      <form className="sticky-note-reply" onSubmit={event => {
        event.preventDefault();
        if (!replyContent.trim()) return;
        finishEdit();
        const current = findNote(note.id);
        if (!current) return;
        const reply: StickyNoteReply = { id: crypto.randomUUID(), author: replyAuthor, content: replyContent, createdAt: new Date(), modifiedAt: new Date() };
        change({ replies: [...(current.replies ?? []), reply] });
        finishEdit();
        setReplyContent('');
        setReplyAuthor('');
      }}>
        <label>{t("m.reply.author.c1978e")}<input aria-label={t("m.new.reply.author.9c17e1")} value={replyAuthor} onChange={event => setReplyAuthor(event.target.value)} /></label>
        <label>{t("m.new.reply.48e28e")}<textarea aria-label={t("m.new.reply.content.a80b3f")} rows={3} value={replyContent} onChange={event => setReplyContent(event.target.value)} /></label>
        <button type="submit" disabled={!replyContent.trim()}>{t("m.add.reply.a2ac61")}</button>
      </form>
    </section>
  );
}

/** Independent of virtualized page layers so typing survives page scrolling. */
export function StickyNoteEditor() {
  useLocale();
  const note = useAnnotationStore(state => {
    for (const annotations of state.annotations.values()) {
      const selected = annotations.find(annotation => annotation.id === state.selectedAnnotationId);
      if (selected?.type === 'sticky-note') return selected;
    }
    return undefined;
  });
  return note ? <NotePanel key={note.id} note={note} /> : null;
}
