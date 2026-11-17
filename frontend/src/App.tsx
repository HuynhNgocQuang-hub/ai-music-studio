import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ProjectProvider } from '@/components/providers/ProjectProvider';
import CreatePage from '@/pages/CreatePage';
import HomePage from '@/pages/HomePage';
import LibraryPage from '@/pages/LibraryPage';
import SettingsPage from '@/pages/SettingsPage';
import StudioPage from '@/pages/StudioPage';

export default function App() {
  return (
    <BrowserRouter>
      <ProjectProvider>
        <AppShell>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/create" element={<CreatePage />} />
            <Route path="/studio" element={<StudioPage />} />
            <Route path="/studio/:id" element={<StudioPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppShell>
      </ProjectProvider>
    </BrowserRouter>
  );
}
