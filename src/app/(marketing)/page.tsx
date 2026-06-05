import { Suspense } from 'react';
import { LogoMark } from '@/components/brand/logo-mark';
import { HeroForm } from '@/components/auth/hero-form';

const FEATURES = [
  { n: '01', t: 'Optagelse i browseren', d: 'Start en optagelse direkte i browseren — eller lad mødeboten deltage i Teams og Google Meet for dig.' },
  { n: '02', t: 'Referat på dansk', d: 'Automatisk transskription og et struktureret referat med beslutninger, handlepunkter og ansvarlige.' },
  { n: '03', t: 'Følsom information', d: 'Navne, adresser og personhenførbare oplysninger markeres automatisk, så de kan fjernes før deling.' },
  { n: '04', t: 'Kapitler og talere', d: 'Mødet inddeles i kapitler med talergenkendelse, så I hurtigt finder frem til det rigtige sted.' },
  { n: '05', t: 'Beslutninger & opgaver', d: 'Vigtige beslutninger og handlepunkter samles automatisk i en oversigt, klar til opfølgning.' },
  { n: '06', t: 'Eksport med ét klik', d: 'Eksportér til Word, PDF eller jeres egen skabelon — formateret og klar til at sende videre.' },
];

const SECURITY = [
  { t: 'Data i EU', d: 'Al behandling og lagring sker på servere i EU. Ingen data forlader Europa.' },
  { t: 'Følsom info markeres', d: 'Personhenførbare oplysninger fremhæves automatisk og kan fjernes, før referatet deles.' },
  { t: 'Adgangsstyring', d: 'Log ind sikkert og styr hvem i organisationen der har adgang.' },
  { t: 'Slet når I vil', d: 'Optagelser og referater kan slettes permanent på ethvert tidspunkt — I ejer jeres data.' },
];

const CHIPS = ['Dansk transskription', 'Følsom info markeres', 'Data i EU'];

function Container({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', padding: '0 32px', ...style }}>
      {children}
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: 'var(--font-geist-mono)',
      fontSize: 11.5,
      letterSpacing: '0.14em',
      textTransform: 'uppercase' as const,
      color: 'var(--accent)',
    }}>
      {children}
    </div>
  );
}

function Nav() {
  return (
    <div style={{
      position: 'sticky',
      top: 0,
      zIndex: 20,
      background: 'rgba(255,255,255,0.86)',
      backdropFilter: 'saturate(180%) blur(8px)',
      WebkitBackdropFilter: 'saturate(180%) blur(8px)',
      borderBottom: '1px solid var(--line)',
    }}>
      <Container style={{ height: 62, display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <LogoMark size={26} />
          <span style={{
            fontFamily: 'var(--font-geist-mono)',
            fontWeight: 500,
            fontSize: 14.5,
            letterSpacing: '-0.03em',
            color: 'var(--ink)',
            whiteSpace: 'nowrap',
          }}>
            memoctopus<span style={{ color: 'var(--accent)', padding: '0 5px' }}>·</span>referat
          </span>
        </div>

        <nav style={{ marginLeft: 28, display: 'flex', gap: 24 }}>
          {[['Funktioner', '#funktioner'], ['Sikkerhed', '#sikkerhed']].map(([label, href]) => (
            <a
              key={label}
              href={href}
              style={{ fontSize: 13.5, color: 'var(--ink-2)', textDecoration: 'none', whiteSpace: 'nowrap', transition: 'color 120ms ease' }}
            >
              {label}
            </a>
          ))}
        </nav>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
          <a
            href="#hero"
            style={{ fontSize: 13.5, color: 'var(--ink-2)', textDecoration: 'none', whiteSpace: 'nowrap', transition: 'color 120ms ease' }}
          >
            Log ind
          </a>
          <a
            href="#hero"
            style={{
              fontSize: 13.5,
              fontWeight: 500,
              padding: '8px 14px',
              borderRadius: 5,
              background: 'var(--accent)',
              color: '#fff',
              border: '1px solid var(--accent)',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
              transition: 'background 130ms ease, border-color 130ms ease',
              lineHeight: 1,
            }}
          >
            Opret konto
          </a>
        </div>
      </Container>
    </div>
  );
}

function Hero() {
  return (
    <section
      id="hero"
      style={{ padding: '84px 0', borderBottom: '1px solid var(--line)' }}
    >
      <Container>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.05fr) minmax(320px, 0.95fr)',
          gap: 64,
          alignItems: 'center',
          minHeight: '560px',
        }}>
          {/* Value column */}
          <div>
            <Eyebrow>Mødereferater · automatisk</Eyebrow>
            <h1 style={{
              fontWeight: 300,
              fontSize: 50,
              lineHeight: 1.04,
              letterSpacing: '-0.035em',
              color: 'var(--ink)',
              margin: '20px 0 0',
            }}>
              Fra møde til<br />færdigt referat.
            </h1>
            <p style={{
              fontSize: 17,
              lineHeight: 1.55,
              color: 'var(--ink-2)',
              margin: '22px 0 0',
              maxWidth: 520,
            }}>
              Memoctopus optager jeres møder, transskriberer på dansk og skriver et referat, I kan stå inde for. Følsom information markeres automatisk, så I deler trygt.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginTop: 26 }}>
              {CHIPS.map((c) => (
                <span
                  key={c}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    fontFamily: 'var(--font-geist-mono)',
                    fontSize: 12,
                    color: 'var(--ink-2)',
                    border: '1px solid var(--line-2)',
                    borderRadius: 999,
                    padding: '5px 11px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--accent)', flexShrink: 0 }} />
                  {c}
                </span>
              ))}
            </div>
          </div>

          {/* Auth form card */}
          <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            padding: '32px 30px',
            boxShadow: '0 1px 2px rgba(17,17,17,0.04), 0 22px 56px -30px rgba(17,17,17,0.18)',
          }}>
            <Suspense>
              <HeroForm />
            </Suspense>
          </div>
        </div>
      </Container>
    </section>
  );
}

function Funktioner() {
  return (
    <section id="funktioner" style={{ padding: '80px 0', background: 'var(--bg)' }}>
      <Container>
        <div style={{ maxWidth: 620 }}>
          <Eyebrow>Funktioner</Eyebrow>
          <h2 style={{
            fontWeight: 400,
            fontSize: 36,
            lineHeight: 1.12,
            letterSpacing: '-0.03em',
            color: 'var(--ink)',
            margin: '16px 0 0',
          }}>
            Alt fra optagelse til delt referat.
          </h2>
          <p style={{ fontSize: 16, lineHeight: 1.55, color: 'var(--ink-2)', margin: '16px 0 0' }}>
            Ét værktøj til hele forløbet — så referatet er færdigt, før mødet er glemt.
          </p>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 1,
          background: 'var(--line)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          overflow: 'hidden',
          marginTop: 40,
        }}>
          {FEATURES.map((f) => (
            <div
              key={f.n}
              className="feature-cell"
              style={{
                background: 'var(--bg)',
                padding: '26px 24px 28px',
                transition: 'background 130ms ease',
              }}
            >
              <div style={{
                fontFamily: 'var(--font-geist-mono)',
                fontSize: 11.5,
                color: 'var(--accent)',
                letterSpacing: '0.06em',
              }}>
                {f.n}
              </div>
              <h3 style={{
                fontWeight: 500,
                fontSize: 16.5,
                letterSpacing: '-0.01em',
                color: 'var(--ink)',
                margin: '14px 0 8px',
              }}>
                {f.t}
              </h3>
              <p style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 }}>
                {f.d}
              </p>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}

function Datasikkerhed() {
  return (
    <section
      id="sikkerhed"
      style={{
        padding: '80px 0',
        background: 'var(--surface-2)',
        borderTop: '1px solid var(--line)',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <Container>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 0.9fr) minmax(0, 1.1fr)',
          gap: 56,
          alignItems: 'start',
        }}>
          <div>
            <Eyebrow>Datasikkerhed</Eyebrow>
            <h2 style={{
              fontWeight: 400,
              fontSize: 34,
              lineHeight: 1.12,
              letterSpacing: '-0.03em',
              color: 'var(--ink)',
              margin: '16px 0 0',
            }}>
              Bygget til følsomme møder.
            </h2>
            <p style={{ fontSize: 16, lineHeight: 1.55, color: 'var(--ink-2)', margin: '16px 0 0', maxWidth: 380 }}>
              Referater fra udvalg, bestyrelser og ledelse indeholder personoplysninger. Memoctopus er bygget til at håndtere dem ansvarligt — i overensstemmelse med GDPR.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '28px 36px' }}>
            {SECURITY.map((s) => (
              <div key={s.t} style={{ borderTop: '1px solid var(--line-2)', paddingTop: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--accent)', flexShrink: 0 }} />
                  <h3 style={{ fontWeight: 500, fontSize: 15.5, letterSpacing: '-0.01em', color: 'var(--ink)', margin: 0 }}>
                    {s.t}
                  </h3>
                </div>
                <p style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--ink-2)', margin: '9px 0 0' }}>
                  {s.d}
                </p>
              </div>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}

function Footer() {
  return (
    <footer style={{ background: 'var(--bg)' }}>
      <Container style={{ padding: '40px 32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' as const }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <LogoMark size={24} />
            <span style={{
              fontFamily: 'var(--font-geist-mono)',
              fontWeight: 500,
              fontSize: 13.5,
              letterSpacing: '-0.03em',
              color: 'var(--ink)',
              whiteSpace: 'nowrap',
            }}>
              memoctopus<span style={{ color: 'var(--accent)', padding: '0 5px' }}>·</span>referat
            </span>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 22 }}>
            {[['Funktioner', '#funktioner'], ['Sikkerhed', '#sikkerhed']].map(([label, href]) => (
              <a key={label} href={href} style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
                {label}
              </a>
            ))}
            <a href="#hero" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
              Log ind
            </a>
          </div>
        </div>
        <div style={{ height: 1, background: 'var(--line)', margin: '20px 0 0' }} />
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 14,
          fontFamily: 'var(--font-geist-mono)',
          fontSize: 11,
          color: 'var(--muted-2)',
          letterSpacing: '0.3px',
        }}>
          <span>© 2026 MEMOCTOPUS</span>
          <span>ET PRODUKT FRA SYV.AI</span>
        </div>
      </Container>
    </footer>
  );
}

export default function LandingPage() {
  return (
    <div style={{ fontFamily: 'var(--font-geist-sans)', color: 'var(--ink)', background: 'var(--bg)', minHeight: '100vh' }}>
      <Nav />
      <main>
        <Hero />
        <Funktioner />
        <Datasikkerhed />
      </main>
      <Footer />
    </div>
  );
}
