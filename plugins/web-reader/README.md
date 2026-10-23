# web-reader

Lets Claude read a web page, or every page of a site, as the page's own complete text.

Claude Code's WebFetch tool passes a page to a small model and returns that model's answer, so a long article comes
back summarized and paraphrased, and quotes can't be checked against it. web-reader downloads the page instead,
converts its HTML to Markdown on your machine, and saves it to a file that Claude reads in full.

## Install

```
/plugin marketplace add astrosteveo/astro-plugins
/plugin install web-reader --marketplace astrosteveo/astro-plugins
```

Requires `python3` (3.10 or later). No other dependencies. `--render` and `--figures` also need Chromium or Chrome on
`PATH`, on Linux or macOS. `claude plugin update web-reader@astro-plugins` gets a new release; each one raises the
version in `plugin.json`.

## Use

Ask Claude to read a page or a site, or run the skill yourself:

```
/web-reader:read https://example.com/article
/web-reader:read https://example.com/docs/ --site --max 100
```

Claude runs `scripts/webread.py`, then reads the saved files. For one page the skill adds `--figures`, so Claude can
also look at the page's charts, diagrams and images.

| Command | What it does |
|---|---|
| `webread.py page <url>` | Saves one page as `<out>/<host>/<name>.md` and prints its path, title, final URL and word count (and with `--figures`, how many figures it saved) |
| `webread.py site <url>` | Saves every page on the URL's host under the URL's path, plus `index.md` listing them |

| Flag | Meaning |
|---|---|
| `--out DIR` | Base directory for the files (default: `web-reader/` in the system temp directory) |
| `--render` | Load each page in headless Chromium first, for pages that build their content with JavaScript |
| `--figures` | Load each page in headless Chromium, and save a picture of each figure in its text (see below) |
| `--allow-local` | Allow hosts that resolve to private, loopback or link-local addresses |
| `--max N` | `site` only: most pages to save (default 50, at most 500) |
| `--delay S` | `site` only: seconds between requests (default 1) |

A URL without a scheme gets `https://`.

## How a crawl works

- The first page fixes the host, so a redirect from `http` to `https`, or to `www.`, moves the crawl with it.
- The section is the URL's path. A redirect can't widen it: `/blog/` redirecting to `/` still crawls `/blog/`. A
  section that moved (`/old-docs/` to `/docs/`) follows the move. The summary prints the scope it used.
- Pages come from the site's sitemaps (robots.txt's `Sitemap:` lines, then `/sitemap.xml`, following sitemap indexes)
  and from links on the pages it saves.
- robots.txt is followed for every page after the start URL. A longer `Crawl-delay` than `--delay` wins.
- Links to files (images, PDFs, archives, scripts, feeds) are skipped without fetching, and so are responses that
  aren't HTML or text.

## What the conversion keeps

Headings, paragraphs, lists, links (made absolute), quotes, bold and italics, and:

- **Code**: inline code, and code blocks with their indentation and, when the page names it, their language
  (```` ```python ````). Mermaid sources stay as ```` ```mermaid ```` blocks.
- **Tables**: Markdown tables, the first row as the header. A cell that spans rows or columns is repeated in each
  row and column it covers, so the columns line up. One-column and layout tables are kept as plain text.
- **Math**: MathML (Wikipedia, KaTeX) as its TeX source, `$...$` inline and `$$...$$` for display formulas.
- **Diagrams and charts drawn in SVG**: the text the graphic contains (labels, values, legends), one line per text
  element, under `Text in the graphic:`. A second copy of the same graphic (a site's mobile layout) is left out.
- **Images**: alt text and `aria-label` descriptions, as `[image: ...]`.
- **Embeds**: iframes, video and audio become a marker with their title and address, e.g.
  `[embedded page: Area chart](https://...)`. A canvas is drawn by script, so it has no text; only its label is kept.
- **Tabs**: each tab's label, and the label above its panel, e.g. `[tab: Python]`.
- With `--render` or `--figures`: **web components** (their open shadow roots are read too), and **code editors**
  (an element with `role="textbox"` and `aria-multiline="true"`, such as CodeMirror) as code blocks.

When a page has one `<article>` (or else one `<main>`), only that is kept; otherwise the page's header, footer and
asides are dropped too. Scripts, styles, navigation, buttons, select menus, text areas, dialogs, language-switcher
links, heading permalinks, ad slots (an element whose tag, class or id has the word `ad`, `ads`, `advert...`,
`sponsor...` or `placement`) and elements marked `aria-hidden` are always dropped. Each file starts with the source
URL, the page title and when it was fetched.

## Figures

Text can't show a chart's shape or a diagram's layout, and a canvas has no text at all. With `--figures`, the page is
loaded in headless Chromium, and each figure in the text it keeps is saved as a PNG in `<name>-figures/` beside the
page's file. The text gets a marker where the figure was, with the picture's path relative to the page's file:

```
[figure 1: blog-post-figures/figure-1.png]
```

followed by whatever text the figure has (caption, alt text, `Text in the graphic:`). Claude reads the PNG with Read,
which shows it the picture.

- A figure is an outermost `<figure>` that holds a picture, or an image, picture, SVG graphic, canvas, iframe, video
  or `role="img"` element outside one, at least 120x80 pixels and shown on the page.
- Left out: icons, formulas (already in the text as TeX), avatars and logos (by their class or id), a picture or
  figure inside a link to another page (a card's thumbnail or a banner), and a second element showing the same
  image. A picture identical to an earlier one becomes `[figure n: the same picture as figure k]`.
- The page is read in a 1280x900 window that asks for reduced motion. It's scrolled through first so lazy images load,
  and things that float over it (cookie banners, sign-up modals, sticky headers) are hidden before the pictures are
  taken. A canvas or embedded page gets 1.5 seconds to finish drawing or loading. A figure taller than the window
  gets a window tall enough for it before its picture is taken.
- Each picture is at most 1600x3000 CSS pixels; a taller figure keeps its top part, and its marker says so. Small
  figures are saved at up to twice the scale, so their text is legible. At most 60 per page.
- A picture that couldn't be taken is marked `[figure n: not photographed]`.

`site` takes `--figures` too, and `index.md` then lists each page's figure count. It runs a browser for every page,
so it is much slower.

## Safety

- Only `http` and `https` URLs are fetched, and every redirect hop is checked the same way.
- Hosts that resolve to any non-public address (private, loopback, link-local, reserved) are refused unless
  `--allow-local`. For the script's own fetches, the address is checked when the URL is checked, not again when the
  connection opens, so a host whose DNS changes in between can still reach a local address.
- With `--render` or `--figures`, the URL is first fetched the normal way so every HTTP redirect hop is checked, and
  Chromium loads only the final URL. After that, every request Chromium makes (the page's frames, images, scripts,
  fetches and websockets, and navigation by script or meta refresh) goes through a proxy inside the script, which
  applies the same check to each one and then connects to the address it checked, so a changed DNS answer can't get
  past it. Loopback goes through the proxy too, and Chromium's UDP (QUIC, WebRTC) is turned off. A refused request
  gets an HTTP 403, so a frame or image from a private address shows up empty or as an error, never as its
  content. Without this, a public page could frame a router's admin page or the cloud metadata address, and
  `--figures` would photograph it.
- Chromium runs with a new, empty profile each time and is controlled through `--remote-debugging-pipe`, so it opens
  no debugging port. The proxy listens on a random port on 127.0.0.1 while the script runs.
- File names are made from `[A-Za-z0-9._-]` only, so no URL can write outside the output directory.
- Each page is read up to 10 MB; a larger page is cut there and marked `truncated` in the index.
- The skill tells Claude to treat page text as data, never as instructions.

The skill's `allowed-tools` pre-approves `webread.py`, so while the skill is active Claude can fetch a URL without
asking you. The skill tells it to fetch only URLs you gave or asked about.

## Limits

- No logins, cookies or forms: it sees what a logged-out visitor sees.
- PDFs and other non-HTML files aren't converted.
- Without `--render` or `--figures`, content that JavaScript builds after the page loads is missing.
- With them, a code editor that draws only the lines in view (CodeMirror 6) gives only those lines; the script prints
  a note when it sees one. The page's own HTML, read without them, often has the whole code.
- A figure inside a cross-origin iframe is photographed with the iframe's own controls (zoom buttons and the like).
