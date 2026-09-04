# Giant Money — Scroll-Story Scene Template (LOCKED)

One continuous film, not a slideshow. Per scene, ONLY the `[SUBJECT]` paragraph
changes. Everything below it is copied verbatim. The animation spec NEVER
changes — it is the motion design system (like CSS variables).

---

## 1 · Subject slot (the ONLY thing that changes per scene)

> `[SUBJECT]` — one paragraph. Small subject, large empty frame, seen from a
> slight distance. Figures are small silhouettes only, no detailed faces.
>
> - Scene 1 (1815 · sea): "A single wooden merchant sailboat floating on calm,
>   glass-like water."
> - Scene 2 (1815 · land): "A lone horse rider carrying a sealed letter across
>   misty countryside."
> - Scene N: …same sentence shape: one subject, one verb, one landscape.

## 2 · Style block (verbatim — never edit)

Color palette strictly limited to 3 tones: deep charcoal-navy background
(#0A0E14 range), muted gold accent used sparingly (one edge, one glint, one
reflection line), soft desaturated silver-grey for mist and highlights. No
other colors. Dark mode aesthetic, premium fintech feel.

Lighting: low-key, single soft light source from the horizon, long subtle
reflection/glint on the ground plane. Atmospheric haze separating subject from
background. No harsh shadows, no bright sky.

Texture: smooth matte gradients, faint film grain, zero clutter, zero text.
Mood: quiet, patient, wealth-being-built-silently. Old-world trade meets
modern restraint — NOT vintage, NOT sepia, NOT painterly.

Composition: horizon line in lower third, subject off-center on the right
third (rule of thirds), massive breathing room at top for overlay text.
16:9 (1920×1080), shallow tonal depth, editorial minimalism.

### Exact tokens
| token | value |
|---|---|
| bg top / mid / low | #070A11 → #0A0E14 → #0D1119 |
| ground | #0C1018 → #090D14 → #070A10 |
| subject silhouette | #05070C (true black-navy) |
| silver-grey | #C7CEDC / #AEB6C6 / #9AA3B5 (opacities ≤ .5) |
| muted gold | #C9A75A · line gradient #B8934A→#D4AC5E |
| grain | feTurbulence 0.82, alpha .055, static |

## 3 · Animation spec (verbatim — the motion design system)

Motion is ambient, not performative. Nothing "happens" — the scene breathes.
Exactly 3 moving layers + one camera move. All `ease-in-out`,
`infinite alternate` (mathematically seamless loop). ≤5% light shift.
`prefers-reduced-motion` ⇒ everything freezes.

| token | target | keyframes | duration |
|---|---|---|---|
| `camBreathe` | whole scene | scale 1 → 1.02, origin on subject | 26s |
| `rock` | subject group | rotate −0.35° → +0.35°, y 0 → −2.2px | 7.5s |
| `shimmer` | gold glint group | opacity .78 → 1, x +1.6px | 8s |
| `hairBreathe` | ground hairlines | opacity .72 → 1 | 11s (2s delay) |
| `driftA` | far mist | x −12px → +12px | 30s |
| `driftB` | near mist | x +10px → −14px | 21s |
| `lightBreathe` | horizon glow | opacity .955 → 1 | 13s |

Web-specific (the whole point): loop-seamless for background use, and motion
quiet enough to never compete with overlaid scroll text.

## 4 · Files
- Scene 1 · 1815 sea: `public/assets/edge-hero.svg` (sailboat)
- Scene 2 · 1815 land: `public/assets/edge-scene2-rider.svg` (courier rider)
- Scene 3 · 1867: `public/assets/edge-scene3-ticker.svg` (ticker machine, empty exchange hall)
- Scene 4 · 1981: `public/assets/edge-scene4-terminal.svg` (one glowing terminal, dark trading floor)
- Preview all: `public/assets/preview.html`
- In production: film-strip section on the landing (`public/edge.html`, served at `/`)

Per-scene note: the `rock` token always targets the scene's one "alive" layer —
boat hull · rider+horse · spilling tape · screen glow. Values never change.
