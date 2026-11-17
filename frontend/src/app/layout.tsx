import type { Metadata } from 'next';
import './globals.css';
import { ProjectProvider } from '@/components/providers/ProjectProvider';
import { AppShell } from '@/components/layout/AppShell';

export const metadata: Metadata = {
  title: 'AI Music Studio — Hybrid Multi-Agent DAW',
  description:
    'Hum-to-Music, AI Denoise, Auto-Tune & Hybrid MIDI/Audio Studio powered by Dual LLM Multi-Agent Architecture',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi">
      <body className="antialiased">
        <ProjectProvider>
          <AppShell>{children}</AppShell>
        </ProjectProvider>
      </body>
    </html>
  );
}
