import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <p style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--accent)', margin: '0 0 8px' }}>
          404
        </p>
        <h1 style={{ fontSize: 24, fontWeight: 300, color: 'var(--ink)', margin: '0 0 8px' }}>
          Siden findes ikke
        </h1>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 20px', lineHeight: 1.6 }}>
          Vi kunne ikke finde den side, du leder efter.
        </p>
        <Button asChild>
          <Link href="/dashboard">Til forsiden</Link>
        </Button>
      </div>
    </div>
  );
}
