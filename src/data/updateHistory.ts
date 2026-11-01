import type { MessageKey } from '../i18n';

export interface UpdateRecord { id: string; updatedAt: string; changes: readonly MessageKey[] }

// For each release, prepend its UTC+08:00 ISO timestamp and message keys, then add
// both translations in src/i18n. Backfilled timestamps come from Git commits.
export const updateHistory = [
  {"id":"2026-11-01-text-object-debug","updatedAt":"2026-11-01T10:02:00+08:00","changes":["updates.debug.layout","updates.debug.objects","updates.debug.input","updates.debug.fonts"]},
  {"id":"2026-11-01-paragraph-object-editing","updatedAt":"2026-11-01T02:18:53+08:00","changes":["updates.text.paragraphs","updates.text.objects","updates.text.export","updates.text.fonts"]},
  {"id":"2026-10-31-chinese-fonts-search","updatedAt":"2026-10-31T19:30:26+08:00","changes":["updates.fonts.library","updates.fonts.export","updates.fonts.search"]},
  {"id":"2026-10-31-reliability","updatedAt":"2026-10-31T17:20:57+08:00","changes":["updates.reliability.text","updates.reliability.export","updates.reliability.errors","updates.reliability.ci","updates.reliability.history"]},
  {"id":"c14f48d","updatedAt":"2026-10-31T12:27:04+08:00","changes":["updates.entry.c14f48d"]},
  {"id":"7974eda","updatedAt":"2026-10-31T01:15:22+08:00","changes":["updates.entry.7974eda"]},
  {"id":"10fd0c4","updatedAt":"2026-10-31T00:02:02+08:00","changes":["updates.entry.10fd0c4"]},
  {"id":"2cd0b72","updatedAt":"2026-10-30T23:17:39+08:00","changes":["updates.entry.2cd0b72"]},
  {"id":"903e7c7","updatedAt":"2026-10-30T19:47:47+08:00","changes":["updates.entry.903e7c7"]},
  {"id":"ac19476","updatedAt":"2026-10-30T19:28:35+08:00","changes":["updates.entry.ac19476"]},
  {"id":"34c968a","updatedAt":"2026-10-30T19:13:35+08:00","changes":["updates.entry.34c968a"]},
  {"id":"d4c2c34","updatedAt":"2026-10-30T18:33:20+08:00","changes":["updates.entry.d4c2c34"]},
  {"id":"abe335b","updatedAt":"2026-10-30T18:01:47+08:00","changes":["updates.entry.abe335b"]},
  {"id":"deac308","updatedAt":"2026-10-30T14:18:27+08:00","changes":["updates.entry.deac308"]},
  {"id":"862f45e","updatedAt":"2026-10-30T13:29:45+08:00","changes":["updates.entry.862f45e"]},
  {"id":"671928e","updatedAt":"2026-10-30T12:50:18+08:00","changes":["updates.entry.671928e"]},
  {"id":"d12abb1","updatedAt":"2026-10-30T12:43:53+08:00","changes":["updates.entry.d12abb1"]},
  {"id":"c8ee415","updatedAt":"2026-10-30T11:20:55+08:00","changes":["updates.entry.c8ee415"]},
  {"id":"5399b1b","updatedAt":"2026-10-30T10:56:50+08:00","changes":["updates.entry.5399b1b"]},
  {"id":"c07c6ef","updatedAt":"2026-10-30T10:01:17+08:00","changes":["updates.entry.c07c6ef"]},
  {"id":"42a5a17","updatedAt":"2026-10-30T03:20:02+08:00","changes":["updates.entry.42a5a17"]},
  {"id":"a318893","updatedAt":"2026-01-17T03:42:39+08:00","changes":["updates.entry.a318893"]},
  {"id":"18c77bc","updatedAt":"2026-01-17T03:39:38+08:00","changes":["updates.entry.18c77bc"]},
  {"id":"e8635bb","updatedAt":"2026-01-17T03:32:28+08:00","changes":["updates.entry.e8635bb"]},
  {"id":"4feca69","updatedAt":"2026-01-16T17:53:26+08:00","changes":["updates.entry.4feca69"]},
  {"id":"bcb800a","updatedAt":"2026-01-16T15:07:33+08:00","changes":["updates.entry.bcb800a"]},
  {"id":"5ac3d1f","updatedAt":"2026-01-16T12:26:37+08:00","changes":["updates.entry.5ac3d1f"]},
  {"id":"cbd58b1","updatedAt":"2026-01-16T04:29:43+08:00","changes":["updates.entry.cbd58b1"]},
  {"id":"67157f9","updatedAt":"2026-01-16T03:30:45+08:00","changes":["updates.entry.67157f9"]},
  {"id":"554633b","updatedAt":"2026-01-16T02:59:41+08:00","changes":["updates.entry.554633b"]},
] as const satisfies readonly [UpdateRecord, ...UpdateRecord[]];
