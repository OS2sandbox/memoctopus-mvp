import { TopBar } from '@/components/layout/TopBar';
import { ReviewAudioProvider } from '@/lib/review-audio-context';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ReviewAudioProvider>
      <div className="min-h-screen bg-[var(--bg)]">
        <TopBar />
        <main>{children}</main>
      </div>
    </ReviewAudioProvider>
  );
}
