// Renders the publication list from publications.bib into #publication-list.
// Every entry gets a [bib] link that downloads it as its own .bib file, and a
// [copy] button that puts its BibTeX on the clipboard.
(function () {
  'use strict';

  const BIB_FILE = 'publications.bib';
  // Fields used only to render the page; they are left out of downloads.
  const SITE_ONLY_FIELDS = ['shortvenue', 'category'];
  // Shown in bold in author lists.
  const HIGHLIGHT_NAME = 'Luca Pasetto';

  const container = document.getElementById('publication-list');
  // Announces copy results to screen readers.
  const copyStatus = el('span', { class: 'visually-hidden', 'aria-live': 'polite' });

  fetch(BIB_FILE, { cache: 'no-cache' })
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })
    .then(source => render(parseBibTeX(source)))
    .catch(error => {
      console.error(`Could not load ${BIB_FILE}:`, error);
      container.replaceChildren(el('p', {},
        'The publication list could not be loaded. It is available as ',
        el('a', { href: BIB_FILE }, 'BibTeX'), '.'));
    });

  // ---------------------------------------------------------------- Rendering

  function render(entries) {
    const byYear = new Map();
    for (const entry of entries) {
      const year = entry.fields.year || 'Other';
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(entry);
    }
    const years = [...byYear.keys()].sort((a, b) => (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0));

    const list = el('ul');
    for (const year of years) {
      list.append(el('li', {}, el('strong', {}, year), el('ul', { class: 'pub-list' }, ...byYear.get(year).map(renderEntry))));
    }
    container.replaceChildren(
      el('p', { class: 'small' }, el('a', { href: bibHref(entries), download: 'publications.bib' }, 'Download all as BibTeX')),
      list,
      copyStatus);
    // Zotero's browser connector scans the page when it loads; this asks it to look
    // again now that the citation data of the entries is on the page.
    document.dispatchEvent(new Event('ZoteroItemUpdated', { bubbles: true, cancelable: true }));
  }

  function renderEntry(entry) {
    const f = entry.fields;
    const label = category(entry);
    const body = el('span', { class: 'pub-body' });
    formatNames(f.author || f.editor || '').forEach((name, i) => {
      body.append(i ? ', ' : '', name === HIGHLIGHT_NAME ? el('strong', {}, name) : name);
    });
    body.append(':');

    const parts = [el('em', {}, withPeriod(latexToText(f.title || '')))];
    const venue = formatVenue(f);
    if (venue) parts.push(withPeriod(venue));
    for (const [label, href] of entryLinks(f)) {
      parts.push(el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, `[${label}]`));
    }
    parts.push(el('a', {
      href: bibHref([entry]),
      download: entry.key.replace(/[^\w.-]+/g, '_') + '.bib',
      title: 'Download BibTeX',
    }, '[bib]'));
    parts.push(copyButton(entry));
    for (const part of parts) body.append(' ', part);
    body.append(coins(entry));

    const badgeClass = 'pub-badge pub-badge-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return el('li', {}, el('span', { class: badgeClass }, label), body);
  }

  function copyButton(entry) {
    const button = el('button', { type: 'button', class: 'pub-copy', title: 'Copy BibTeX' }, '[copy]');
    button.addEventListener('click', () => {
      copyText(toBibTeX(entry)).then(
        () => showCopyResult(button, '[copied]', 'BibTeX copied to the clipboard'),
        () => showCopyResult(button, '[copy failed]', 'Copying failed; use the bib link to download it instead'));
    });
    return button;
  }

  // Uses the Clipboard API, or the older copy command where the API is missing or refused.
  function copyText(text) {
    const viaApi = navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject();
    return viaApi.catch(() => {
      const area = el('textarea', { readonly: '', style: 'position: fixed; opacity: 0;' }, text);
      document.body.append(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      if (!copied) throw new Error('copy command failed');
    });
  }

  function showCopyResult(button, label, announcement) {
    button.textContent = label;
    copyStatus.textContent = announcement;
    clearTimeout(button.resetTimer);
    button.resetTimer = setTimeout(() => { button.textContent = '[copy]'; }, 2000);
  }

  // Invisible citation data in the COinS format (OpenURL 1.0), which reference
  // managers such as Zotero and Mendeley detect on the page.
  function coins(entry) {
    const f = entry.fields;
    const text = name => latexToText(f[name] || '');
    const genre = { Journal: 'article', Preprint: 'preprint', Chapter: 'bookitem', Book: 'book',
      Conference: 'proceeding', Workshop: 'proceeding' }[category(entry)] || 'document';
    const inJournal = genre === 'article' || genre === 'preprint';
    const data = [
      ['ctx_ver', 'Z39.88-2004'],
      ['rft_val_fmt', `info:ofi/fmt:kev:mtx:${inJournal ? 'journal' : 'book'}`],
      ['rft.genre', genre],
    ];
    if (genre === 'book') {
      data.push(['rft.btitle', text('title')]);
    } else if (inJournal) {
      data.push(['rft.atitle', text('title')], ['rft.jtitle', isArxiv(f) ? 'arXiv' : text('journal')],
        ['rft.volume', text('volume')], ['rft.issue', text('number')]);
    } else {
      data.push(['rft.atitle', text('title')],
        ['rft.btitle', text('booktitle') || text('journal') || text('howpublished') || text('shortvenue')],
        ['rft.volume', text('volume')], ['rft.series', text('series')]);
    }
    for (const name of splitTopLevel(f.author || '', /\s+and\s+/iy)) {
      if (name === 'others') continue;
      const parts = splitTopLevel(name, /,/y); // keep "Last, First" so multi-word surnames survive
      data.push(['rft.au', parts.length > 1 ? `${latexToText(parts[0])}, ${latexToText(parts[parts.length - 1])}` : latexToText(name)]);
    }
    data.push(['rft.date', text('year')], ['rft.pages', text('pages').replace(/–/g, '-')], ['rft.pub', text('publisher')]);
    for (const [, href] of entryLinks(f)) {
      const doi = /^https:\/\/doi\.org\/(.+)$/.exec(href);
      data.push(['rft_id', doi ? 'info:doi/' + doi[1] : href]);
    }
    const kev = data.filter(([, value]) => value).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    return el('span', { class: 'Z3988', title: kev });
  }

  // The `category` field if given, otherwise a guess from the entry type and venue.
  function category(entry) {
    const f = entry.fields;
    if (f.category) return latexToText(f.category);
    if (isArxiv(f)) return 'Preprint';
    if (/workshop/i.test([f.shortvenue, f.booktitle, f.howpublished].join(' '))) return 'Workshop';
    switch (entry.type.toLowerCase()) {
      case 'article': return 'Journal';
      case 'inproceedings':
      case 'conference': return 'Conference';
      case 'incollection':
      case 'inbook': return 'Chapter';
      case 'book': return 'Book';
      case 'phdthesis':
      case 'mastersthesis': return 'Thesis';
      default: return 'Other';
    }
  }

  // Returns the display names, e.g. ["Luca Pasetto", "Christoph Benzmüller"].
  function formatNames(field) {
    return splitTopLevel(field, /\s+and\s+/iy)
      .map(name => {
        if (name === 'others') return 'et al.';
        // "Last, First" and "Last, Jr, First" become "First Last" and "First Last, Jr".
        const parts = splitTopLevel(name, /,/y);
        const ordered = parts.length === 3 ? `${parts[2]} ${parts[0]}, ${parts[1]}`
          : parts.length === 2 ? `${parts[1]} ${parts[0]}`
          : name;
        return latexToText(ordered.replace(/\s+\d{4}$/, '')); // dblp homonym numbers, e.g. "Wei Wang 0001"
      });
  }

  // Short venue (or journal/booktitle), then volume(number) for journals, then pages.
  function formatVenue(f) {
    const text = name => latexToText(f[name] || '');
    const pages = formatPages(text('pages'));
    let parts;
    if (f.shortvenue) {
      parts = [text('shortvenue'), pages];
    } else if (isArxiv(f)) {
      parts = ['arXiv:' + text('eprint')];
    } else if (f.journal) {
      const volume = f.volume ? text('volume') + (f.number ? `(${text('number')})` : '') : '';
      parts = [text('journal'), volume, pages];
    } else {
      parts = [text('booktitle') || text('howpublished') || text('school') || text('institution') || text('publisher'), pages];
    }
    return parts.filter(Boolean).join(', ');
  }

  function formatPages(pages) {
    const range = /^(\S+?)\s*[-–]+\s*(\S+)$/.exec(pages);
    if (range) return `pp. ${range[1]}–${range[2]}`;
    return /^\d+$/.test(pages) ? 'p. ' + pages : pages; // otherwise an article number such as "exag033"
  }

  function entryLinks(f) {
    const links = [];
    const add = (label, href) => {
      href = href.replace(/\\([_%#&~])/g, '$1').trim();
      if (/^https?:\/\//i.test(href) && !links.some(link => sameUrl(link[1], href))) links.push([label, href]);
    };
    if (f.doi) add('doi', 'https://doi.org/' + f.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''));
    if (isArxiv(f)) add('arXiv', 'https://arxiv.org/abs/' + f.eprint);
    if (f.url) add(/arxiv\.org/i.test(f.url) ? 'arXiv' : 'paper', f.url);
    return links;
  }

  function sameUrl(a, b) {
    const normalize = url => url.toLowerCase().replace(/^https?:\/\/(www\.|dx\.)?/, '').replace(/\/+$/, '');
    return normalize(a) === normalize(b);
  }

  function isArxiv(f) {
    return Boolean(f.eprint) && /^arxiv$/i.test(f.eprinttype || f.archiveprefix || '');
  }

  function withPeriod(text) {
    return /[.?!]$/.test(text) ? text : text + '.';
  }

  function el(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    node.append(...children);
    return node;
  }

  // ---------------------------------------------------------------- BibTeX output

  function bibHref(entries) {
    return 'data:text/plain;charset=utf-8,' + encodeURIComponent(entries.map(toBibTeX).join('\n'));
  }

  function toBibTeX(entry) {
    const fields = entry.fieldList.filter(field => !SITE_ONLY_FIELDS.includes(field.name.toLowerCase()));
    const width = Math.max(12, ...fields.map(field => field.name.length));
    const indent = ' '.repeat(width + 6); // aligns continuation lines after "  name = {"
    const lines = fields.map(field => `  ${field.name.padEnd(width)} = ${field.raw.replace(/\s*\n\s*/g, '\n' + indent)}`);
    return `@${entry.type}{${entry.key},\n${lines.join(',\n')}\n}\n`;
  }

  // ---------------------------------------------------------------- BibTeX parsing

  // Returns [{type, key, fieldList: [{name, raw}], fields: {lowercase name: text}}],
  // where raw is the value as written and text is its content without the outer delimiters.
  function parseBibTeX(source) {
    const entries = [];
    const entryStart = /@\s*([A-Za-z]+)\s*([{(])/g;
    let match;
    while ((match = entryStart.exec(source))) {
      const [, type, open] = match;
      const close = open === '{' ? '}' : ')';
      try {
        if (/^(comment|preamble|string)$/i.test(type)) {
          entryStart.lastIndex = findClosing(source, entryStart.lastIndex - 1, close) + 1;
        } else {
          const { entry, end } = parseEntry(source, entryStart.lastIndex, type, close);
          entries.push(entry);
          entryStart.lastIndex = end;
        }
      } catch (error) {
        console.warn(`${BIB_FILE}: skipped the entry at character ${match.index}: ${error.message}`);
      }
    }
    return entries;
  }

  function parseEntry(source, pos, type, close) {
    const comma = source.indexOf(',', pos);
    const key = comma < 0 ? '' : source.slice(pos, comma).trim();
    if (!key || /[\s{}()"]/.test(key)) throw new Error('missing or invalid citation key');

    const entry = { type, key, fieldList: [], fields: {} };
    const fieldName = /([^\s=,{}()"#%]+)\s*=\s*/y;
    pos = comma + 1;
    for (;;) {
      while (/[\s,]/.test(source[pos] || '')) pos++;
      if (pos >= source.length) throw new Error(`${key}: unexpected end of file`);
      if (source[pos] === close) return { entry, end: pos + 1 };

      fieldName.lastIndex = pos;
      const name = fieldName.exec(source);
      if (!name) throw new Error(`${key}: unexpected "${source[pos]}"`);
      const value = readValue(source, fieldName.lastIndex);
      entry.fieldList.push({ name: name[1], raw: value.raw });
      entry.fields[name[1].toLowerCase()] = value.text;
      pos = value.end;
    }
  }

  // Reads {braced}, "quoted" and bare values, including concatenations with #.
  function readValue(source, pos) {
    const start = pos;
    let text = '';
    for (;;) {
      if (source[pos] === '{' || source[pos] === '"') {
        const end = findClosing(source, pos, source[pos] === '{' ? '}' : '"');
        text += source.slice(pos + 1, end);
        pos = end + 1;
      } else {
        const bare = /[^\s,#{}"()]+/y;
        bare.lastIndex = pos;
        const token = bare.exec(source);
        if (!token) throw new Error('missing field value');
        text += token[0];
        pos += token[0].length;
      }
      let next = pos;
      while (/\s/.test(source[next] || '')) next++;
      if (source[next] !== '#') return { raw: source.slice(start, pos), text, end: pos };
      pos = next + 1;
      while (/\s/.test(source[pos] || '')) pos++;
    }
  }

  // Index of the delimiter closing the group that opens at pos, skipping nested braces.
  function findClosing(source, pos, closer) {
    let depth = 0;
    for (let i = pos + 1; i < source.length; i++) {
      const c = source[i];
      if (c === closer && depth === 0) return i;
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    throw new Error('unbalanced braces or quotes');
  }

  // Splits at separators (a sticky regex) that are not inside braces.
  function splitTopLevel(text, separator) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      else if (depth === 0) {
        separator.lastIndex = i;
        const match = separator.exec(text);
        if (match) {
          parts.push(text.slice(start, i));
          start = i + match[0].length;
          i = start - 1;
        }
      }
    }
    parts.push(text.slice(start));
    return parts.map(part => part.trim()).filter(Boolean);
  }

  // ---------------------------------------------------------------- LaTeX to text

  const ACCENTS = {
    '`': '̀', "'": '́', '^': '̂', '~': '̃', '=': '̄', '.': '̇', '"': '̈',
    u: '̆', r: '̊', H: '̋', v: '̌', c: '̧', k: '̨',
  };
  const SYMBOLS = {
    ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
  };

  function latexToText(text) {
    return text
      // Accents: \"{u}, \"u, \'{\i}, \v{c}, \c c
      .replace(/\\(?:([`'^~=."])|([urHvck])(?=[\s{]))\s*(?:\{\s*(\\?[A-Za-z])\s*\}|(\\?[A-Za-z]))/g,
        (_, symbol, letter, braced, bare) => ((braced || bare).replace('\\', '') + ACCENTS[symbol || letter]).normalize('NFC'))
      .replace(/\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i|j)(?![A-Za-z])\s*/g, (_, name) => SYMBOLS[name])
      .replace(/(?<!\\)\$/g, '')
      .replace(/\^\{?(\d)\}?/g, (_, digit) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[digit])
      .replace(/\\([&%$#_])/g, '$1')
      .replace(/\\[A-Za-z]+\s*/g, '') // other commands, e.g. \emph{...} keeps its argument
      .replace(/---/g, '—')
      .replace(/--/g, '–')
      .replace(/``/g, '“')
      .replace(/''/g, '”')
      .replace(/(?<!\\)~/g, ' ')
      .replace(/[{}]/g, '')
      .replace(/[ \t\r\n]+/g, ' ')
      .trim();
  }
})();
