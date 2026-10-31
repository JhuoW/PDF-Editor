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
    super(issues.map(issue => `${issue.pageNumber ? `Page ${issue.pageNumber}: ` : ''}${issue.message}`).join('\n'));
    this.name = 'TextCheckError'; this.issues = issues;
  }
}
