import { ReactNode } from 'react';

import { Sidebar, type AppPageKey } from './Sidebar';
import { Topbar } from './Topbar';

interface AppLayoutProps {
  children: ReactNode;
  activePage?: AppPageKey;
  title?: string;
  subtitle?: string;
  showCalendarControls?: boolean;
  onNavigate?: (page: AppPageKey) => void;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  onCreate: () => void;
}

export function AppLayout({
  children,
  activePage = 'agentWorkspace',
  title = 'Agent 工作台',
  subtitle,
  showCalendarControls = false,
  onNavigate = () => undefined,
  onToday,
  onPrev,
  onNext,
  onCreate
}: AppLayoutProps) {
  return (
    <div className="app-shell">
      <Sidebar activePage={activePage} onNavigate={onNavigate} />
      <section className="workspace-shell">
        <Topbar
          title={title}
          subtitle={subtitle}
          showCalendarControls={showCalendarControls}
          onToday={onToday}
          onPrev={onPrev}
          onNext={onNext}
          onCreate={onCreate}
        />
        {children}
      </section>
    </div>
  );
}
