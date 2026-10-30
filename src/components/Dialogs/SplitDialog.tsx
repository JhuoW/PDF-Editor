import { useLocaleStore } from '../../i18n';
import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, t, translateError } from "../../i18n";
import { useState, useCallback, useEffect, useRef } from 'react';
import { splitPDF, downloadPDF, type SplitOptions, type PageRange } from '../../core/PDFManipulator';
import './SplitDialog.css';

interface SplitDialogProps {
  preparePDF: () => Promise<Uint8Array>;
  totalPages: number;
  onClose: () => void;
}

type SplitMode = 'ranges' | 'every-n-pages' | 'extract-pages';

export function SplitDialog({ totalPages, onClose, preparePDF }: SplitDialogProps) {
  useLocale();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const [mode, setMode] = useState<SplitMode>('ranges');
  const [ranges, setRanges] = useState<PageRange[]>([{ start: 1, end: totalPages }]);
  const [everyN, setEveryN] = useState(1);
  const [extractPages, setExtractPages] = useState('');
  const [isSplitting, setIsSplitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputPrefix, setOutputPrefix] = useState('split');

  const addRange = useCallback(() => {
    setRanges(prev => [...prev, { start: 1, end: totalPages }]);
  }, [totalPages]);

  const removeRange = useCallback((index: number) => {
    setRanges(prev => prev.filter((_, i) => i !== index));
  }, []);

  const updateRange = useCallback((index: number, field: 'start' | 'end', value: number) => {
    setRanges(prev => prev.map((range, i) => {
      if (i === index) {
        return { ...range, [field]: value };
      }
      return range;
    }));
  }, []);

  const parseExtractPages = useCallback((input: string): number[] => {
    const pages = new Set<number>();
    const parts = input.split(',').map(p => p.trim());

    for (const part of parts) {
      const range = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      const start = Number(range?.[1]);
      const end = Number(range?.[2] ?? range?.[1]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
        throw new Error('Use whole page numbers and ranges, such as 1, 3-5.');
      }
      // Bound work by the document length, even for an enormous requested range.
      for (let page = start; page <= Math.min(end, totalPages); page++) {
        pages.add(page);
      }
    }

    return [...pages].sort((a, b) => a - b);
  }, [totalPages]);

  const handleSplit = useCallback(async () => {
    setIsSplitting(true);
    setError(null);

    try {
      const prepared = await preparePDF();

      const options: SplitOptions = { mode };

      if (mode === 'ranges') {
        // Validate ranges
        const validRanges = ranges.filter(r => r.start >= 1 && r.end <= totalPages && r.start <= r.end);
        if (validRanges.length === 0) {
          throw new Error('Please enter valid page ranges');
        }
        options.ranges = validRanges;
      } else if (mode === 'every-n-pages') {
        if (everyN < 1) {
          throw new Error('Please enter a valid number of pages');
        }
        options.everyN = everyN;
      } else if (mode === 'extract-pages') {
        const pages = parseExtractPages(extractPages);
        if (pages.length === 0) {
          throw new Error('Please enter valid page numbers');
        }
        options.pages = pages;
      }

      const results = await splitPDF(new Uint8Array(prepared).buffer, options);

      // Download each result (using for...of to properly await each download)
      for (let index = 0; index < results.length; index++) {
        const data = results[index];
        const fileName = results.length === 1
          ? `${outputPrefix}.pdf`
          : `${outputPrefix}_${index + 1}.pdf`;
        await downloadPDF(data, fileName);
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to split PDF');
    } finally {
      setIsSplitting(false);
    }
  }, [mode, ranges, everyN, extractPages, totalPages, outputPrefix, onClose, preparePDF, parseExtractPages]);

  return (
    <dialog ref={dialogRef} className="split-dialog-overlay" aria-labelledby="split-dialog-title"
      onCancel={event => { event.preventDefault(); if (!isSplitting) onClose(); }}
      onClick={event => { if (event.target === event.currentTarget && !isSplitting) onClose(); }}>
      <div className="split-dialog" onClick={e => e.stopPropagation()}>
        <div className="split-dialog-header">
          <h3 id="split-dialog-title">{t("m.split.pdf.9c654c")}</h3>
          <div className="dialog-language"><LanguageSwitcher /></div>
        <button className="split-dialog-close" aria-label={t("m.close.split.dialog.9db236")} disabled={isSplitting} onClick={onClose}>&times;</button></div>

        <div className="split-dialog-content">
          <p className="split-dialog-info">
            {t("m.document.has.6a4441")}{' '}{totalPages}{' '}{t("m.page.767013")}{useLocaleStore.getState().locale === 'en' && totalPages !== 1 ? 's' : ''}
          </p>

          <div className="split-mode-selector">
            <label className="split-mode-option">
              <input
                type="radio"
                name="split-mode"
                checked={mode === 'ranges'}
                onChange={() => setMode('ranges')}
              />
              <span>{t("m.split.by.ranges.4fed82")}</span>
            </label>
            <label className="split-mode-option">
              <input
                type="radio"
                name="split-mode"
                checked={mode === 'every-n-pages'}
                onChange={() => setMode('every-n-pages')}
              />
              <span>{t("m.split.every.n.pages.1ead3f")}</span>
            </label>
            <label className="split-mode-option">
              <input
                type="radio"
                name="split-mode"
                checked={mode === 'extract-pages'}
                onChange={() => setMode('extract-pages')}
              />
              <span>{t("m.extract.specific.pages.41c987")}</span>
            </label>
          </div>

          {mode === 'ranges' && (
            <div className="split-ranges">
              {ranges.map((range, index) => (
                <div key={index} className="split-range-row">
                  <span className="split-range-label">{t("m.range.a16c5b")}{' '}{index + 1}:</span>
                  <input
                    type="number"
                    min={1}
                    max={totalPages}
                    value={range.start}
                    onChange={e => updateRange(index, 'start', parseInt(e.target.value) || 1)}
                  />
                  <span>{t("m.to.4374aa")}</span>
                  <input
                    type="number"
                    min={1}
                    max={totalPages}
                    value={range.end}
                    onChange={e => updateRange(index, 'end', parseInt(e.target.value) || totalPages)}
                  />
                  {ranges.length > 1 && (
                    <button
                      className="split-range-remove"
                      onClick={() => removeRange(index)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button className="split-add-range" onClick={addRange}>
                {t("m.add.range.c0f8e6")}</button>
            </div>
          )}

          {mode === 'every-n-pages' && (
            <div className="split-every-n">
              <label>
                {t("m.split.every.384b4f")}<input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={everyN}
                  onChange={e => setEveryN(parseInt(e.target.value) || 1)}
                />
                {t("m.page.767013")}{useLocaleStore.getState().locale === 'en' && everyN !== 1 ? 's' : ''}
              </label>
              <p className="split-preview">
                {t("m.this.will.create.f6657c")}{' '}{Math.ceil(totalPages / everyN)}{' '}{t("m.file.971c41")}{useLocaleStore.getState().locale === 'en' && Math.ceil(totalPages / everyN) !== 1 ? 's' : ''}
              </p>
            </div>
          )}

          {mode === 'extract-pages' && (
            <div className="split-extract">
              <label>
                {t("m.pages.to.extract.c5ab0d")}<input
                  type="text"
                  value={extractPages}
                  onChange={e => setExtractPages(e.target.value)}
                  placeholder={t("m.e.g.1.3.5.10.15.2f6458")}
                />
              </label>
              <p className="split-hint">
                {t("m.use.commas.to.separate.pages.hyphens.for.ranges.3fd54b")}</p>
            </div>
          )}

          <div className="split-output-name">
            <label>
              {t("m.output.prefix.8225dc")}<input
                type="text"
                value={outputPrefix}
                onChange={e => setOutputPrefix(e.target.value)}
                placeholder={t("m.split.94d5ca")}
              />
            </label>
          </div>

          <p className="split-hint">{t("m.internal.links.to.pages.outside.each.output.file.128932")}</p>
          {error && <div className="split-error">{translateError(error)}</div>}
        </div>

        <div className="split-dialog-actions">
          <button className="split-cancel" disabled={isSplitting} onClick={onClose}>
            {t("m.cancel.77dfd2")}</button>
          <button
            className="split-submit"
            onClick={handleSplit}
            disabled={isSplitting}
          >
            {isSplitting ? t("m.splitting.505f34") : t("m.split.download.0e6eaa")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
