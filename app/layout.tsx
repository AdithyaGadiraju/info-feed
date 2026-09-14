import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'info-feed',
  description: 'Personal multi-lane feed: ai, ai_dev, markets, betting, gamedev, games.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0a0c0f',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <div className="mx-auto w-full max-w-2xl px-4 pb-24 pt-5 sm:px-6">{children}</div>
      </body>
    </html>
  );
}
