import { useLocale } from "../../i18n";
import type { LucideIcon } from 'lucide-react';

export interface WorkspaceCommand {
  id: string; label: string; shortLabel?: string; group: string; icon: LucideIcon;
  run: (event: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; active?: boolean; danger?: boolean;
}
export function ToolButton({ command, compact = false }: { command: WorkspaceCommand; compact?: boolean }) {
  useLocale();
  const Icon = command.icon;
  return <button type="button" className={`workspace-tool ${compact ? 'compact' : ''} ${command.active ? 'active' : ''} ${command.danger ? 'danger' : ''}`}
    data-command={command.id} title={command.label} aria-label={compact ? command.label : undefined}
    aria-pressed={command.active} disabled={command.disabled} onClick={command.run}>
    <Icon size={compact ? 18 : 21} strokeWidth={1.8} aria-hidden="true" />
    {!compact && <span>{command.shortLabel ?? command.label}</span>}
  </button>;
}
