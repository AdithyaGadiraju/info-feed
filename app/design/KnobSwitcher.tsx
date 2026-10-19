'use client';

import { useEffect, useState } from 'react';
import Glyph from './glyphs';
import s from './design.module.css';

/** Knobs live as data-* attributes on <html>; "" means the attribute is absent (the boxy.css default). */
const KNOBS = [
  { key: 'shape', label: 'Shape', options: [['', 'Boxy'], ['soft', 'Soft'], ['rounded', 'Rounded']] },
  { key: 'density', label: 'Density', options: [['', 'Roomy'], ['compact', 'Compact']] },
  { key: 'tone', label: 'Tone', options: [['', 'Precise'], ['friendly', 'Friendly'], ['bold', 'Bold']] },
  { key: 'theme', label: 'Theme', options: [['', 'Light'], ['dark', 'Dark']] },
  { key: 'neutral', label: 'Neutral', options: [['', 'Warm'], ['cool', 'Cool']] },
] as const;

type Values = Record<string, string>;

function readValues(): Values {
  const root = document.documentElement;
  // The layout sets data-theme="light" explicitly; that is the same as the default.
  return Object.fromEntries(
    KNOBS.map((k) => {
      const v = root.getAttribute(`data-${k.key}`) ?? '';
      return [k.key, k.key === 'theme' && v === 'light' ? '' : v];
    }),
  );
}

/** Previews knobs on this page only; changes are not saved and reset on reload. */
export default function KnobSwitcher() {
  // Seeded with the knobs app/layout.tsx sets, so the first paint is already right;
  // the effect then picks up a saved dark theme or any other live value.
  const [values, setValues] = useState<Values | null>({ shape: '', density: '', tone: 'bold', theme: '', neutral: '' });

  useEffect(() => {
    setValues(readValues());
  }, []);

  function set(key: string, value: string) {
    const root = document.documentElement;
    if (value) root.setAttribute(`data-${key}`, value);
    else root.removeAttribute(`data-${key}`);
    setValues(readValues());
  }

  return (
    <section className="panel" aria-labelledby="knobs-title">
      <div className="panel-bar">
        <span id="knobs-title" className="row">
          <Glyph name="sliders" />
          Knobs
        </span>
        <span className="subtle small">Attributes on &lt;html&gt;, preview only</span>
      </div>
      <div className={s.controls}>
        {KNOBS.map((knob) => (
          <fieldset key={knob.key} className={s.knob}>
            <legend className="eyebrow">{knob.label}</legend>
            <div className={s.seg}>
              {knob.options.map(([value, text]) => (
                <button
                  key={value || 'default'}
                  type="button"
                  aria-pressed={values ? values[knob.key] === value : undefined}
                  onClick={() => set(knob.key, value)}
                >
                  {text}
                </button>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </section>
  );
}
