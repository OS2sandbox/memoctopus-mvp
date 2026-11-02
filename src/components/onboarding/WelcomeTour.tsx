'use client';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useOnboarding } from '@/lib/onboarding/context';

const POINTS = [
  { title: 'Optag eller upload', body: 'Start en optagelse, tilføj et Teams-mødelink eller upload en lydfil.' },
  { title: 'Gennemgå', body: 'Vælg skabelon, tildel talere og håndter følsomme oplysninger.' },
  { title: 'Generér referat og eksportér', body: 'Få et automatisk udkast, som du kan redigere og eksportere.' },
  { title: 'Arkiv', body: 'Find tidligere møder og dine skabeloner samlet ét sted. Rediger eksisterende skabeloner, hent tidligere referater eller opret et nyt referat.' },
];

/**
 * The global entry point: shown automatically for a first-time user, and
 * reopenable at any time from the TopBar's "Se en hurtig gennemgang" button.
 * This is deliberately a one-shot overview, not a step-by-step spotlight tour
 * — the 38 registered steps are independent, anchored hints (see
 * src/lib/onboarding/steps.ts), not a designed narrative sequence.
 */
export function WelcomeTour() {
  const { showWelcome, closeWelcome, startTour } = useOnboarding();

  return (
    <Dialog open={showWelcome} onOpenChange={(open) => !open && closeWelcome(true)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sådan fungerer OS2taletiltekst</DialogTitle>
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
          <Button type="button" variant="outline" size="sm" onClick={() => closeWelcome(true)}>
            spring over
          </Button>
          <Button type="button" size="sm" onClick={startTour}>
            kom i gang
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
