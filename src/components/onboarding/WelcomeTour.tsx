'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useOnboarding } from '@/lib/onboarding/context';

const POINTS = [
  { title: 'Optag eller upload', body: 'Start en optagelse, indsæt et Teams-mødelink, eller upload en lydfil fra dashboardet.' },
  { title: 'Gennemgå', body: 'Ret følsomme oplysninger, tildel talere, og vælg hvad referatet skal indeholde.' },
  { title: 'Referat og eksport', body: 'Referatet genereres automatisk, kan redigeres, og eksporteres som PDF eller Markdown.' },
  { title: 'Arkiv og skabeloner', body: 'Alle dine møder ligger i Arkiv. Skabeloner styrer, hvordan fremtidige referater skrives.' },
];

/**
 * The global entry point: shown automatically for a first-time user, and
 * reopenable at any time from the TopBar's "Se en hurtig gennemgang" button.
 * This is deliberately a one-shot overview, not a step-by-step spotlight tour
 * — the 38 registered steps are independent, anchored hints (see
 * src/lib/onboarding/steps.ts), not a designed narrative sequence.
 */
export function WelcomeTour() {
  const { showWelcome, closeWelcome } = useOnboarding();

  return (
    <Dialog open={showWelcome} onOpenChange={(open) => !open && closeWelcome(true)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Velkommen til Referat</DialogTitle>
        </DialogHeader>
        <p style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: -4, marginBottom: 16 }}>
          Sådan kommer et møde igennem platformen — undervejs viser vi korte forklaringer, første gang du støder på noget.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {POINTS.map((p, i) => (
            <div key={p.title} style={{ display: 'flex', gap: 12 }}>
              <span
                style={{
                  flexShrink: 0,
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: 'var(--accent-wash)',
                  color: 'var(--accent-ink)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                }}
              >
                {i + 1}
              </span>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink)' }}>{p.title}</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>{p.body}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
          <button
            type="button"
            onClick={() => closeWelcome(true)}
            style={{
              fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)',
              background: 'none', border: '1px solid var(--line)', borderRadius: 'var(--radius)',
              padding: '6px 12px', cursor: 'pointer',
            }}
          >
            spring over
          </button>
          <button
            type="button"
            onClick={() => closeWelcome(false)}
            style={{
              fontFamily: 'var(--mono)', fontSize: 12, color: '#fff',
              background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius)',
              padding: '6px 14px', cursor: 'pointer',
            }}
          >
            kom i gang
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
