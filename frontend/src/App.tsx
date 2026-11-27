import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { AuthProvider } from '@/components/providers/AuthProvider';
import { ProjectProvider } from '@/components/providers/ProjectProvider';

const HomePage = lazy(() => import('@/pages/HomePage'));
const CreatePage = lazy(() => import('@/pages/CreatePage'));
const StudioPage = lazy(() => import('@/pages/StudioPage'));
const LibraryPage = lazy(() => import('@/pages/LibraryPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const SharePage = lazy(() => import('@/pages/SharePage'));
const CreatorProfilePage = lazy(() => import('@/pages/CreatorProfilePage'));
const LoginPage = lazy(() => import('@/pages/LoginPage'));

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
      <AuthProvider>
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
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<LoginPage />} />
                <Route path="/share" element={<SharePage />} />
                <Route path="/share/:slug" element={<SharePage />} />
                <Route path="/creators" element={<CreatorProfilePage />} />
                <Route path="/creators/:creatorId" element={<CreatorProfilePage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </AppShell>
        </ProjectProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
