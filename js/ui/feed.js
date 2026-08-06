// The Arbiter's Log: newest entries on top, older ones dim into the
// archive. Two voices — MottyBot (deadpan) and THE ARBITER (stern, and
// only ever stern at you).

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export class Feed {
  constructor(listEl) {
    this.listEl = listEl;
  }

  #add(cls, html) {
    const li = document.createElement('li');
    li.className = `feed__item feed__item--new ${cls}`;
    li.innerHTML =
      `<span class="feed__time">${stamp()}</span>` +
      `<span class="feed__text">${html}</span>`;
    this.listEl.prepend(li);
    const items = [...this.listEl.children];
    items.forEach((el, i) => el.classList.toggle('feed__item--old', i >= 3));
    while (this.listEl.children.length > 30) this.listEl.lastChild.remove();
    setTimeout(() => li.classList.remove('feed__item--new'), 300);
  }

  bot(text) {
    if (text) this.#add('feed__item--bot', `<strong>MottyBot</strong> — ${escapeHTML(text)}`);
  }

  arbiter(text) {
    if (text) this.#add('feed__item--arbiter', `<strong>Arbiter</strong> — ${escapeHTML(text)}`);
  }

  system(text) {
    if (text) this.#add('feed__item--system', escapeHTML(text));
  }
}

const escapeHTML = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
