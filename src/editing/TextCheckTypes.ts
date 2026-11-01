export interface TextFontInfo {
  original: string[];
  used: string[];
  mode: 'original' | 'selected' | 'fallback';
}
export interface TextCheckIssue {
  blockId?: string;
  pageNumber?: number;
  kind: 'overflow' | 'unsupported' | 'font' | 'source';
  message: string;
  blocking: boolean;
}
export interface TextCheckReport { issues: TextCheckIssue[]; checked: number }
export class TextCheckError extends Error {
  issues: TextCheckIssue[];
  constructor(issues: TextCheckIssue[]) {
    // Keep every location for the inspector, but don't repeat the same page
    // explanation for each downstream paragraph in the export error dialog.
    super([...new Set(issues.map(issue => `${issue.pageNumber ? `Page ${issue.pageNumber}: ` : ''}${issue.message}`))].join('\n'));
    this.name = 'TextCheckError'; this.issues = issues;
  }
}
