// Designs Claude describes by their structure, laid out by the tool that
// reads each source: D2, mermaid or Graphviz for a diagram, a browser for an
// HTML mockup dressed by the wireframe kit below.

export type Drawn =
  | { svg: string }
  | { d2: string }
  | { mermaid: string }
  | { dot: string }
  | { html: string; width: number; height?: number }

// The page each design sits on, in Claude Code's light or dark theme.
export const PAPER = { light: '#f6f5f1', dark: '#1d1e21' }

// The wireframe kit: layout and parts as classes, colors as variables, so a
// mockup says what goes where and the browser places it.
export const KIT = `
:root{--paper:${PAPER.light};--panel:#fff;--ink:#1f2328;--muted:#6e7781;--line:#c4c8cc;--fill:#e9eaec;--accent:#d97757;--accent-ink:#fff;--good:#2e9e5b;--bad:#d1453b;--gap:12px;--radius:8px;color-scheme:light}
:root[data-theme=dark]{--paper:${PAPER.dark};--panel:#26282c;--ink:#e8e8e6;--muted:#9ba1a8;--line:#464a51;--fill:#33363b;--accent:#e08a6a;--accent-ink:#1d1e21;--good:#4cc27a;--bad:#ef6b60;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--paper);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
h1,h2,h3,p{margin:0}h1{font-size:26px}h2{font-size:20px}h3{font-size:16px}
.row,.col{display:flex;gap:var(--gap)}.col{flex-direction:column}
.grid{display:grid;gap:var(--gap);grid-template-columns:repeat(var(--cols,3),minmax(0,1fr))}
.grow{flex:1 1 0;min-width:0;min-height:0}.wrap{flex-wrap:wrap}
.between{justify-content:space-between}.center{justify-content:center;align-items:center}.middle{align-items:center}.end{justify-content:flex-end}
.tight{--gap:6px}.loose{--gap:24px}.pad{padding:14px}
.box{background:var(--panel);border:1.5px solid var(--line);border-radius:var(--radius);padding:14px}
.window{background:var(--panel);border:1.5px solid var(--line);border-radius:10px;overflow:hidden}
.window::before{content:attr(data-title);display:block;padding:7px 12px;background:var(--fill);border-bottom:1.5px solid var(--line);color:var(--muted);font-size:13px;line-height:19px;height:34px;box-sizing:border-box}
:is(.pad,.box).window::before{margin:-14px -14px 14px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 16px;border:1.5px solid var(--line);border-radius:var(--radius);background:var(--panel);font-weight:500;white-space:nowrap}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}.btn.ghost{background:none;border-color:transparent}
.input{display:flex;align-items:center;min-height:36px;padding:7px 12px;border:1.5px solid var(--line);border-radius:var(--radius);background:var(--paper);color:var(--muted)}
.check::before{content:"";display:inline-block;width:15px;height:15px;margin-right:8px;vertical-align:-2px;border:1.5px solid var(--line);border-radius:4px}
.check.on::before{background:var(--accent);border-color:var(--accent)}
.slider,.bar{position:relative;height:8px;border-radius:4px;background:linear-gradient(to right,var(--color,var(--accent)) var(--value,50%),var(--fill) var(--value,50%))}
.bar{height:12px;border-radius:6px}
.slider::after{content:"";position:absolute;top:50%;left:var(--value,50%);width:18px;height:18px;transform:translate(-50%,-50%);border-radius:50%;background:var(--panel);border:2px solid var(--color,var(--accent))}
.tabs{display:flex;gap:4px;border-bottom:1.5px solid var(--line)}.tabs>*{padding:8px 14px;color:var(--muted)}
.tabs>.on{color:var(--ink);border-bottom:2.5px solid var(--accent);margin-bottom:-1.5px}
.list{display:flex;flex-direction:column}.list>*{padding:10px 12px;border-bottom:1px solid var(--line)}.list>:last-child{border-bottom:0}.list>.on{background:var(--fill)}
.img{display:flex;align-items:center;justify-content:center;min-height:80px;color:var(--muted);border:1.5px solid var(--line);border-radius:var(--radius);background:linear-gradient(to top right,transparent calc(50% - 1px),var(--line) 50%,transparent calc(50% + 1px)),linear-gradient(to bottom right,transparent calc(50% - 1px),var(--line) 50%,transparent calc(50% + 1px)),var(--fill)}
.icon{flex:none;width:20px;height:20px;border-radius:5px;background:var(--fill);border:1.5px solid var(--line)}
.avatar{flex:none;width:36px;height:36px;border-radius:50%;background:var(--fill);border:1.5px solid var(--line)}
.lines{height:calc(var(--n,3) * 18px - 8px);background:repeating-linear-gradient(var(--fill) 0 10px,transparent 10px 18px);border-radius:3px}
.tag{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;background:var(--fill);color:var(--muted);font-size:12px}
hr,.hr{align-self:stretch;margin:0;border:0;border-top:1.5px solid var(--line)}
.muted{color:var(--muted)}.small{font-size:13px}.bold{font-weight:600}
.note{padding:6px 10px;border:1.5px dashed var(--accent);border-radius:6px;color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent);font-size:13px}
.mark{display:inline-flex;flex:none;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--accent);color:var(--accent-ink);font-size:12px;font-weight:700}
.stage,.screen{position:relative;overflow:hidden;background:linear-gradient(transparent 49px,color-mix(in srgb,var(--line) 35%,transparent) 50px) 0 0/50px 50px,linear-gradient(90deg,transparent 49px,color-mix(in srgb,var(--line) 35%,transparent) 50px) 0 0/50px 50px,linear-gradient(color-mix(in srgb,var(--accent) 10%,var(--paper)),var(--paper))}
.stage{aspect-ratio:var(--aspect,16/9);border:1.5px solid var(--line);border-radius:var(--radius)}
.screen{position:fixed;inset:0}
:is(.stage,.screen)>:is(.tl,.tc,.tr,.ml,.mc,.mr,.bl,.bc,.br){position:absolute;margin:16px}
:is(.stage,.screen)>:is(.tl,.tc,.tr){top:0}:is(.stage,.screen)>:is(.bl,.bc,.br){bottom:0}
:is(.stage,.screen)>:is(.tl,.ml,.bl){left:0}:is(.stage,.screen)>:is(.tr,.mr,.br){right:0}
:is(.stage,.screen)>:is(.tc,.bc,.mc){left:50%;translate:-50% 0}:is(.stage,.screen)>:is(.ml,.mr,.mc){top:50%;translate:0 -50%}
:is(.stage,.screen)>.mc{translate:-50% -50%}
`

// Set once the page has loaded and its fonts are in: the height its content
// takes, read back from the dumped DOM.
const MEASURE =
  '<script>addEventListener("load",()=>document.fonts.ready.then(()=>{document.documentElement.dataset.height=String(Math.ceil(document.documentElement.scrollHeight))}))</script>'

// The page an HTML mockup is drawn from: the kit, then Claude's markup. A
// whole document works too; the parser folds its html, head and body in.
export function page(html: string, isLight: boolean) {
  const theme = isLight ? 'light' : 'dark'

  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>${KIT}</style></head><body>${html}${MEASURE}</body></html>`
}

// The page that frames an SVG at its own size, for the browser to draw.
export function frame(svg: string) {
  return `<!doctype html><style>html,body{margin:0}img{display:block}</style><img src="${svg}">`
}

// The content height MEASURE left in a dumped DOM, within what a picture
// may take.
export function measured(dom: string) {
  const found = /data-height="(\d+)"/.exec(dom)

  return found === null ? undefined : Math.max(1, Math.min(LONGEST, Number(found[1])))
}

// The size an SVG declares on its root element, as d2 writes it.
export function svgSize(svg: string) {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? ''
  const width = Number(/\swidth="([\d.]+)"/.exec(root)?.[1] ?? 0)
  const height = Number(/\sheight="([\d.]+)"/.exec(root)?.[1] ?? 0)

  return width > 0 && height > 0 ? { width: Math.ceil(width), height: Math.ceil(height) } : undefined
}

// The longest side a picture is drawn at; the API takes up to 8000.
export const LONGEST = 6000

// Where a browser that draws headless may be: on PATH, in macOS's
// Applications, or the one puppeteer fetched for mermaid-cli.
export const FIND_BROWSER = [
  'for b in chromium chromium-browser google-chrome-stable google-chrome chrome microsoft-edge brave-browser; do command -v "$b" && exit 0; done',
  'for b in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" "$HOME"/.cache/puppeteer/chrome-headless-shell/*/*/chrome-headless-shell; do [ -x "$b" ] && echo "$b" && exit 0; done',
  'exit 1',
].join('; ')

// A headless browser on its own throwaway profile, so it never joins a
// browser the person has open.
export function browserArgs(browser: string, profile: string) {
  return [
    browser,
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    '--virtual-time-budget=2000',
    `--user-data-dir=${profile}`,
  ]
}

// D2's own themes: Neutral default, and Dark Mauve.
export function d2Args(isLight: boolean, from: string, to: string) {
  return ['d2', `--theme=${isLight ? 0 : 200}`, '--pad=40', '--scale=1', from, to]
}

// Graphviz in the theme's colors, nodes as rounded boxes; what the source
// sets wins over these defaults.
export function dotArgs(isLight: boolean, from: string, to: string) {
  const ink = isLight ? '#1f2328' : '#e8e8e6'
  const line = isLight ? '#57606a' : '#9ba1a8'
  const paper = isLight ? PAPER.light : PAPER.dark
  const font = 'sans-serif'

  return [
    'dot',
    '-Tpng',
    '-Gdpi=144',
    `-Gbgcolor=${paper}`,
    `-Gcolor=${line}`,
    `-Gfontcolor=${ink}`,
    `-Gfontname=${font}`,
    '-Gpad=0.3',
    '-Nshape=box',
    '-Nstyle=rounded',
    `-Ncolor=${line}`,
    `-Nfontcolor=${ink}`,
    `-Nfontname=${font}`,
    `-Ecolor=${line}`,
    `-Efontcolor=${ink}`,
    `-Efontname=${font}`,
    '-Efontsize=11',
    '-o',
    to,
    from,
  ]
}

// mermaid-cli on the theme's paper, drawn at `scale` so it stays sharp.
export function mermaidArgs(isLight: boolean, from: string, to: string, scale: number) {
  const paper = isLight ? '#ffffff' : PAPER.dark

  return ['mmdc', '-q', '-i', from, '-o', to, '-t', isLight ? 'default' : 'dark', '-b', paper, '-s', String(scale)]
}

// What a renderer said went wrong, short enough to read: its first lines,
// past the noise of stack frames and browser warnings.
export function errorLines(stderr: string) {
  return stderr
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '' && !/^\s+at\s|^\[\d+\/\d+\.\d+:|^\s*\^?\s*$/.test(line))
    .slice(0, 6)
    .map(line => (line.length > 200 ? `${line.slice(0, 199)}…` : line))
    .join('\n')
}

// A picture fetched from the web: http or https only, redirects followed,
// at most 20 MB in 30 seconds, under a name that says who asks.
export function curlArgs(url: string, to: string) {
  return [
    'curl',
    '-fsSL',
    '--proto',
    '=http,https',
    '--max-filesize',
    String(20 * 1024 * 1024),
    '--max-time',
    '30',
    '-A',
    'show-work (Claude Code plugin)',
    '-o',
    to,
    url,
  ]
}

export type Format = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'svg'

// The format a file's first bytes say it is, so ImageMagick reads a fetched
// file with that one coder and no other; undefined for anything else.
export function sniff(head: string): Format | undefined {
  if (head.startsWith('\x89PNG')) {
    return 'png'
  }
  if (head.startsWith('\xff\xd8\xff')) {
    return 'jpeg'
  }
  if (head.startsWith('GIF8')) {
    return 'gif'
  }
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') {
    return 'webp'
  }
  if (head.startsWith('BM')) {
    return 'bmp'
  }
  const text = head.replace(/^\xef\xbb\xbf/, '').trimStart()

  return text.startsWith('<') && /<svg\b/i.test(text) ? 'svg' : undefined
}

// `od -An -tx1` output back to the bytes it shows, one char per byte.
export function fromHex(dump: string) {
  return (dump.match(/[0-9a-f]{2}/gi) ?? []).map(pair => String.fromCharCode(parseInt(pair, 16))).join('')
}

// The name a picture goes by: its file's name, or a URL's last part.
export function nameOf(src: string) {
  if (/^https?:\/\//i.test(src)) {
    try {
      const url = new URL(src)
      const last = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)

      return decodeURIComponent(last) || url.host
    } catch {
      return src
    }
  }

  return src.slice(src.lastIndexOf('/') + 1)
}

// The most pictures a sheet holds, and the longest side of each on it.
export const SHEET_MOST = 9
export const TILE = 480

// How many pictures a sheet sets across: one row up to four, so a sheet is
// wide and fills the chat's width; then rows of three or four.
export function across(count: number) {
  return count <= 4 ? count : count <= 6 || count === 9 ? 3 : 4
}

// The factor that brings a small picture, such as a sprite, up to half a
// tile with whole pixels; 1 for a picture already that big.
export function blowUp(width: number, height: number) {
  const longest = Math.max(width, height)

  return longest > 0 && longest < TILE / 2 ? Math.floor(TILE / 2 / longest) : 1
}

// A label as ImageMagick takes it literally: % starts an escape, and a
// leading @ names a file to read.
export function literal(label: string) {
  return label.replaceAll('%', '%%').replace(/^@/, '\\@')
}

// Pictures side by side on the theme's paper, each over its label.
export function sheetArgs(isLight: boolean, tiles: { file: string; label: string }[], to: string, font?: string) {
  return [
    'magick',
    'montage',
    ...tiles.flatMap(tile => ['-label', literal(tile.label), tile.file]),
    '-tile',
    `${across(tiles.length)}x`,
    // Each picture already fits a tile; a cell takes the biggest's size.
    '-geometry',
    '+16+16',
    '-background',
    isLight ? PAPER.light : PAPER.dark,
    '-fill',
    isLight ? '#1f2328' : '#e8e8e6',
    ...(font === undefined ? [] : ['-font', font]),
    '-pointsize',
    '20',
    '-depth',
    '8',
    to,
  ]
}

// A mark on a picture, in its own pixels: a box when it has a width and
// height, a ring round a spot when it has neither. Its note names it in the
// card under the picture; its detail shows there while it is hovered.
export type Mark = { x: number; y: number; w?: number; h?: number; note: string; detail?: string }

// The accent marks are drawn in, as the wireframe kit's.
const ACCENT = { light: '#d97757', dark: '#e08a6a' }

// An offset from the picture's center, as -annotate takes it under
// -gravity Center.
const offset = (dx: number, dy: number) =>
  `${dx < 0 ? '-' : '+'}${Math.abs(Math.round(dx))}${dy < 0 ? '-' : '+'}${Math.abs(Math.round(dy))}`

// The sizes marks are drawn at on a picture: the line, the badge's radius,
// and a ring's.
function markSizes(size: { width: number; height: number }) {
  const longest = Math.max(size.width, size.height)
  const r = Math.max(12, Math.round(longest / 60))

  return { stroke: Math.max(3, Math.round(longest / 300)), r, ring: Math.round(r * 1.3) }
}

// Marks drawn on a picture, each numbered on a badge kept inside the
// edges. Their notes go in the card under it, not on the picture.
export function markArgs(
  from: string,
  to: string,
  marks: Mark[],
  size: { width: number; height: number },
  isLight: boolean,
  font?: string,
) {
  const { width, height } = size
  const accent = isLight ? ACCENT.light : ACCENT.dark
  const paper = isLight ? PAPER.light : PAPER.dark
  const { stroke, r, ring } = markSizes(size)
  const inside = (value: number, most: number) => Math.round(Math.min(Math.max(value, r), most - r))
  const typeface = font === undefined ? [] : ['-font', font]
  const drawn = marks.flatMap((mark, n) => {
    const isBox = (mark.w ?? 0) > 0 && (mark.h ?? 0) > 0
    const shape = isBox
      ? `roundrectangle ${Math.round(mark.x)},${Math.round(mark.y)} ${Math.round(mark.x + (mark.w ?? 0))},${Math.round(mark.y + (mark.h ?? 0))} 8,8`
      : `circle ${Math.round(mark.x)},${Math.round(mark.y)} ${Math.round(mark.x + ring)},${Math.round(mark.y)}`
    const cx = inside(isBox ? mark.x : mark.x + ring * 0.7, width)
    const cy = inside(isBox ? mark.y : mark.y - ring * 0.7, height)

    return [
      '-fill', 'none', '-stroke', accent, '-strokewidth', String(stroke), '-draw', shape,
      '-fill', accent, '-stroke', paper, '-strokewidth', '2', '-draw', `circle ${cx},${cy} ${cx + r},${cy}`,
      '-fill', 'white', '-stroke', 'none', ...typeface, '-pointsize', String(Math.round(r * 1.2)),
      '-gravity', 'Center', '-annotate', offset(cx - width / 2, cy - height / 2), String(n + 1),
    ]
  })

  return ['magick', from, ...drawn, to]
}

// The pixels a mark's shape takes: its box, or its ring's square.
export function shapeBounds(mark: Mark, size: { width: number; height: number }) {
  const { ring } = markSizes(size)
  const isBox = (mark.w ?? 0) > 0 && (mark.h ?? 0) > 0

  return isBox
    ? { x0: mark.x, y0: mark.y, x1: mark.x + (mark.w ?? 0), y1: mark.y + (mark.h ?? 0) }
    : { x0: mark.x - ring, y0: mark.y - ring, x1: mark.x + ring, y1: mark.y + ring }
}

// The pairs of marks whose shapes overlap, numbered from 1.
export function overlaps(marks: Mark[], size: { width: number; height: number }) {
  const bounds = marks.map(mark => shapeBounds(mark, size))

  return bounds.flatMap((a, i) =>
    bounds
      .slice(i + 1)
      .flatMap((b, k) => (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1 ? [[i + 1, i + k + 2] as const] : [])),
  )
}

// The terminal cells a mark covers when its picture is drawn `columns` by
// `rows`: its shape with its badge; at least one cell.
export function markCells(
  mark: Mark,
  size: { width: number; height: number },
  box: { columns: number; rows: number },
) {
  const { r } = markSizes(size)
  const isBox = (mark.w ?? 0) > 0 && (mark.h ?? 0) > 0
  const shape = shapeBounds(mark, size)
  // A box's badge sits on its corner; a ring's up and to the right.
  const [x0, y0, x1, y1] = isBox
    ? [shape.x0 - r, shape.y0 - r, shape.x1, shape.y1]
    : [shape.x0, shape.y0 - r, shape.x1 + r, shape.y1]
  const across = (x: number) => Math.min(box.columns, Math.max(0, (x / size.width) * box.columns))
  const down = (y: number) => Math.min(box.rows, Math.max(0, (y / size.height) * box.rows))
  const left = Math.min(box.columns - 1, Math.floor(across(x0)))
  const top = Math.min(box.rows - 1, Math.floor(down(y0)))

  return {
    left,
    top,
    width: Math.max(1, Math.ceil(across(x1)) - left),
    height: Math.max(1, Math.ceil(down(y1)) - top),
  }
}

// Each mark lit on a whole copy of the picture, written to `outs` in order:
// its shape washed with the accent and outlined white, its badge turned
// white. A whole copy is fitted to its cells as the picture is, so laid over
// it, it lines up whatever shape the terminal's cells are.
export function litArgs(
  from: string,
  marks: Mark[],
  size: { width: number; height: number },
  outs: string[],
  isLight: boolean,
  font?: string,
) {
  const { width, height } = size
  const accent = isLight ? ACCENT.light : ACCENT.dark
  const { stroke, r, ring } = markSizes(size)
  const inside = (value: number, most: number) => Math.round(Math.min(Math.max(value, r), most - r))
  const typeface = font === undefined ? [] : ['-font', font]
  const lit = marks.flatMap((mark, n) => {
    const isBox = (mark.w ?? 0) > 0 && (mark.h ?? 0) > 0
    const shape = isBox
      ? `roundrectangle ${Math.round(mark.x)},${Math.round(mark.y)} ${Math.round(mark.x + (mark.w ?? 0))},${Math.round(mark.y + (mark.h ?? 0))} 8,8`
      : `circle ${Math.round(mark.x)},${Math.round(mark.y)} ${Math.round(mark.x + ring)},${Math.round(mark.y)}`
    const cx = inside(isBox ? mark.x : mark.x + ring * 0.7, width)
    const cy = inside(isBox ? mark.y : mark.y - ring * 0.7, height)

    return [
      '(', '+clone',
      '-fill', `${accent}38`, '-stroke', 'white', '-strokewidth', String(Math.round(stroke * 1.5)), '-draw', shape,
      '-fill', 'white', '-stroke', accent, '-strokewidth', '2', '-draw', `circle ${cx},${cy} ${cx + r},${cy}`,
      '-fill', accent, '-stroke', 'none', ...typeface, '-pointsize', String(Math.round(r * 1.2)),
      '-gravity', 'Center', '-annotate', offset(cx - width / 2, cy - height / 2), String(n + 1),
      '-write', outs[n] ?? 'null:', '+delete', ')',
    ]
  })

  return ['magick', from, ...lit, 'null:']
}

// Text broken into lines of at most `width` cells, at spaces where it can.
export function wrap(text: string, width: number) {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let rest = word; rest !== ''; ) {
      const room = width - (line === '' ? 0 : line.length + 1)
      if (rest.length <= room) {
        line = line === '' ? rest : `${line} ${rest}`
        rest = ''
      } else if (line !== '') {
        lines.push(line)
        line = ''
      } else {
        lines.push(rest.slice(0, width))
        rest = rest.slice(width)
      }
    }
  }

  return line === '' ? lines : [...lines, line]
}
