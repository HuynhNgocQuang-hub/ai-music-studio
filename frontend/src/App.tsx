import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ProjectProvider } from '@/components/providers/ProjectProvider';

const HomePage = lazy(() => import('@/pages/HomePage'));
const CreatePage = lazy(() => import('@/pages/CreatePage'));
const StudioPage = lazy(() => import('@/pages/StudioPage'));
const LibraryPage = lazy(() => import('@/pages/LibraryPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));

function RouteLoadingFallback() {
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center text-xs text-slate-400">
      Đang tải không gian làm việc...
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ProjectProvider>
        <AppShell>
          <Suspense fallback={<RouteLoadingFallback />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/create" element={<CreatePage />} />
              <Route path="/studio" element={<StudioPage />} />
              <Route path="/studio/:id" element={<StudioPage />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </AppShell>
      </ProjectProvider>
    </BrowserRouter>
  );
}
