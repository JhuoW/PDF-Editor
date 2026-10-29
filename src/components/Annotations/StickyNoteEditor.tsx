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
      <header><h2 id="sticky-note-editor-title">Note · Page {note.pageNumber}</h2><button type="button" onClick={close} aria-label="Close note editor">×</button></header>
      <label>Author<input aria-label="Note author" value={note.author ?? ''} onChange={event => change({ author: event.target.value })} onBlur={finishEdit} /></label>
      <label>Note<textarea ref={contentRef} aria-label="Note content" rows={5} value={note.content} onChange={event => change({ content: event.target.value })} onBlur={finishEdit} /></label>
      <div className="sticky-note-actions">
        <button type="button" onClick={finishEdit}>Save note</button>
        <button type="button" className="danger" onClick={() => {
          finishEdit();
          const current = findNote(note.id);
          if (!current) return;
          useAnnotationHistoryStore.getState().recordDelete(structuredClone(current));
          useAnnotationStore.getState().deleteAnnotation(note.id);
          close();
        }}>Delete note</button>
      </div>
      <p className="sticky-note-hint">Changes stay editable. Export to include them in the PDF.</p>
      <h3>Replies</h3>
      {(note.replies ?? []).map((reply, index) => (
        <fieldset key={reply.id} className="sticky-note-reply">
          <legend>Reply {index + 1}</legend>
          <label>Author<input aria-label={`Reply ${index + 1} author`} value={reply.author ?? ''} onChange={event => changeReply(reply, { author: event.target.value })} onBlur={finishEdit} /></label>
          <label>Reply<textarea aria-label={`Reply ${index + 1} content`} rows={3} value={reply.content} onChange={event => changeReply(reply, { content: event.target.value })} onBlur={finishEdit} /></label>
          <button type="button" className="danger" aria-label={`Delete reply ${index + 1}`} onClick={() => {
            finishEdit();
            const current = findNote(note.id);
            if (!current) return;
            change({ replies: (current.replies ?? []).filter(item => item.id !== reply.id) });
            finishEdit();
          }}>Delete reply</button>
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
        <label>Reply author<input aria-label="New reply author" value={replyAuthor} onChange={event => setReplyAuthor(event.target.value)} /></label>
        <label>New reply<textarea aria-label="New reply content" rows={3} value={replyContent} onChange={event => setReplyContent(event.target.value)} /></label>
        <button type="submit" disabled={!replyContent.trim()}>Add reply</button>
      </form>
    </section>
  );
}

/** Independent of virtualized page layers so typing survives page scrolling. */
export function StickyNoteEditor() {
  const note = useAnnotationStore(state => {
    for (const annotations of state.annotations.values()) {
      const selected = annotations.find(annotation => annotation.id === state.selectedAnnotationId);
      if (selected?.type === 'sticky-note') return selected;
    }
    return undefined;
  });
  return note ? <NotePanel key={note.id} note={note} /> : null;
}
