import type { Metadata } from 'next';
import Link from 'next/link';
import Icon, { type IconName } from '@/components/Icon';
import Glyph from './glyphs';
import KnobSwitcher from './KnobSwitcher';
import s from './design.module.css';

export const metadata: Metadata = { title: 'Design · info-feed' };

/** Living style guide: every boxy.css pattern, dressed in info-feed copy. Keep in step with app/boxy.css. */

type Verdict = 'confirmed' | 'unconfirmed' | 'disputed' | 'false';

const VERDICTS: Record<Verdict, { label: string; tag: string; icon: IconName }> = {
  confirmed: { label: 'Confirmed', tag: 'tag-green', icon: 'check' },
  unconfirmed: { label: 'Unconfirmed', tag: 'tag-amber', icon: 'help' },
  disputed: { label: 'Disputed', tag: 'tag-red', icon: 'alert' },
  false: { label: 'False', tag: 'tag-red', icon: 'x' },
};

function VerdictTag({ verdict }: { verdict: Verdict }) {
  const v = VERDICTS[verdict];
  return (
    <span className={`tag ${v.tag}`}>
      <Icon name={v.icon} size={14} />
      {v.label}
    </span>
  );
}

const SWATCHES: { token: string; name: string; extra?: string }[] = [
  { token: '--bg', name: 'Background' },
  { token: '--surface', name: 'Surface' },
  { token: '--surface-2', name: 'Surface 2' },
  { token: '--surface-3', name: 'Surface 3' },
  { token: '--border', name: 'Border' },
  { token: '--border-strong', name: 'Border strong' },
  { token: '--text', name: 'Text' },
  { token: '--text-2', name: 'Text 2' },
  { token: '--text-3', name: 'Text 3' },
  { token: '--accent', name: 'Accent' },
  { token: '--accent-soft', name: 'Accent soft', extra: s.chipAccentSoft },
  { token: '--highlight', name: 'Highlight (done)' },
  { token: '--amber', name: 'Amber' },
  { token: '--red-ink', name: 'Red' },
  { token: '--green-ink', name: 'Green' },
];

const RECENT: { title: string; lane: string; verdict: Verdict; score: number }[] = [
  { title: 'Gaussian splats land in Godot 4.6', lane: 'AI Gamedev', verdict: 'confirmed', score: 5 },
  { title: 'Fed hints at a December rate cut', lane: 'Markets', verdict: 'unconfirmed', score: 4 },
  { title: 'Open model tops coding leaderboard', lane: 'AI News', verdict: 'disputed', score: 3 },
  { title: 'Steam to drop Windows 10 support', lane: 'Games', verdict: 'false', score: 2 },
];

export default function DesignPage() {
  return (
    <>
      {/* ===== Page head ===== */}
      <div className="page-head">
        <Link className="back-link" href="/">
          <Icon name="back" />
          Feed
        </Link>
        <p className="eyebrow">Style guide</p>
        <h1>Design</h1>
        <p className="lede">
          Every pattern in <span className="mono">boxy.css</span>, shown with info-feed copy.
        </p>
      </div>

      <KnobSwitcher />

      {/* ===== Foundations ===== */}
      <section className={s.section} id="foundations" aria-labelledby="foundations-title">
        <div className="section-head">
          <h2 className="eyebrow" id="foundations-title">Foundations</h2>
          <span className="count">16</span>
        </div>
        <p className={s.intro}>Pages use these tokens only. Never hard-code a colour, radius or shadow.</p>
        <div className={s.swatches}>
          {SWATCHES.map((sw) => (
            <div key={sw.token} className={s.swatch}>
              <div className={`${s.chip} ${sw.extra ?? ''}`} style={{ background: `var(${sw.token})` }} />
              <strong className="small">{sw.name}</strong>
              <span className="mono small subtle">{sw.token}</span>
            </div>
          ))}
          <div className={s.swatch}>
            <div className={`${s.chip} ${s.chipFocus}`} />
            <strong className="small">Focus ring</strong>
            <span className="mono small subtle">--focus-ring</span>
          </div>
        </div>
        <div className={`card ${s.type}`}>
          <div>
            <span className="eyebrow">Display / h1</span>
            <span className={s.display}>Today&apos;s digest</span>
          </div>
          <div>
            <span className="eyebrow">Heading / h2</span>
            <span className={s.heading}>AI Gamedev</span>
          </div>
          <div>
            <span className="eyebrow">Sub / h3</span>
            <span className={s.sub}>Gaussian splats land in Godot 4.6</span>
          </div>
          <div>
            <span className="eyebrow">Body</span>
            <span>Claude summarises every story in two or three sentences.</span>
          </div>
          <div>
            <span className="eyebrow">Muted</span>
            <span className="muted">One supporting line under a title.</span>
          </div>
          <div>
            <span className="eyebrow">Eyebrow</span>
            <span className="eyebrow">Top stories</span>
          </div>
          <div>
            <span className="eyebrow">Numbers</span>
            <span className={`tnum ${s.numbers}`}>128 · 6 · 4.5</span>
          </div>
        </div>
      </section>

      {/* ===== Progress and summary ===== */}
      <section className={s.section} id="structure" aria-labelledby="structure-title">
        <div className="section-head">
          <h2 className="eyebrow" id="structure-title">Progress and summary</h2>
        </div>
        <div className="card">
          <p className={`eyebrow ${s.label}`}>Stepper (true multi-step flows only)</p>
          <ol className="stepper" aria-label="Digest run progress">
            <li className="is-done">
              <span className="step step-done" aria-hidden="true">
                <Icon name="check" size={15} />
              </span>
              Fetch<span className="visually-hidden"> (done)</span>
            </li>
            <li aria-current="step">
              <span className="step" aria-hidden="true">2</span>Score
            </li>
            <li>
              <span className="step step-todo" aria-hidden="true">3</span>Summarise
            </li>
            <li>
              <span className="step step-todo" aria-hidden="true">4</span>Fact-check
            </li>
          </ol>
        </div>
        <dl className="stat-strip">
          <div className="stat">
            <dt className="eyebrow">Stories today</dt>
            <dd className="stat-value">128</dd>
          </div>
          <div className="stat">
            <dt className="eyebrow">Lanes</dt>
            <dd className="stat-value">6</dd>
          </div>
          <div className="stat">
            <dt className="eyebrow">Sources</dt>
            <dd className="stat-value">6</dd>
          </div>
          <div className="stat">
            <dt className="eyebrow">Avg. score</dt>
            <dd className="stat-value">3.4</dd>
          </div>
        </dl>
      </section>

      {/* ===== Form flow ===== */}
      <section className={s.section} id="flow" aria-labelledby="flow-title">
        <div className="section-head">
          <h2 className="eyebrow" id="flow-title">Form flow</h2>
          <span className="small subtle">Panels: done, active, to do</span>
        </div>

        <div className={s.flow}>
          <form className="stack" aria-label="Digest settings">
            {/* Panel: done */}
            <section className="panel" aria-labelledby="p1-title">
              <div className="panel-head">
                <span className="step step-done" aria-hidden="true">
                  <Icon name="check" size={15} />
                </span>
                <div className="panel-head-text">
                  <h2 id="p1-title">
                    Delivery<span className="visually-hidden"> (done)</span>
                  </h2>
                  <p>Where the digest goes each morning.</p>
                </div>
              </div>
              <div className="panel-body grid-2">
                <div className="field">
                  <label className="field-label" htmlFor="name">
                    Your name
                  </label>
                  <input className="input" id="name" name="name" autoComplete="name" defaultValue="Gadi" />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="email">
                    Email digest to
                  </label>
                  <input
                    className="input"
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    defaultValue="gadi@example.com"
                  />
                </div>
              </div>
            </section>

            {/* Panel: active */}
            <section className="panel" aria-labelledby="p2-title">
              <div className="panel-head">
                <span className="step" aria-hidden="true">2</span>
                <div className="panel-head-text">
                  <h2 id="p2-title">What you read</h2>
                  <p>Only what changes which stories make the cut.</p>
                </div>
              </div>
              <div className="panel-body stack">
                <fieldset className="option-cards">
                  <legend className="field-label">Digest frequency</legend>
                  <label className="option-card">
                    <input type="radio" name="frequency" value="daily" defaultChecked />
                    <span className="option-card-body">
                      <strong>Daily</strong>
                      <p>One digest at 07:00 with the last 24 hours.</p>
                      <span className="meta">
                        <Icon name="clock" size={14} />
                        Next run 07:00
                      </span>
                    </span>
                  </label>
                  <label className="option-card">
                    <input type="radio" name="frequency" value="twice" />
                    <span className="option-card-body">
                      <strong>Twice daily</strong>
                      <p>Morning and evening, half the stories each.</p>
                      <span className="meta">
                        <Icon name="clock" size={14} />
                        07:00 and 18:00
                      </span>
                    </span>
                  </label>
                </fieldset>

                <fieldset className="chips">
                  <legend className="field-label">Lead lane</legend>
                  <label className="chip">
                    <input type="radio" name="lead" value="ai" defaultChecked />
                    <span>AI News</span>
                  </label>
                  <label className="chip">
                    <input type="radio" name="lead" value="markets" />
                    <span>Markets</span>
                  </label>
                  <label className="chip">
                    <input type="radio" name="lead" value="games" />
                    <span>Games</span>
                  </label>
                </fieldset>

                <div className="field">
                  <div className="inline-field">
                    <label className="field-label" htmlFor="min-score">
                      Minimum score
                    </label>
                    <select className="select" id="min-score" name="minScore" required defaultValue="">
                      <option value="" disabled>
                        Choose…
                      </option>
                      <option>1, show everything</option>
                      <option>2</option>
                      <option>3</option>
                      <option>4</option>
                      <option>5, only the best</option>
                    </select>
                  </div>
                </div>

                <div className="field">
                  <div className="inline-field">
                    <label className="field-label" htmlFor="per-lane">
                      Stories per lane
                    </label>
                    <div className="input-group">
                      <input
                        className="input"
                        id="per-lane"
                        name="perLane"
                        type="number"
                        inputMode="numeric"
                        defaultValue={20}
                        aria-describedby="per-lane-help"
                      />
                      <span className="input-unit">stories</span>
                    </div>
                  </div>
                  <p className="field-help" id="per-lane-help">
                    Highest scores first. The rest stay in the archive.
                  </p>
                </div>

                <div className="field">
                  <div className="inline-field">
                    <label className="field-label" htmlFor="extra-feed">
                      Extra RSS feed <span className="field-optional">(optional)</span>
                    </label>
                    <input className="input" id="extra-feed" name="extraFeed" type="url" placeholder="https://" />
                  </div>
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="skip">
                    What should Claude skip? <span className="field-optional">(optional)</span>
                  </label>
                  <p className="field-help" id="skip-help">
                    Two or three topics is plenty.
                  </p>
                  <textarea
                    className="textarea"
                    id="skip"
                    name="skip"
                    aria-describedby="skip-help"
                    placeholder="Crypto, celebrity news…"
                  />
                </div>

                <label className="check">
                  <input type="checkbox" name="factCheck" defaultChecked /> Fact-check every story before it ships
                </label>
              </div>
            </section>

            {/* Panel: to do */}
            <section className="panel" aria-labelledby="p3-title">
              <div className="panel-head">
                <span className="step step-todo" aria-hidden="true">3</span>
                <div className="panel-head-text">
                  <h2 id="p3-title">Import feeds</h2>
                  <p>Bring your reader&apos;s subscriptions in one go.</p>
                </div>
              </div>
              <div className="panel-body">
                <label className="drop">
                  <input
                    className="visually-hidden"
                    type="file"
                    name="opml"
                    accept=".opml,.xml"
                    aria-describedby="opml-help"
                  />
                  <span className="drop-icon">
                    <Glyph name="upload" size={24} />
                  </span>
                  <strong>Upload an OPML file</strong>
                  <span className="small subtle" id="opml-help">
                    OPML or XML, up to 1 MB. Drag it here or tap to choose.
                  </span>
                </label>
              </div>
            </section>

            <div className="sticky-actions">
              <button className="btn btn-primary" type="button">
                Save settings
                <Glyph name="arrowRight" size={18} />
              </button>
              <button className="btn btn-secondary" type="button">
                Preview digest
              </button>
            </div>
          </form>

          {/* Aside: review panel */}
          <aside className={`stack ${s.aside}`} aria-label="Digest summary">
            <section className="panel" aria-labelledby="rev-title">
              <div className="panel-bar">
                <h3 id="rev-title">Your digest</h3>
                <a className="btn btn-dark btn-sm" href="#flow">
                  <Glyph name="pencil" size={14} />
                  Edit
                </a>
              </div>
              <dl className="review-list">
                <div className="review-row">
                  <dt>Lanes</dt>
                  <dd>All 6, AI News first</dd>
                </div>
                <div className="review-row">
                  <dt>Frequency</dt>
                  <dd>Daily at 07:00</dd>
                  <dd className="review-action">
                    <a className="change-link" href="#flow">
                      Change<span className="visually-hidden"> frequency</span>
                    </a>
                  </dd>
                </div>
                <div className="review-row">
                  <dt>Stories per lane</dt>
                  <dd className="tnum">20</dd>
                  <dd className="review-action">
                    <a className="change-link" href="#per-lane">
                      Change<span className="visually-hidden"> stories per lane</span>
                    </a>
                  </dd>
                </div>
                <div className="review-row">
                  <dt>OPML import</dt>
                  <dd className="is-empty">Not added yet</dd>
                  <dd className="review-action">
                    <a className="change-link" href="#p3-title">
                      Add<span className="visually-hidden"> OPML import</span>
                    </a>
                  </dd>
                </div>
              </dl>
            </section>
            <div className="callout callout-info">
              <Glyph name="info" />
              <div>
                <p className="callout-title">Summaries come from Claude</p>
                <p>Each story gets a short summary and a fact-check verdict.</p>
              </div>
            </div>
          </aside>
        </div>
      </section>

      {/* ===== More inputs ===== */}
      <section className={s.section} id="inputs" aria-labelledby="inputs-title">
        <div className="section-head">
          <h2 className="eyebrow" id="inputs-title">More inputs</h2>
        </div>
        <div className="card stack">
          <div className="search-row" role="search">
            <label htmlFor="q">Search stories</label>
            <input id="q" type="search" placeholder="Title, source or topic" />
            <Glyph name="search" size={20} />
          </div>

          <fieldset className="chips">
            <legend className="field-label">Filter by lane</legend>
            {(
              [
                ['ai', 'AI News', 24, true],
                ['ai_dev', 'AI Dev', 18, false],
                ['ai_gamedev', 'AI Gamedev', 9, false],
                ['markets', 'Markets', 31, false],
                ['gamedev', 'Gamedev', 12, false],
                ['games', 'Games', 15, false],
              ] as const
            ).map(([value, label, count, checked]) => (
              <label key={value} className="chip">
                <input type="checkbox" name="lane" value={value} defaultChecked={checked} />
                <span>
                  {label} <span className={`count ${s.chipCount}`}>{count}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="grid-2">
            <div className="field">
              <label className="field-label" htmlFor="keyword">
                Keyword alert{' '}
                <span className="field-required" aria-hidden="true">
                  *
                </span>
              </label>
              <p className="field-help" id="keyword-help">
                Stories matching it jump to the top.
              </p>
              <input className="input" id="keyword" type="text" required aria-describedby="keyword-help" />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="since">
                Stories since
              </label>
              <p className="field-help" id="since-help">
                Leave blank for the last 24 hours.
              </p>
              <input className="input" id="since" type="date" aria-describedby="since-help" />
            </div>
          </div>
        </div>
      </section>

      {/* ===== Validation ===== */}
      <section className={s.section} id="validation" aria-labelledby="validation-title">
        <div className="section-head">
          <h2 className="eyebrow" id="validation-title">Validation</h2>
        </div>
        <div className="card">
          <div className="error-summary" role="alert" tabIndex={-1} aria-labelledby="err-title">
            <h2 className="error-summary-title" id="err-title">
              There is a problem
            </h2>
            <ul className="error-summary-list">
              <li>
                <a href="#email2">Enter an email address in the correct format, like name@example.com</a>
              </li>
              <li>
                <a href="#score2">Choose a minimum score</a>
              </li>
            </ul>
          </div>
          <div className="stack">
            <div className="field field-error">
              <label className="field-label" htmlFor="email2">
                Email digest to
              </label>
              <p className="field-error-message" id="email2-error">
                <span className="visually-hidden">Error: </span>Enter an email address in the correct format, like
                name@example.com
              </p>
              <input
                className="input"
                id="email2"
                type="email"
                defaultValue="gadi@example"
                aria-invalid="true"
                aria-describedby="email2-error"
              />
            </div>
            <div className="field field-error">
              <p className="field-error-message" id="score2-error">
                <span className="visually-hidden">Error: </span>Choose a minimum score
              </p>
              <div className="inline-field">
                <label className="field-label" htmlFor="score2">
                  Minimum score
                </label>
                <select
                  className="select"
                  id="score2"
                  required
                  aria-invalid="true"
                  aria-describedby="score2-error"
                  defaultValue=""
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option>3</option>
                  <option>4</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== Buttons ===== */}
      <section className={s.section} id="buttons" aria-labelledby="buttons-title">
        <div className="section-head">
          <h2 className="eyebrow" id="buttons-title">Buttons</h2>
          <span className="small subtle">One primary per view</span>
        </div>
        <div className="card stack">
          <div className={s.rowGap}>
            <button className="btn btn-primary" type="button">
              Run digest
            </button>
            <button className="btn btn-secondary" type="button">
              <Glyph name="download" size={18} />
              Export JSON
            </button>
            <button className="btn btn-soft" type="button">
              <Glyph name="plus" size={18} />
              Add source
            </button>
            <button className="btn btn-ghost" type="button">
              Cancel
            </button>
            <button className="btn btn-secondary" type="button" disabled>
              Pause lane
            </button>
          </div>
          <div className={s.rowGap}>
            <button className="btn btn-dark btn-sm" type="button">
              <Glyph name="pencil" size={14} />
              Edit
            </button>
            <button className="btn btn-secondary btn-sm" type="button">
              Copy link
            </button>
            <button className="btn btn-ghost btn-sm" type="button">
              Clear filters
            </button>
          </div>
          <div>
            <button className="btn btn-primary btn-xl" type="button">
              Run today&apos;s digest for all 6 lanes
            </button>
          </div>
        </div>
      </section>

      {/* ===== Cards and panels ===== */}
      <section className={s.section} id="surfaces" aria-labelledby="surfaces-title">
        <div className="section-head">
          <h2 className="eyebrow" id="surfaces-title">Cards and panels</h2>
          <span className="count">3</span>
        </div>
        <div className={s.cards}>
          <article className="card is-featured stack" aria-labelledby="story1">
            <div className={s.storyTop}>
              <div className={`stack ${s.tight}`}>
                <p className="eyebrow">Top story · AI Gamedev</p>
                <h3 id="story1" className={s.storyTitle}>
                  Gaussian splats land in Godot 4.6
                </h3>
                <p className="muted">Hugging Face</p>
              </div>
              <VerdictTag verdict="confirmed" />
            </div>
            <div className="row">
              <span className="meta">
                <Glyph name="star" size={14} />
                Score 5 / 5
              </span>
              <span className="meta">
                <Icon name="feed" size={14} />
                Hugging Face, GitHub
              </span>
              <span className="meta">
                <Icon name="clock" size={14} />2 hours ago
              </span>
            </div>
            <div>
              <a className="btn btn-primary" href="#data">
                Read story
                <Glyph name="arrowRight" size={18} />
              </a>
            </div>
          </article>
          <article className="card stack" aria-labelledby="story2">
            <div className={s.storyTop}>
              <div className={`stack ${s.tight}`}>
                <p className="eyebrow">Also today · Markets</p>
                <h3 id="story2" className={s.storyTitle}>
                  Fed hints at a December rate cut
                </h3>
                <p className="muted">Reddit</p>
              </div>
              <VerdictTag verdict="unconfirmed" />
            </div>
            <div className="row">
              <span className="meta">
                <Glyph name="star" size={14} />
                Score 4 / 5
              </span>
              <span className="meta">
                <Icon name="feed" size={14} />
                Reddit
              </span>
            </div>
            <div>
              <a className="btn btn-secondary" href="#data">
                Open source
                <Icon name="external" size={18} />
              </a>
            </div>
          </article>
        </div>
        <section className="panel" aria-labelledby="p-icon-title">
          <div className="panel-head">
            <span className="icon-tile" aria-hidden="true">
              <Icon name="layers" size={16} />
            </span>
            <div className="panel-head-text">
              <h2 id="p-icon-title">How a digest is made</h2>
              <p>A panel with an icon tile instead of a step number.</p>
            </div>
          </div>
          <div className="panel-body grid-2">
            <ol className="steps-list">
              <li>
                <strong>Fetch</strong> <span className="muted">from HN, Reddit, RSS, GitHub, Hugging Face and Steam.</span>
              </li>
              <li>
                <strong>Score</strong> <span className="muted">each story 1 to 5 for its lane.</span>
              </li>
              <li>
                <strong>Summarise</strong> <span className="muted">in two or three sentences with Claude.</span>
              </li>
              <li>
                <strong>Fact-check</strong> <span className="muted">and tag a verdict before it ships.</span>
              </li>
            </ol>
            <div className="stack">
              <dl className="split">
                <div>
                  <dt className="eyebrow">Fetched</dt>
                  <dd className="tnum">412</dd>
                </div>
                <div>
                  <dt className="eyebrow">Made the cut</dt>
                  <dd className="tnum">128</dd>
                </div>
              </dl>
              <details className="disclosure">
                <summary>What does the score mean?</summary>
                <p className={`muted ${s.disclosureBody}`}>
                  5 is a must-read for the lane. Below your minimum, a story stays in the archive.
                </p>
              </details>
              <details className="disclosure">
                <summary>Who checks the facts?</summary>
                <p className={`muted ${s.disclosureBody}`}>
                  Claude, against the source and at least one other outlet.
                </p>
              </details>
            </div>
          </div>
        </section>
      </section>

      {/* ===== Status and data ===== */}
      <section className={s.section} id="data" aria-labelledby="data-title">
        <div className="section-head">
          <h2 className="eyebrow" id="data-title">Status and data</h2>
          <span className="count">4</span>
        </div>
        <div className="card stack">
          <div className={s.rowGap}>
            <span className="tag">
              <Glyph name="file" size={14} />
              Unscored
            </span>
            <span className="tag tag-accent">
              <Glyph name="calendar" size={14} />
              Scheduled
            </span>
            <VerdictTag verdict="confirmed" />
            <VerdictTag verdict="unconfirmed" />
            <VerdictTag verdict="disputed" />
            <VerdictTag verdict="false" />
            <span className="meta">
              <Icon name="feed" size={14} />6 sources
            </span>
            <span className={`row ${s.tight}`}>
              <strong>Saved stories</strong>
              <span className="count">7</span>
            </span>
          </div>
          <div className="grid-2">
            <div className="callout">
              <Glyph name="info" />
              <div>
                <p className="callout-title">Neutral</p>
                <p>The digest saves as it runs.</p>
              </div>
            </div>
            <div className="callout callout-info">
              <Glyph name="info" />
              <div>
                <p className="callout-title">Tip</p>
                <p>Raise the minimum score to shorten a noisy lane.</p>
              </div>
            </div>
            <div className="callout callout-warn">
              <Icon name="alert" size={18} />
              <div>
                <p className="callout-title">Reddit is rate-limited</p>
                <p>Some threads will arrive in the next run.</p>
              </div>
            </div>
            <div className="callout callout-error">
              <Icon name="x" size={18} />
              <div>
                <p className="callout-title">Steam fetch failed</p>
                <p>The Games lane is missing store news today.</p>
              </div>
            </div>
            <div className="callout callout-success">
              <Glyph name="circleCheck" />
              <div>
                <p className="callout-title">Digest sent</p>
                <p>128 stories across 6 lanes.</p>
              </div>
            </div>
          </div>
        </div>

        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Recent stories</caption>
            <thead>
              <tr>
                <th scope="col">Story</th>
                <th scope="col">Lane</th>
                <th scope="col">Verdict</th>
                <th scope="col">Score</th>
              </tr>
            </thead>
            <tbody>
              {RECENT.map((r) => (
                <tr key={r.title}>
                  <td>
                    <strong>{r.title}</strong>
                  </td>
                  <td>{r.lane}</td>
                  <td>
                    <VerdictTag verdict={r.verdict} />
                  </td>
                  <td className="tnum">{r.score} / 5</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ===== Empty and success ===== */}
      <section className={s.section} id="states" aria-labelledby="states-title">
        <div className="section-head">
          <h2 className="eyebrow" id="states-title">Empty and success</h2>
        </div>
        <div className={s.cards}>
          <div className="card empty">
            <span className="empty-icon">
              <Icon name="inbox" size={24} />
            </span>
            <h2>No stories in this lane yet</h2>
            <p className="muted">The next run fetches new ones at 07:00.</p>
            <a className={`btn btn-secondary ${s.emptyAction}`} href="#inputs">
              <Glyph name="search" size={18} />
              Search stories
            </a>
          </div>
          <div className="card empty" role="status">
            <span className={`empty-icon ${s.emptyDone}`}>
              <Icon name="check" size={24} />
            </span>
            <h2>Digest ready</h2>
            <p className="muted">128 stories across 6 lanes, all fact-checked.</p>
            <Link className={`btn btn-secondary ${s.emptyAction}`} href="/">
              See today&apos;s stories
            </Link>
          </div>
        </div>
      </section>

      <footer className={`small subtle ${s.footer}`}>
        Built with <span className="mono">boxy.css</span>. Keep this page in step with the stylesheet.
      </footer>
    </>
  );
}
