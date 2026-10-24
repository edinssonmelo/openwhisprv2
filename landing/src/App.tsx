import { useEffect, useState } from 'react';
import { CONTACT_EMAIL, RELEASE_MANIFEST, validRelease, type Release } from './config';
import { chooseLanguage, savedLanguage, type Language } from './locale';
import { copy } from './copy';
import Experience from './Experience';

const timezone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } };

function Mark() { return <span className="mark" aria-hidden="true">{[10, 20, 28, 17, 9].map((h, i) => <i key={i} style={{ height: h }} />)}</span>; }

export default function App() {
  const [language, setLanguage] = useState<Language>(() => chooseLanguage(undefined, timezone(), savedLanguage()));
  const [release, setRelease] = useState<Release | null>(null);
  const [downloadState, setDownloadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const t = copy[language];

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3000);
    (async () => {
      let country: string | undefined;
      try {
        const response = await fetch('/locale.json', { cache: 'no-store', signal: controller.signal });
        if (response.ok) country = (await response.json()).country;
      } catch { /* Dev preview or edge header unavailable. */ }
      if (!country || country === 'XX' || country === 'T1') {
        try {
          // Same-origin Cloudflare trace supplies country when the tunnel omits CF-IPCountry.
          // Read only the country; never store IP addresses or request browser location.
          const response = await fetch('/cdn-cgi/trace', { cache: 'no-store', signal: controller.signal });
          if (response.ok) country = (await response.text()).match(/^loc=([A-Z]{2})$/m)?.[1];
        } catch { /* Offline: use timezone as an approximate fallback. */ }
      }
      if (!controller.signal.aborted) setLanguage(chooseLanguage(country, timezone(), savedLanguage()));
    })().finally(() => window.clearTimeout(timeout));
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = `Openwhispr · ${t.title.join(' ')}`;
    document.querySelector('meta[name="description"]')?.setAttribute('content', t.intro);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', document.title);
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', t.intro);
  }, [language, t]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    let active = true;
    setDownloadState('loading');
    (async () => {
      try {
        const response = await fetch(RELEASE_MANIFEST, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('manifest');
        const candidate: unknown = await response.json();
        if (!validRelease(candidate)) throw new Error('invalid release');
        const file = await fetch(candidate.file, { method: 'HEAD', cache: 'no-store', signal: controller.signal });
        if (!file.ok || file.headers.get('content-type')?.includes('text/html') || Number(file.headers.get('content-length')) !== candidate.bytes) throw new Error('missing artifact');
        setRelease(candidate); setDownloadState('ready');
      } catch { if (active) setDownloadState('error'); }
      finally { window.clearTimeout(timeout); }
    })();
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [attempt]);

  const switchLanguage = (value: Language) => {
    setLanguage(value);
    try { localStorage.setItem('openwhispr-language', value); } catch { /* Private browsing still supports switching. */ }
  };
  const download = (small = false) => downloadState === 'ready' && release
    ? <a className={`btn btn--primary ${small ? 'btn--small' : ''}`} href={release.file} download>{t.download} <span aria-hidden="true">↗</span></a>
    : <div className="download-status"><button className={`btn ${small ? 'btn--small' : ''}`} disabled>{downloadState === 'loading' ? t.loading : t.unavailable}</button>{downloadState === 'error' && <button className="text-button" onClick={() => setAttempt(n => n + 1)}>{t.retry}</button>}</div>;

  return <div className="page">
    <a className="skip" href="#main">{t.skip}</a>
    <header className="nav">
      <a className="brand" href="#top" aria-label="Openwhispr"><Mark />Openwhispr<span className="beta">BETA</span></a>
      <nav aria-label={language === 'es' ? 'Navegación principal' : 'Main navigation'}>{t.nav.map((label, i) => <a href={['#experience', '#how-it-works', '#privacy'][i]} key={label}>{label}</a>)}</nav>
      <div className="language" role="group" aria-label={t.language}>{(['en', 'es'] as const).map(lang => <button key={lang} aria-pressed={language === lang} onClick={() => switchLanguage(lang)}>{lang.toUpperCase()}</button>)}</div>
    </header>
    <main id="main">
      <section className="hero section" id="top">
        <div className="hero__glow" aria-hidden="true" />
        <div className="eyebrow"><span className="status-dot" />{t.badge}</div>
        <h1>{t.title[0]}<br /><span>{t.title[1]}</span></h1>
        <p className="hero__intro">{t.intro}</p>
        <div className="hero__actions">{download()}<a className="btn btn--ghost" href="#experience">{t.explore}<span aria-hidden="true">↓</span></a></div>
        <p className="caption">{t.compatibility}</p>

        <Experience language={language} />
      </section>

      <section className="section features"><p className="eyebrow">{t.eyebrow}</p><h2 className="section-title">{t.featuresTitle}</h2><div className="feature-grid">{t.features.map(([n, title, text]) => <article className="feature" key={n}><span className="feature__number">{n}</span><h3>{title}</h3><p>{text}</p></article>)}</div></section>
      <section className="section how" id="how-it-works"><div><p className="eyebrow">{t.how}</p><h2 className="section-title">{t.howTitle}</h2><div className="orbit" aria-hidden="true"><div /><div /><Mark /></div></div><ol className="steps">{t.steps.map(([title, text], i) => <li key={title}><span>{String(i + 1).padStart(2, '0')}</span><div><h3>{title}</h3><p>{text}</p></div></li>)}</ol></section>
      <section className="privacy-section" id="privacy"><div className="section privacy"><div className="privacy__symbol" aria-hidden="true"><svg viewBox="0 0 100 112" fill="none"><path d="M50 5L90 20V53C90 80 65 98 50 106C35 98 10 80 10 53V20L50 5Z" stroke="currentColor" strokeWidth="1.5" /><rect x="34" y="46" width="32" height="27" rx="6" stroke="currentColor" strokeWidth="1.5" /><path d="M40 46V37A10 10 0 0160 37V46" stroke="currentColor" strokeWidth="1.5" /></svg></div><div><p className="eyebrow">{t.privacyLabel}</p><h2 className="section-title">{t.privacyTitle}</h2><p>{t.privacyBody}</p><ul>{t.privacyPoints.map(point => <li key={point}><span aria-hidden="true">✓</span>{point}</li>)}</ul></div></div></section>
      <section className="section faq"><h2 className="section-title">{t.faq}</h2><div>{t.faqs.map(([q, a]) => <details key={q}><summary>{q}<span aria-hidden="true">+</span></summary><p>{a}</p></details>)}</div></section>
      <section className="section closing" id="download"><Mark /><h2>{t.closing.split('\n').map(line => <span key={line}>{line}</span>)}</h2><p>{t.closingBody}</p>{download()}<p className="caption">{t.compatibility}</p>{release && downloadState === 'ready' && <details className="release-details"><summary>{t.details} · v{release.version} · {Math.round(release.bytes / 1024 / 1024)} MB</summary><p>{t.install}</p><p>{t.unsigned} · macOS {release.minimumMacOS}+</p><label>{t.checksum}<code>{release.sha256}</code></label></details>}</section>
    </main>
    <footer className="footer"><a className="brand" href="#top"><Mark />Openwhispr</a><p>{t.footer}</p><a href={`mailto:${CONTACT_EMAIL}`}>{t.contact} ↗</a></footer>
  </div>;
}
