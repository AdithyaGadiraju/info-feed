import type { Metadata, Viewport } from 'next';
import { Figtree } from 'next/font/google';
import AppHeader from '@/components/AppHeader';
import './globals.css';

// next/font self-hosts Figtree and sets --font-brand, which boxy.css reads.
const brand = Figtree({ subsets: ['latin'], variable: '--font-brand', display: 'swap' });

export const metadata: Metadata = {
  title: 'info-feed',
  description: 'Personal multi-lane feed: ai, ai_dev, ai_gamedev, markets, betting, gamedev, games.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffffff',
  // Lets fixed bottom bars pad for the iPhone home indicator.
  viewportFit: 'cover',
};

// Applies the saved theme before first paint, so a dark reader never sees a light flash.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");if(t)document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Knobs per docs/ui-design.md. The head script may change data-theme before
    // hydration, hence suppressHydrationWarning.
    <html lang="en" className={brand.variable} data-tone="bold" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <AppHeader />
        <main>{children}</main>
      </body>
    </html>
  );
}
