import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';

const geistSans = GeistSans;
const geistMono = GeistMono;

export const metadata: Metadata = {
  title: 'OS2taletiltekst Referat',
  description: 'Opret og administrér mødereferater med automatisk transskribering',
  // Declared here rather than as app/icon.* files: in Next 15, icons set in
  // metadata replace the file-convention ones, so keep a single source.
  icons: {
    // The OS2 mark on its own — the wordmark is unreadable at tab size. The SVG
    // turns the mark white on a dark tab strip.
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    // Home-screen / bookmark tile: the stacked lockup on white, rendered from
    // public/brand/os2taletiltekst-stacked.svg. A PNG, because iOS ignores an SVG
    // apple-touch-icon, and opaque, because iOS paints transparency black.
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
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
