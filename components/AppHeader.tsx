'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Icon from '@/components/Icon';
import ThemeToggle from '@/components/ThemeToggle';

const NAV = [
  { href: '/', label: 'Feed' },
  { href: '/design', label: 'Design' },
] as const;

export default function AppHeader() {
  const pathname = usePathname();
  // A story permalink belongs to the feed for navigation purposes.
  const current = (href: string) =>
    href === '/' ? pathname === '/' || pathname.startsWith('/story/') : pathname.startsWith(href);

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link className="brand" href="/">
          <span className="brand-mark">
            <Icon name="feed" size={18} />
          </span>
          info-feed
        </Link>
        <div className="header-tools">
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} aria-current={current(n.href) ? 'page' : undefined}>
                {n.label}
              </Link>
            ))}
          </nav>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
