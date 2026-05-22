import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Referat — Mødereferat-system',
  description: 'Opret og administrér mødereferater med automatisk transskribering',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="da">
      <body>{children}</body>
    </html>
  );
}
