import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';

const geistSans = GeistSans;
const geistMono = GeistMono;

export const metadata: Metadata = {
  title: 'OS2taletiltekst Referat',
  description: 'Opret og administrér mødereferater med automatisk transskribering',
  icons: {
    // The OS2 mark on its own — the wordmark is unreadable at tab size.
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    // Home-screen / bookmark tile: the stacked lockup fills a square properly,
    // where the header's wide one would sit in a thin strip.
    apple: [{ url: '/brand/os2taletiltekst-stacked.svg' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="da" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
