'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface AdminNavItem {
  key: string;
  href: string;
  label: string;
}

/** Section tabs for /admin. The list comes from the server gate, so it matches what the server lets the user open. */
export function AdminNav({ sections }: { sections: AdminNavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Administration" className="flex gap-6 border-b border-[var(--line)]">
      {sections.map((s) => {
        const active = s.href === '/admin' ? pathname === '/admin' : pathname.startsWith(s.href);
        return (
          <Link
            key={s.key}
            href={s.href}
            aria-current={active ? 'page' : undefined}
            className="relative py-2 text-sm"
            style={{
              fontWeight: active ? 500 : 400,
              color: active ? 'var(--ink)' : 'var(--muted)',
              borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
              marginBottom: -1,
              textDecoration: 'none',
            }}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
